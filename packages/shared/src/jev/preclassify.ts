/**
 * Jev pre-classification: before the agent chain runs, ask Jev (one request,
 * all questions in parallel) the typed decisions the research planner and the
 * downstream agents otherwise make inside their multi-turn loops:
 *
 *   risk_score · flag_worthy · pr_type (→ skip_flagging) · flag_type ·
 *   flag_action · feature_novelty · metric_backing · release_method ·
 *   one yes/no per existing app-project metric ("could this change move it?")
 *
 * Modes (auto-factory-jev-mode flag; the layer is off without TYPESAFE_API_KEY):
 *  - shadow  — ask, log, compare against what the agents decided at the end of
 *              the walk, emit an LD event. Agents never see the answers.
 *  - prefill — shadow + the confident answers go into the entry node's prompt
 *              as evidence to confirm or overturn. Tags are NOT seeded: the
 *              approval gate and edge routing still read the agents' own tags.
 *
 * Every failure degrades to "no pre-classification" — Jev never fails a run.
 */

import { execFileSync } from "node:child_process";
import type { LDClient, LDContext } from "@launchdarkly/node-server-sdk";
import type { LDAIClient, LDAICompletionConfig, LDAIConfigTracker } from "@launchdarkly/server-sdk-ai";
import { type JevAnswer, type JevQuestion, askJev, jevApiKey, jevConfidence } from "./client.js";

export type JevMode = "off" | "shadow" | "prefill";
export const JEV_MODE_FLAG_KEY = "auto-factory-jev-mode";
/** LD custom event carrying each run's pre-classification + agreement with the agents. */
export const JEV_EVENT_KEY = "autofactory-jev-preclassification";
/**
 * Numeric LD event: the fraction of compared decisions where Jev matched the
 * agents, carrying the AI Config's track data (configKey, variationKey,
 * version) — back a metric with it to A/B question wording per variation.
 */
export const JEV_AGREEMENT_EVENT_KEY = "autofactory-jev-agreement";
/** Answers below this confidence are not surfaced to agents in prefill mode. */
export const JEV_PREFILL_MIN_CONFIDENCE = 0.7;

/**
 * Cap the diff so state + the longest question stay under Jev's 32k-token
 * limit. Code tokenizes densely: an 80k-char cap measured 33k input tokens live.
 */
const MAX_DIFF_CHARS = 60_000;
const MAX_BODY_CHARS = 4_000;
/** Each metric question costs tokens against the 64k all-questions budget. */
const MAX_METRIC_QUESTIONS = 60;

const SKIP_PR_TYPES = new Set(["config_change", "dependency_update", "infrastructure", "test_only", "documentation"]);

/**
 * The layer's mode for this run: off without a key; otherwise the flag's value,
 * defaulting to shadow (so a key alone turns on logging, never behavior).
 */
export async function resolveJevMode(ldClient: LDClient, context: LDContext): Promise<JevMode> {
  if (!jevApiKey()) return "off";
  const v = await ldClient.variation(JEV_MODE_FLAG_KEY, context, "shadow");
  return v === "off" || v === "prefill" ? v : "shadow";
}

// ── Evidence ──────────────────────────────────────────────────────────────

export interface ChangeEvidence {
  diff: string;
  changedFiles: string[];
  truncated: boolean;
}

/**
 * The change under review: merge-base(base, HEAD) → HEAD (a PR checkout), or →
 * the working tree incl. uncommitted edits (`workingTree`, the CLI). Lockfiles
 * are excluded — noise that would crowd the diff out of the token budget.
 * Undefined when no base resolves.
 */
export function collectChangeEvidence(
  root: string,
  opts: { baseRef?: string; workingTree?: boolean } = {},
): ChangeEvidence | undefined {
  const git = (args: string[]): string =>
    execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  const name = opts.baseRef || process.env.PR_BASE_REF || "main";
  for (const ref of [`origin/${name}`, name, "origin/main", "main"]) {
    let mergeBase: string;
    try {
      mergeBase = git(["merge-base", ref, "HEAD"]).trim();
    } catch {
      continue;
    }
    const exclude = [":(exclude)package-lock.json", ":(exclude)yarn.lock", ":(exclude)pnpm-lock.yaml"];
    const range = opts.workingTree ? [mergeBase] : [mergeBase, "HEAD"];
    const changedFiles = git(["diff", "--name-only", ...range]).split("\n").map((l) => l.trim()).filter(Boolean);
    if (opts.workingTree) {
      for (const f of git(["ls-files", "--others", "--exclude-standard"]).split("\n")) if (f.trim()) changedFiles.push(f.trim());
    }
    const full = git(["diff", ...range, "--", ".", ...exclude]);
    const truncated = full.length > MAX_DIFF_CHARS;
    return { diff: truncated ? `${full.slice(0, MAX_DIFF_CHARS)}\n…[diff truncated]` : full, changedFiles, truncated };
  }
  return undefined;
}

