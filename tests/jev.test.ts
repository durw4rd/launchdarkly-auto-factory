import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { LDAIClient, LDAIConfigTracker } from "@launchdarkly/server-sdk-ai";

import {
  DEFAULT_JEV_QUESTIONS,
  JEV_AI_CONFIG_KEY,
  JEV_PREFILL_MIN_CONFIDENCE,
  type JevAnswer,
  type JevPreclassification,
  askJev,
  buildPreclassifyQuestions,
  candidateMetrics,
  collectChangeEvidence,
  compareJevWithAgents,
  formatJevHints,
  interpretJevAnswers,
  jevConfidence,
  resolveJevConfig,
  riskScoreFromLevel,
  runJevPreclassification,
  validateJevQuestions,
} from "@auto-factory/shared";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** A git repo with `main` plus one feature commit changing checkout math. */
function fixtureRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "jev-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  writeFileSync(join(dir, "pricing.ts"), "export const total = (s: number) => s;\n");
  git("add", ".");
  git("commit", "-qm", "base");
  git("checkout", "-qb", "feature");
  writeFileSync(join(dir, "pricing.ts"), "export const total = (s: number, d: number) => s - d;\n");
  writeFileSync(join(dir, "package-lock.json"), "{}\n");
  git("add", ".");
  git("commit", "-qm", "discount");
  return dir;
}

const answers: Record<string, JevAnswer> = {
  risk: { type: "score", score: 2.5, legend: {}, probabilities: {}, confidence: 0.8 },
  flag_worthy: { type: "noul", noul: 0.9 },
  pr_type: { type: "choice", choice: "feature", probabilities: { feature: 0.9 }, confidence: 0.85 },
  flag_type: { type: "choice", choice: "release", probabilities: {}, confidence: 0.6 },
  flag_action: { type: "choice", choice: "create", probabilities: {}, confidence: 0.75 },
  feature_novelty: { type: "choice", choice: "incremental", probabilities: {}, confidence: 0.7 },
  metric_backing: { type: "choice", choice: "instrument_track", probabilities: {}, confidence: 0.5 },
  release_method: { type: "choice", choice: "guarded", probabilities: {}, confidence: 0.9 },
};

describe("jev client", () => {
  it("rejects questions the API would 422 on", () => {
    assert.throws(() => validateJevQuestions({ q: { type: "choice", instructions: "x", criteria: { only: null } } }));
    assert.throws(() =>
      validateJevQuestions({ q: { type: "score", instructions: "x", criteria: Array.from({ length: 11 }, (_, i) => `${i}`) } }),
    );
  });

  it("retries 429 then succeeds, and does not retry 401", async () => {
    let calls = 0;
    const flaky = (async () => {
      calls++;
      return calls === 1 ? jsonResponse(429, {}) : jsonResponse(200, { model: "jev-1", answers: {} });
    }) as typeof fetch;
    const res = await askJev({ apiKey: "k", state: "s", questions: {}, fetchImpl: flaky, maxRetries: 2 });
    assert.equal(res.model, "jev-1");
    assert.equal(calls, 2);

    calls = 0;
    const denied = (async () => {
      calls++;
      return jsonResponse(401, { error: "bad key" });
    }) as typeof fetch;
    await assert.rejects(askJev({ apiKey: "k", state: "s", questions: {}, fetchImpl: denied, maxRetries: 3 }), /HTTP 401/);
    assert.equal(calls, 1);
  });

  it("yes/no confidence is the probability of the side it landed on", () => {
    assert.equal(jevConfidence({ type: "noul", noul: 0.2 }), 0.8);
    assert.equal(jevConfidence({ type: "noul", noul: 0.9 }), 0.9);
  });
});