// ── Questions ─────────────────────────────────────────────────────────────

export interface CandidateMetric {
  key: string;
  name?: string;
  kind?: string;
}

/** Risk rubric levels → the planner's 0..1 risk_score anchors. */
const RISK_LEVELS = [
  "Trivial: docs, tests, comments, or formatting only; no runtime behavior change",
  "Low: small additive, isolated change (new endpoint, copy change) with a narrow blast radius",
  "Moderate: modified business logic or shared code with a moderate blast radius",
  "High: cross-cutting change, API contract change, or data migration",
  "Critical: touches auth, payments, pricing/totals, or data integrity",
];
const RISK_SCORE_AT_LEVEL = [0.1, 0.25, 0.5, 0.75, 0.9];

/** Question name for a metric key (names stay [a-z0-9_]). */
function metricQuestionName(key: string, i: number): string {
  return `metric_${i}_${key.toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 40)}`;
}

/**
 * The fixed question set — the code-side fallback. The live set comes from the
 * `autofactory-jev-preclassifier` AI Config (variation `model.custom.questions`,
 * see resolveJevConfig) so wording can be edited and A/B-tested in LaunchDarkly.
 * The NAMES are the contract: interpretation and the shadow comparison read
 * answers by these keys, so a variation may reword or drop questions but must
 * keep the names. tests/jev.test.ts pins the committed config to this set.
 */
export const DEFAULT_JEV_QUESTIONS: Record<string, JevQuestion> = {
  risk: {
    type: "score",
    instructions:
      "How risky is this change to ship? Score the blast radius of the behavior change, not the line count. " +
      "Any change to what a customer is charged or shown as a price is at least Moderate.",
    criteria: RISK_LEVELS,
  },
  // Mechanical, not a judgment call: "can this be gated and isn't yet", never
  // "is gating worthwhile" — that takes business context Jev doesn't have. The
  // pipeline's policy is to flag nearly everything that can be flagged.
  flag_worthy: {
    type: "noul",
    instructions:
      "Can the behavior this change introduces or modifies be gated at runtime with a LaunchDarkly feature flag, where it is not already gated? " +
      "Do not judge whether gating is worthwhile — only whether it is technically possible and not yet done.",
    criteria: {
      true: "Yes: the change alters code that runs in production (UI, API endpoints, business logic, runtime configuration reads) and no existing flag evaluation already wraps that changed code",
      false: "No: nothing gateable changed (only docs, comments, tests, CI/build files, or dependency manifests), or every changed runtime path is already wrapped by an existing flag evaluation",
    },
  },
  pr_type: {
    type: "choice",
    instructions: "What kind of change is this?",
    criteria: {
      feature: "Adds new functionality or behavior",
      bugfix: "Fixes incorrect existing behavior",
      refactor: "Restructures code without changing behavior",
      config_change: "Changes configuration values only",
      dependency_update: "Bumps or changes dependencies",
      infrastructure: "Build, CI, deployment, or infrastructure code",
      test_only: "Adds or changes tests only",
      documentation: "Docs or comments only",
    },
  },
  flag_type: {
    type: "choice",
    instructions: "If this change is flagged, which kind of flag fits it?",
    criteria: {
      release: "Temporary flag to roll out new or changed behavior, removed after full release",
      kill_switch: "Permanent off-switch for a risky or expensive subsystem",
      experiment: "A/B test of alternatives measured against a business metric",
      operational: "Long-lived operational control or tuning (limits, timeouts, modes)",
    },
  },
  flag_action: {
    type: "choice",
    instructions:
      "Which flag action fits this change? Decide mechanically from the diff: look for existing flag evaluations around the changed code. " +
      "Do not judge whether a flag is worthwhile.",
    criteria: {
      create: "The change alters runtime behavior and no existing flag evaluation wraps the changed code: create a fresh flag",
      ride_existing: "An existing flag evaluation wraps the changed code and the change iterates on that flagged path",
      extend_variation: "An existing multivariate flag wraps the changed code and the change adds a new alternative to it: add the next variation",
      child_flag: "The change adds new functionality inside or next to code already wrapped by a flag: create a new flag with the existing one as a prerequisite",
      none: "Nothing in the change runs at runtime (only docs, comments, tests, CI/build files, or dependency manifests)",
    },
  },
  feature_novelty: {
    type: "choice",
    instructions: "Is the behavior this change introduces a new path or a change to an existing one?",
    criteria: {
      net_new: "A new path (new endpoint or component) that users without the change never exercise",
      incremental: "A change to an existing path that both old and new behavior exercise",
      mixed: "Some surfaces are new, others are changed existing paths",
    },
  },
  metric_backing: {
    type: "choice",
    instructions: "How should a guardrail metric for this change be measured, given the telemetry visible in the code?",
    criteria: {
      reuse_event: "The code already sends an analytics/track event that measures the affected behavior",
      reuse_traces: "The affected code is already covered by tracing spans that can back a metric",
      ride_o11y: "An observability SDK is installed; enabling its instrumentation covers the behavior without new events",
      instrument_track: "Nothing measures this yet; a new track() event must be added",
    },
  },
  release_method: {
    type: "choice",
    instructions: "How should this change be released once merged?",
    criteria: {
      immediate: "Turn it on for everyone at once; low risk and nothing meaningful to measure",
      progressive: "Ramp it up in stages over time without metric-based automatic rollback",
      guarded: "Ramp it up while monitoring metrics, rolling back automatically on a regression",
    },
  },
};