describe("jev pre-classification", () => {
  it("maps the risk rubric onto the planner's 0..1 anchors", () => {
    assert.equal(riskScoreFromLevel(0), 0.1);
    assert.equal(riskScoreFromLevel(2), 0.5);
    assert.equal(riskScoreFromLevel(4), 0.9);
    assert.ok(Math.abs(riskScoreFromLevel(2.5) - 0.625) < 1e-9);
    assert.equal(riskScoreFromLevel(9), 0.9);
  });

  it("asks one yes/no per candidate metric and skips AI-config metrics", () => {
    const metrics = candidateMetrics([{ key: "checkout-errors" }, { key: "$ld:ai:tokens:total" }, { key: "ld_autogen__ai-input-tokens" }, { key: "Latency P95" }]);
    const { questions, metricByQuestion } = buildPreclassifyQuestions(metrics);
    assert.deepEqual([...metricByQuestion.values()], ["checkout-errors", "Latency P95"]);
    for (const name of metricByQuestion.keys()) assert.match(name, /^[a-z0-9_]+$/);
    assert.equal(questions.risk?.type, "score");
    validateJevQuestions(questions);
  });

  it("derives skip_flagging from flag_worthy + pr_type", () => {
    const skip = interpretJevAnswers(
      {
        ...answers,
        flag_worthy: { type: "noul", noul: 0.1 },
        pr_type: { type: "choice", choice: "documentation", probabilities: {}, confidence: 0.95 },
      },
      new Map(),
    );
    assert.equal(skip.decisions.skip_flagging?.value, "true");
    assert.equal(skip.decisions.skip_flagging?.confidence, 0.9);
    const keep = interpretJevAnswers(answers, new Map());
    assert.equal(keep.decisions.skip_flagging?.value, "false");
    assert.equal(keep.decisions.risk_score?.value, "0.63");
  });

  it("prefill hints include only confident answers", () => {
    const pre: JevPreclassification = {
      model: "jev-1",
      latencyMs: 1,
      diffTruncated: false,
      ...interpretJevAnswers(
        { ...answers, metric_0_checkout_errors: { type: "noul", noul: 0.92 } },
        new Map([["metric_0_checkout_errors", "checkout-errors"]]),
      ),
    };
    const hints = formatJevHints(pre, 0.7) ?? "";
    assert.match(hints, /flag_action: create/);
    assert.match(hints, /release_method: guarded/);
    assert.doesNotMatch(hints, /flag_type/); // 0.6 < 0.7
    assert.doesNotMatch(hints, /metric_backing/); // 0.5
    assert.match(hints, /likely moves: checkout-errors/);
    assert.equal(formatJevHints(pre, 0.99), undefined);
  });

  it("compares with the agents' tags and the planner's prose", () => {
    const pre: JevPreclassification = {
      model: "jev-1",
      latencyMs: 1,
      diffTruncated: false,
      ...interpretJevAnswers(answers, new Map()),
    };
    const rows = compareJevWithAgents(
      pre,
      { risk_score: "0.55", flag_worthy: "true", flag_action: "ride_existing", flag_key: "f", metric_keys: "m1" },
      "- **pr_type**: bugfix\n- **feature_novelty**: incremental -- because",
    );
    const by = Object.fromEntries(rows.map((r) => [r.decision, r]));
    assert.equal(by.risk_score?.agree, true); // 0.63 vs 0.55
    assert.equal(by.flag_worthy?.agree, true);
    assert.equal(by.skip_flagging?.agree, true);
    assert.equal(by.flag_action?.agree, false);
    assert.equal(by.pr_type?.agent, "bugfix");
    assert.equal(by.pr_type?.agree, false);
    assert.equal(by.feature_novelty?.agree, true);
    assert.equal(by.release_method?.agent, "guarded");
    assert.equal(by.flag_type?.agree, undefined);
  });

  it("collects the PR diff without lockfiles", () => {
    const dir = fixtureRepo();
    const ev = collectChangeEvidence(dir, { baseRef: "main" });
    assert.ok(ev);
    assert.deepEqual(ev.changedFiles.sort(), ["package-lock.json", "pricing.ts"]);
    assert.match(ev.diff, /s - d/);
    assert.doesNotMatch(ev.diff, /package-lock/);
  });

  it("runs end to end against a stubbed API and degrades on failure", async () => {
    const dir = fixtureRepo();
    let sent: { state?: { diff?: string }; questions?: Record<string, unknown> } = {};
    const ok = (async (_url: string | URL | Request, init?: RequestInit) => {
      sent = JSON.parse(String(init?.body));
      return jsonResponse(200, { model: "jev-1.13.0", answers, usage: { input_tokens: 500 } });
    }) as typeof fetch;
    const pre = await runJevPreclassification({ apiKey: "k", root: dir, baseRef: "main", metrics: [], fetchImpl: ok });
    assert.equal(pre?.decisions.flag_action?.value, "create");
    assert.equal(pre?.inputTokens, 500);
    assert.match(sent.state?.diff ?? "", /s - d/);

    const down = (async () => jsonResponse(500, {})) as typeof fetch;
    assert.equal(await runJevPreclassification({ apiKey: "k", root: dir, baseRef: "main", fetchImpl: down }), undefined);
    assert.equal(await runJevPreclassification({ apiKey: "", root: dir }), undefined);
  });
});