/** The base questions plus one yes/no per candidate metric (metric questions are always code-generated). */
export function buildPreclassifyQuestions(
  metrics: CandidateMetric[] = [],
  base: Record<string, JevQuestion> = DEFAULT_JEV_QUESTIONS,
): {
  questions: Record<string, JevQuestion>;
  metricByQuestion: Map<string, string>;
} {
  const questions: Record<string, JevQuestion> = { ...base };
  const metricByQuestion = new Map<string, string>();
  metrics.slice(0, MAX_METRIC_QUESTIONS).forEach((m, i) => {
    const name = metricQuestionName(m.key, i);
    metricByQuestion.set(name, m.key);
    questions[name] = {
      type: "noul",
      instructions:
        `Could this change plausibly move the metric "${m.name ?? m.key}" (key ${m.key}${m.kind ? `, ${m.kind}` : ""})? ` +
        "Yes only if the change touches code that emits or affects what this metric measures.",
      criteria: {
        true: "The change affects the behavior or code path this metric measures",
        false: "The change is unrelated to this metric",
      },
    };
  });
  return { questions, metricByQuestion };
}

/**
 * App-project metrics worth asking about. AI-config metrics (`$ld:ai:*` and the
 * autogenerated `ld_autogen__ai-*`) never guard an app flag — and asked about a
 * workflow change they drew ~0.45 "maybe" answers live, pure noise.
 */
export function candidateMetrics(metrics: CandidateMetric[]): CandidateMetric[] {
  return metrics.filter((m) => !m.key.startsWith("$ld:ai:") && !m.key.startsWith("ld_autogen__ai-"));
}

// ── Interpretation ────────────────────────────────────────────────────────

export interface JevDecision {
  value: string;
  confidence: number;
  probabilities?: Record<string, number>;
}

export const JEV_DECISIONS = [
  "risk_score",
  "flag_worthy",
  "pr_type",
  "skip_flagging",
  "flag_type",
  "flag_action",
  "feature_novelty",
  "metric_backing",
  "release_method",
] as const;
export type JevDecisionName = (typeof JEV_DECISIONS)[number];

export interface JevPreclassification {
  model: string;
  latencyMs: number;
  inputTokens?: number;
  diffTruncated: boolean;
  decisions: Partial<Record<JevDecisionName, JevDecision>>;
  /** P(change moves the metric), per asked metric, highest first. */
  metrics: Array<{ key: string; probability: number }>;
}

function choiceDecision(a: JevAnswer | undefined): JevDecision | undefined {
  if (!a || a.type !== "choice") return undefined;
  return { value: a.choice, confidence: a.confidence, probabilities: a.probabilities };
}

/**
 * Expected risk level (fractional) → the 0..1 risk_score scale, linearly
 * interpolated over the planner's anchors. A config-supplied rubric with a
 * different number of levels maps linearly onto 0.1..0.9.
 */
export function riskScoreFromLevel(level: number, levels = RISK_SCORE_AT_LEVEL.length): number {
  if (levels !== RISK_SCORE_AT_LEVEL.length) {
    const max = Math.max(levels - 1, 1);
    return 0.1 + (0.8 * Math.min(Math.max(level, 0), max)) / max;
  }
  const max = RISK_SCORE_AT_LEVEL.length - 1;
  const x = Math.min(Math.max(level, 0), max);
  const lo = Math.floor(x);
  const hi = Math.min(lo + 1, max);
  const a = RISK_SCORE_AT_LEVEL[lo] as number;
  const b = RISK_SCORE_AT_LEVEL[hi] as number;
  return a + (b - a) * (x - lo);
}

export function interpretJevAnswers(
  answers: Record<string, JevAnswer>,
  metricByQuestion: Map<string, string>,
): Pick<JevPreclassification, "decisions" | "metrics"> {
  const decisions: JevPreclassification["decisions"] = {};

  const risk = answers.risk;
  if (risk?.type === "score") {
    const levels = Object.keys(risk.legend ?? {}).length || RISK_SCORE_AT_LEVEL.length;
    decisions.risk_score = { value: riskScoreFromLevel(risk.score, levels).toFixed(2), confidence: risk.confidence };
  }
  const worthy = answers.flag_worthy;
  if (worthy?.type === "noul") {
    decisions.flag_worthy = { value: worthy.noul >= 0.5 ? "true" : "false", confidence: jevConfidence(worthy) };
  }
  for (const name of ["pr_type", "flag_type", "flag_action", "feature_novelty", "metric_backing", "release_method"] as const) {
    const d = choiceDecision(answers[name]);
    if (d) decisions[name] = d;
  }
  // The planner's skip_flagging rule: not flag-worthy AND a non-behavioral PR type.
  if (decisions.flag_worthy && decisions.pr_type) {
    const skip = decisions.flag_worthy.value === "false" && SKIP_PR_TYPES.has(decisions.pr_type.value);
    decisions.skip_flagging = {
      value: skip ? "true" : "false",
      confidence: Math.min(decisions.flag_worthy.confidence, decisions.pr_type.confidence),
    };
  }

  const metrics: JevPreclassification["metrics"] = [];
  for (const [q, key] of metricByQuestion) {
    const a = answers[q];
    if (a?.type === "noul") metrics.push({ key, probability: a.noul });
  }
  metrics.sort((a, b) => b.probability - a.probability);
  return { decisions, metrics };
}

// ── LaunchDarkly AI Config ────────────────────────────────────────────────

/**
 * The AI Config that carries the question set. Completion mode; each variation
 * points at the TypeSafe custom model config and holds its questions in
 * `model.custom.questions` (same shape as DEFAULT_JEV_QUESTIONS) and the prefill
 * bar in `model.parameters.minPrefillConfidence`. The messages are unused (Jev
 * has no chat turns; its input is the diff) and only document the config.
 */
export const JEV_AI_CONFIG_KEY = "autofactory-jev-preclassifier";

export interface JevRuntimeConfig {
  /** Where the questions came from — the AI Config variation, or the code fallback. */
  source: "ai-config" | "code";
  questions: Record<string, JevQuestion>;
  model?: string;
  minPrefillConfidence: number;
  /** Variation key, when source is ai-config. */
  variation?: string;
  tracker?: LDAIConfigTracker;
}

/** Structural check of config-supplied questions (the API limits are checked by askJev). */
function isJevQuestion(q: unknown): q is JevQuestion {
  if (!q || typeof q !== "object") return false;
  const { type, instructions, criteria } = q as Record<string, unknown>;
  if (typeof instructions !== "string" || !criteria || typeof criteria !== "object") return false;
  if (type === "score") return Array.isArray(criteria) && criteria.every((c) => typeof c === "string");
  if (type === "noul") {
    const c = criteria as Record<string, unknown>;
    return typeof c.true === "string" && typeof c.false === "string";
  }
  return type === "choice" && !Array.isArray(criteria);
}