/** Stub tracker recording which methods were called. */
function recordingTracker(): { tracker: LDAIConfigTracker; calls: string[] } {
  const calls: string[] = [];
  const tracker = {
    getTrackData: () => ({ variationKey: "v2", configKey: JEV_AI_CONFIG_KEY, version: 3 }),
    trackDuration: () => calls.push("duration"),
    trackTokens: () => calls.push("tokens"),
    trackSuccess: () => calls.push("success"),
    trackError: () => calls.push("error"),
  } as unknown as LDAIConfigTracker;
  return { tracker, calls };
}

function stubAiClient(config: Record<string, unknown>, tracker?: LDAIConfigTracker): LDAIClient {
  return {
    completionConfig: async () => ({ ...config, createTracker: () => tracker }),
  } as unknown as LDAIClient;
}

describe("jev AI Config", () => {
  it("the committed config seeds exactly the built-in question set", () => {
    const cfg = JSON.parse(readFileSync("config/agentcontrol/ai-configs/autofactory-jev-preclassifier.json", "utf8"));
    assert.equal(cfg.key, JEV_AI_CONFIG_KEY);
    assert.equal(cfg.mode, "completion");
    const v = cfg.variations[0];
    assert.equal(v.modelConfigKey, "TypeSafe.jev-latest");
    assert.deepEqual(v.model.custom.questions, DEFAULT_JEV_QUESTIONS);
    assert.equal(v.model.parameters.minPrefillConfidence, JEV_PREFILL_MIN_CONFIDENCE);
    const mc = JSON.parse(readFileSync("config/agentcontrol/model-configs/typesafe-jev-latest.json", "utf8"));
    assert.equal(mc.key, v.modelConfigKey);
  });

  it("uses the variation's questions, model, and prefill bar", async () => {
    const { tracker } = recordingTracker();
    const questions = { risk: DEFAULT_JEV_QUESTIONS.risk };
    const cfg = await resolveJevConfig(
      stubAiClient(
        { enabled: true, model: { name: "jev-1.13.0", parameters: { minPrefillConfidence: 0.8 }, custom: { questions } } },
        tracker,
      ),
      { kind: "user", key: "k" },
    );
    assert.equal(cfg.source, "ai-config");
    assert.equal(cfg.model, "jev-1.13.0");
    assert.equal(cfg.minPrefillConfidence, 0.8);
    assert.equal(cfg.variation, "v2");
    assert.deepEqual(cfg.questions, questions);
  });

  it("falls back to the built-in questions when the config is disabled or malformed", async () => {
    const off = await resolveJevConfig(stubAiClient({ enabled: false }), { kind: "user", key: "k" });
    assert.equal(off.source, "code");
    assert.equal(off.questions, DEFAULT_JEV_QUESTIONS);
    const bad = await resolveJevConfig(
      stubAiClient({ enabled: true, model: { name: "jev-latest", custom: { questions: { risk: { type: "score", criteria: "x" } } } } }),
      { kind: "user", key: "k" },
    );
    assert.equal(bad.source, "code");
  });

  it("maps a non-default rubric size linearly", () => {
    assert.equal(riskScoreFromLevel(0, 3), 0.1);
    assert.ok(Math.abs(riskScoreFromLevel(1, 3) - 0.5) < 1e-9);
    assert.ok(Math.abs(riskScoreFromLevel(2, 3) - 0.9) < 1e-9);
  });

  it("records duration, tokens, and success on the tracker — or error", async () => {
    const dir = fixtureRepo();
    const ok = (async () => jsonResponse(200, { model: "jev-1", answers, usage: { input_tokens: 10, output_tokens: 2 } })) as typeof fetch;
    const good = recordingTracker();
    await runJevPreclassification({ apiKey: "k", root: dir, baseRef: "main", tracker: good.tracker, fetchImpl: ok });
    assert.deepEqual(good.calls, ["duration", "tokens", "success"]);

    const down = (async () => jsonResponse(500, {})) as typeof fetch;
    const bad = recordingTracker();
    await runJevPreclassification({ apiKey: "k", root: dir, baseRef: "main", tracker: bad.tracker, fetchImpl: down });
    assert.deepEqual(bad.calls, ["error"]);
  });
});