/**
 * Resolve the question set from the AI Config. Falls back to the code defaults
 * (with a log line) when the config is missing, disabled, or malformed — the
 * layer must keep working on projects that haven't run `bridge upgrade`.
 */
export async function resolveJevConfig(
  aiClient: LDAIClient,
  context: LDContext,
  variables?: Record<string, unknown>,
): Promise<JevRuntimeConfig> {
  const fallback: JevRuntimeConfig = {
    source: "code",
    questions: DEFAULT_JEV_QUESTIONS,
    minPrefillConfidence: JEV_PREFILL_MIN_CONFIDENCE,
  };
  let cfg: LDAICompletionConfig;
  try {
    cfg = await aiClient.completionConfig(JEV_AI_CONFIG_KEY, context, { enabled: false }, variables);
  } catch (e) {
    console.warn(`[jev] AI Config '${JEV_AI_CONFIG_KEY}' evaluation failed — using built-in questions: ${e instanceof Error ? e.message : e}`);
    return fallback;
  }
  if (!cfg.enabled) {
    console.log(`[jev] AI Config '${JEV_AI_CONFIG_KEY}' not found or disabled — using built-in questions.`);
    return fallback;
  }
  const tracker = cfg.createTracker?.();
  const raw = cfg.model?.custom?.questions;
  const entries = raw && typeof raw === "object" ? Object.entries(raw as Record<string, unknown>) : [];
  const invalid = entries.filter(([, q]) => !isJevQuestion(q)).map(([k]) => k);
  if (entries.length === 0 || invalid.length > 0) {
    console.warn(
      `[jev] AI Config '${JEV_AI_CONFIG_KEY}' has ${entries.length === 0 ? "no model.custom.questions" : `malformed question(s): ${invalid.join(", ")}`} — using built-in questions.`,
    );
    return { ...fallback, ...(tracker ? { tracker } : {}) };
  }
  const min = Number(cfg.model?.parameters?.minPrefillConfidence);
  const variation = tracker?.getTrackData().variationKey;
  return {
    source: "ai-config",
    questions: Object.fromEntries(entries) as Record<string, JevQuestion>,
    ...(cfg.model?.name ? { model: cfg.model.name } : {}),
    minPrefillConfidence: Number.isFinite(min) && min > 0 && min <= 1 ? min : JEV_PREFILL_MIN_CONFIDENCE,
    ...(variation ? { variation } : {}),
    ...(tracker ? { tracker } : {}),
  };
}

// ── Run ───────────────────────────────────────────────────────────────────

export interface PreclassifyInput {
  apiKey?: string;
  root: string;
  baseRef?: string;
  workingTree?: boolean;
  title?: string;
  body?: string;
  metrics?: CandidateMetric[];
  /** Base question set (the AI Config's); defaults to DEFAULT_JEV_QUESTIONS. */
  questions?: Record<string, JevQuestion>;
  /** Jev model id (the AI Config's model name); defaults to jev-latest. */
  model?: string;
  /** AI Config tracker: duration, tokens, success/error land on the variation. */
  tracker?: LDAIConfigTracker;
  /** Test seam. */
  fetchImpl?: typeof fetch;
}

/** One Jev request for the whole change. Undefined (with a log line) on any failure. */
export async function runJevPreclassification(input: PreclassifyInput): Promise<JevPreclassification | undefined> {
  const apiKey = input.apiKey ?? jevApiKey();
  if (!apiKey) return undefined;
  try {
    const evidence = collectChangeEvidence(input.root, {
      ...(input.baseRef ? { baseRef: input.baseRef } : {}),
      ...(input.workingTree ? { workingTree: true } : {}),
    });
    if (!evidence || (!evidence.diff.trim() && evidence.changedFiles.length === 0)) {
      console.log("[jev] no diff against the base — pre-classification skipped");
      return undefined;
    }
    const { questions, metricByQuestion } = buildPreclassifyQuestions(candidateMetrics(input.metrics ?? []), input.questions);
    const state = {
      title: input.title ?? "",
      description: (input.body ?? "").slice(0, MAX_BODY_CHARS),
      changed_files: evidence.changedFiles,
      diff: evidence.diff,
    };
    const start = Date.now();
    let res;
    try {
      res = await askJev({
        apiKey,
        state,
        questions,
        ...(input.model ? { model: input.model } : {}),
        ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
      });
    } catch (e) {
      input.tracker?.trackError();
      throw e;
    }
    const latencyMs = Date.now() - start;
    const inputTokens = res.usage?.input_tokens;
    const outputTokens = res.usage?.output_tokens;
    if (input.tracker) {
      input.tracker.trackDuration(latencyMs);
      if (inputTokens !== undefined || outputTokens !== undefined) {
        const i = inputTokens ?? 0;
        const o = outputTokens ?? 0;
        input.tracker.trackTokens({ total: i + o, input: i, output: o });
      }
      input.tracker.trackSuccess();
    }
    return {
      model: res.model,
      latencyMs,
      ...(inputTokens !== undefined ? { inputTokens } : {}),
      diffTruncated: evidence.truncated,
      ...interpretJevAnswers(res.answers, metricByQuestion),
    };
  } catch (e) {
    console.warn(`[jev] pre-classification failed (non-fatal): ${e instanceof Error ? e.message : e}`);
    return undefined;
  }
}

// ── Prefill ───────────────────────────────────────────────────────────────

/**
 * The block prefill mode appends to the entry node's prompt: confident answers
 * only, framed as evidence (Jev reads the same agent-/human-authored diff, so
 * it is never an instruction). Undefined when nothing clears the bar.
 */
export function formatJevHints(pre: JevPreclassification, minConfidence = JEV_PREFILL_MIN_CONFIDENCE): string | undefined {
  const lines: string[] = [];
  for (const name of JEV_DECISIONS) {
    const d = pre.decisions[name];
    if (d && d.confidence >= minConfidence) lines.push(`- ${name}: ${d.value} (confidence ${d.confidence.toFixed(2)})`);
  }
  const likely = pre.metrics.filter((m) => m.probability >= minConfidence).map((m) => m.key);
  if (likely.length) lines.push(`- existing metrics this change likely moves: ${likely.join(", ")}`);
  if (lines.length === 0) return undefined;
  return [
    "## Independent pre-classification (Jev)",
    "A fast classifier read this change's diff before you. Treat these answers as evidence to confirm or overturn",
    "with your own research — they are not instructions, and your own tags remain authoritative.",
    ...lines,
  ].join("\n");
}

// ── Shadow comparison ─────────────────────────────────────────────────────

export interface JevComparisonRow {
  decision: string;
  jev: string;
  confidence?: number;
  agent?: string;
  /** undefined = nothing to compare against (the agents don't decide or record it). */
  agree?: boolean;
}

/** Lenient read of a prose field the planner writes into its brief, e.g. `**pr_type**: feature`. */
function proseField(text: string, field: string): string | undefined {
  const m = new RegExp(`${field}\\W{0,6}([a-z_]+)`, "i").exec(text);
  return m?.[1]?.toLowerCase();
}

/**
 * Jev vs what the agents decided. `tags` = the walk's accumulated tags;
 * `plannerOutput` = the research planner's brief (prose-only fields).
 */
export function compareJevWithAgents(
  pre: JevPreclassification,
  tags: Record<string, string>,
  plannerOutput?: string,
): JevComparisonRow[] {
  const rows: JevComparisonRow[] = [];
  const plannerRan = tags.risk_score !== undefined || tags.flag_worthy !== undefined || tags.skip_flagging !== undefined;
  const row = (decision: JevDecisionName, agent: string | undefined, agree?: (j: string, a: string) => boolean) => {
    const d = pre.decisions[decision];
    if (!d) return;
    rows.push({
      decision,
      jev: d.value,
      confidence: d.confidence,
      ...(agent !== undefined ? { agent, agree: (agree ?? ((j, a) => j === a))(d.value, agent) } : {}),
    });
  };

  row("risk_score", tags.risk_score, (j, a) => Number.isFinite(Number(a)) && Math.abs(Number(j) - Number(a)) <= 0.2);
  row("flag_worthy", tags.flag_worthy);
  row("skip_flagging", plannerRan ? (tags.skip_flagging === "true" ? "true" : "false") : undefined);
  row("flag_action", tags.flag_action);
  row("pr_type", plannerOutput ? proseField(plannerOutput, "pr_type") : undefined);
  row("feature_novelty", plannerOutput ? proseField(plannerOutput, "feature_novelty") : undefined);
  row("flag_type", undefined); // not decided today: every created flag is a temporary release flag
  row("metric_backing", undefined); // prose inside the metrics author's loop; not recorded
  // Beacon's rule when no releaseMethod is set: metrics → guarded, else progressive.
  row(
    "release_method",
    tags.flag_key ? ((tags.metric_keys ?? "").trim() ? "guarded" : "progressive") : undefined,
  );

  const asked = new Set(pre.metrics.map((m) => m.key));
  if (asked.size > 0 && tags.metric_keys !== undefined) {
    const agentKeys = tags.metric_keys.split(",").map((k) => k.trim()).filter((k) => asked.has(k));
    const jevKeys = pre.metrics.filter((m) => m.probability >= 0.5).map((m) => m.key);
    const same = agentKeys.length === jevKeys.length && agentKeys.every((k) => jevKeys.includes(k));
    rows.push({
      decision: "existing_metrics",
      jev: jevKeys.join(", ") || "(none)",
      agent: agentKeys.join(", ") || "(none)",
      agree: same,
    });
  }
  return rows;
}

/** Markdown table for the PR comment / CLI summary. */
export function formatJevComparison(pre: JevPreclassification, rows: JevComparisonRow[], mode: JevMode): string {
  const mark = (r: JevComparisonRow) => (r.agree === undefined ? "—" : r.agree ? "✓" : "✗");
  const compared = rows.filter((r) => r.agree !== undefined);
  const agreed = compared.filter((r) => r.agree).length;
  return [
    `**Jev pre-classification** (${mode}, ${pre.model}, ${pre.latencyMs}ms${pre.inputTokens ? `, ${pre.inputTokens} input tokens` : ""}` +
      `${pre.diffTruncated ? ", diff truncated" : ""}): agrees with the agents on ${agreed}/${compared.length} compared decisions`,
    "",
    "| Decision | Jev | Confidence | Agents | Match |",
    "|---|---|---|---|---|",
    ...rows.map(
      (r) =>
        `| ${r.decision} | ${r.jev} | ${r.confidence !== undefined ? r.confidence.toFixed(2) : "—"} | ${r.agent ?? "—"} | ${mark(r)} |`,
    ),
  ].join("\n");
}

/** Payload for the JEV_EVENT_KEY custom event (flat enough to query later). */
export function jevEventData(pre: JevPreclassification, rows: JevComparisonRow[], mode: JevMode): Record<string, unknown> {
  return {
    mode,
    model: pre.model,
    latencyMs: pre.latencyMs,
    inputTokens: pre.inputTokens ?? null,
    diffTruncated: pre.diffTruncated,
    decisions: rows.map((r) => ({
      decision: r.decision,
      jev: r.jev,
      confidence: r.confidence ?? null,
      agent: r.agent ?? null,
      agree: r.agree ?? null,
    })),
    metrics: pre.metrics.slice(0, 20),
  };
}

// ── Front-end plumbing (shared by the CLI and the GitHub Action) ──────────

export interface JevLayer {
  mode: JevMode;
  pre?: JevPreclassification;
  config?: JevRuntimeConfig;
}

/**
 * Before the walk: resolve the mode, pre-classify, and (prefill) set
 * `context.PRECLASSIFICATION` for the entry node's prompt. Never throws.
 */
export async function startJevLayer(opts: {
  ldClient: LDClient;
  ldContext: LDContext;
  /** Resolves the question set from the AI Config; without it the built-in questions are used. */
  aiClient?: LDAIClient;
  /** AI Config instruction variables (same map the agent configs get). */
  variables?: Record<string, unknown>;
  context: Record<string, unknown>;
  root: string;
  baseRef?: string;
  workingTree?: boolean;
  /** Existing app-project metrics to ask about (e.g. LdResourceWriter.listMetrics). */
  listMetrics?: () => Promise<CandidateMetric[]>;
}): Promise<JevLayer> {
  let mode: JevMode = "off";
  try {
    mode = await resolveJevMode(opts.ldClient, opts.ldContext);
  } catch (e) {
    console.warn(`[jev] mode flag evaluation failed (non-fatal): ${e instanceof Error ? e.message : e}`);
  }
  if (mode === "off") {
    console.log(`Jev pre-classification: off${jevApiKey() ? ` (${JEV_MODE_FLAG_KEY})` : " (no TYPESAFE_API_KEY)"}.`);
    return { mode };
  }
  let metrics: CandidateMetric[] = [];
  if (opts.listMetrics) {
    try {
      metrics = await opts.listMetrics();
    } catch (e) {
      console.warn(`[jev] could not list app-project metrics (non-fatal): ${e instanceof Error ? e.message : e}`);
    }
  }
  const config: JevRuntimeConfig = opts.aiClient
    ? await resolveJevConfig(opts.aiClient, opts.ldContext, opts.variables)
    : { source: "code", questions: DEFAULT_JEV_QUESTIONS, minPrefillConfidence: JEV_PREFILL_MIN_CONFIDENCE };
  const pre = await runJevPreclassification({
    root: opts.root,
    questions: config.questions,
    ...(config.model ? { model: config.model } : {}),
    ...(config.tracker ? { tracker: config.tracker } : {}),
    ...(opts.baseRef ? { baseRef: opts.baseRef } : {}),
    ...(opts.workingTree ? { workingTree: true } : {}),
    ...(typeof opts.context.PR_TITLE === "string" ? { title: opts.context.PR_TITLE } : {}),
    ...(typeof opts.context.PR_BODY === "string" ? { body: opts.context.PR_BODY } : {}),
    metrics,
  });
  if (!pre) return { mode, config };
  const summary = JEV_DECISIONS.map((n) => pre.decisions[n])
    .map((d, i) => (d ? `${JEV_DECISIONS[i]}=${d.value}@${d.confidence.toFixed(2)}` : ""))
    .filter(Boolean)
    .join(" ");
  const from = config.source === "ai-config" ? `${JEV_AI_CONFIG_KEY}/${config.variation ?? "?"}` : "built-in questions";
  console.log(`Jev pre-classification: ${mode} — ${pre.latencyMs}ms, ${pre.model}, ${from}: ${summary}`);
  if (mode === "prefill") {
    const hints = formatJevHints(pre, config.minPrefillConfidence);
    if (hints) opts.context.PRECLASSIFICATION = hints;
    console.log(`Jev prefill: ${hints ? "confident answers added to the entry node's prompt" : "no answer cleared the confidence bar"}.`);
  }
  return { mode, pre, config };
}

/**
 * After the walk: compare Jev with the agents, emit the LD event, and return
 * the markdown table (undefined when there was no pre-classification). Never throws.
 */
export function finishJevLayer(
  layer: JevLayer,
  opts: {
    ldClient: LDClient;
    ldContext: LDContext;
    tags: Record<string, string>;
    runs: Array<{ tags: Record<string, string>; output: string }>;
  },
): string | undefined {
  if (!layer.pre) return undefined;
  try {
    // The research planner is the node that emits the risk / flag-worthiness tags.
    const planner = opts.runs.find((r) => r.tags.risk_score !== undefined || r.tags.flag_worthy !== undefined);
    const rows = compareJevWithAgents(layer.pre, opts.tags, planner?.output);
    const trackData = layer.config?.tracker?.getTrackData();
    opts.ldClient.track(JEV_EVENT_KEY, opts.ldContext, {
      ...jevEventData(layer.pre, rows, layer.mode),
      questionSource: layer.config?.source ?? "code",
      ...(trackData ? { trackData } : {}),
    });
    const compared = rows.filter((r) => r.agree !== undefined);
    if (compared.length > 0) {
      const agreement = compared.filter((r) => r.agree).length / compared.length;
      opts.ldClient.track(JEV_AGREEMENT_EVENT_KEY, opts.ldContext, trackData ?? { questionSource: "code" }, agreement);
    }
    return formatJevComparison(layer.pre, rows, layer.mode);
  } catch (e) {
    console.warn(`[jev] comparison failed (non-fatal): ${e instanceof Error ? e.message : e}`);
    return undefined;
  }
}
