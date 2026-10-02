import { CHECK_NAME } from "../checkRun.js";
import { MARKER } from "../comment.js";
import { APPROVE_LABEL_PREFIX } from "../labels.js";
import type { CodeHost, StatusConclusion } from "./types.js";

/**
 * GitLab: MR notes, commit statuses, MR labels — over the REST API (v4).
 *
 * Auth: CI_JOB_TOKEN can read MRs but cannot create notes, statuses or labels, so
 * writes need AUTOFACTORY_GITLAB_TOKEN (a personal or project access token with
 * `api` scope). Without it, writes log and skip — the run itself still works, and
 * reads that the job token covers (MR description) still go through.
 *
 * Semantics that differ from GitHub:
 * - No `action_required`, and no status can stand in for it: a `pending` commit
 *   status becomes a job in the pipeline it lands in, and nothing ever completes
 *   it — the paused pipeline shows "running" forever (seen live). So a pause posts
 *   no status at all: the job exits PAUSE_EXIT_CODE, which the CI template lists
 *   under `allow_failure: exit_codes` (yellow, "passed with warnings"), and the MR
 *   note says what to do.
 * - A status on this pipeline's own commit attaches to THIS pipeline
 *   (CI_PIPELINE_ID). Unpinned, GitLab picks the newest pipeline for the SHA,
 *   which can be a different run's.
 * - Label changes don't start pipelines: approving is "add the label, then run a
 *   new pipeline". Labels are read from CI_MERGE_REQUEST_LABELS (set when the
 *   pipeline was created), so a re-run picks up labels added since.
 */

export const PAUSE_EXIT_CODE = 78;

/** GitLab commit-status descriptions are capped at 255 characters. */
const MAX_DESCRIPTION = 255;

const STATE: Record<Exclude<StatusConclusion, "action_required">, string> = {
  success: "success",
  failure: "failed",
  neutral: "skipped",
};

export interface GitLabTarget {
  /** e.g. https://gitlab.com/api/v4 (CI_API_V4_URL). */
  apiUrl?: string;
  /** Numeric id or URL-encoded path (CI_PROJECT_ID). */
  projectId?: string;
  /** MR internal id (CI_MERGE_REQUEST_IID). */
  mrIid?: string;
  /** Write token (AUTOFACTORY_GITLAB_TOKEN). */
  token?: string;
  /** Read-only fallback (CI_JOB_TOKEN). */
  jobToken?: string;
}

export function gitLabTargetFromEnv(env: NodeJS.ProcessEnv = process.env): GitLabTarget {
  return {
    apiUrl: env.CI_API_V4_URL,
    projectId: env.CI_PROJECT_ID,
    mrIid: env.CI_MERGE_REQUEST_IID,
    token: env.AUTOFACTORY_GITLAB_TOKEN,
    jobToken: env.CI_JOB_TOKEN,
  };
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

export function createGitLabHost(target: GitLabTarget = gitLabTargetFromEnv()): CodeHost {
  const { apiUrl, projectId, mrIid, token } = target;
  const project = projectId ? `${apiUrl}/projects/${encodeURIComponent(projectId)}` : undefined;
  const mr = project && mrIid ? `${project}/merge_requests/${mrIid}` : undefined;
  const headers = (t: string, isJobToken = false) => ({
    [isJobToken ? "JOB-TOKEN" : "PRIVATE-TOKEN"]: t,
    "Content-Type": "application/json",
  });

  async function findNote(): Promise<number | undefined> {
    if (!mr || !token) return undefined;
    try {
      const res = await fetch(`${mr}/notes?per_page=100&sort=desc`, { headers: headers(token) });
      if (!res.ok) return undefined;
      const notes = (await res.json()) as Array<{ id: number; body?: string }>;
      return notes.find((n) => n.body?.includes(MARKER))?.id;
    } catch {
      return undefined;
    }
  }

  return {
    name: "gitlab",
    changeNoun: "MR",
    pauseExitCode: PAUSE_EXIT_CODE,

    async postComment(body) {
      if (!mr || !token) {
        console.log("(MR note skipped — missing AUTOFACTORY_GITLAB_TOKEN / project / MR iid)");
        return;
      }
      try {
        const existing = await findNote();
        const res = await fetch(existing ? `${mr}/notes/${existing}` : `${mr}/notes`, {
          method: existing ? "PUT" : "POST",
          headers: headers(token),
          body: JSON.stringify({ body: `${MARKER}\n${body}` }),
        });
        console.log(
          res.ok ? (existing ? "Updated MR summary note." : "Posted MR summary note.") : `MR note failed: HTTP ${res.status}`,
        );
      } catch (e) {
        console.warn(`MR note error (non-fatal): ${e instanceof Error ? e.message : e}`);
      }
    },

    async postStatus(opts) {
      if (opts.conclusion === "action_required") {
        console.log(`(commit status '${opts.name ?? CHECK_NAME}' not posted — a pause on GitLab is the job's allowed-failure exit, not a status)`);
        return;
      }
      if (!project || !token || !opts.sha) {
        console.log("(commit status skipped — missing AUTOFACTORY_GITLAB_TOKEN / project / SHA)");
        return;
      }
      const name = opts.name ?? CHECK_NAME;
      try {
        const res = await fetch(`${project}/statuses/${opts.sha}`, {
          method: "POST",
          headers: headers(token),
          body: JSON.stringify({
            state: STATE[opts.conclusion],
            name,
            description: truncate(opts.title, MAX_DESCRIPTION),
            ...(process.env.CI_JOB_URL ? { target_url: process.env.CI_JOB_URL } : {}),
            // Pinned only on the pipeline's own commit: the final verdict lands on the
            // post-chain HEAD (the agents' commits), which has no pipeline of ours.
            ...(process.env.CI_PIPELINE_ID && opts.sha === process.env.CI_COMMIT_SHA
              ? { pipeline_id: Number(process.env.CI_PIPELINE_ID) }
              : {}),
          }),
        });
        console.log(
          res.ok
            ? `Posted commit status '${name}' [${STATE[opts.conclusion]}].`
            : `Commit status failed: HTTP ${res.status}`,
        );
      } catch (e) {
        console.warn(`Commit status error (non-fatal): ${e instanceof Error ? e.message : e}`);
      }
    },

    async approvedSteps() {
      const approved = new Set<string>();
      for (const l of (process.env.CI_MERGE_REQUEST_LABELS ?? "").split(",")) {
        const name = l.trim();
        if (name.startsWith(APPROVE_LABEL_PREFIX)) approved.add(name.slice(APPROVE_LABEL_PREFIX.length));
      }
      return approved;
    },

    async ensureApprovalLabel(label) {
      if (!project || !token) return;
      try {
        // 409 = already exists, which is fine.
        await fetch(`${project}/labels`, {
          method: "POST",
          headers: headers(token),
          body: JSON.stringify({
            name: label,
            color: "#0e8a16",
            description: "AutoFactory: approve this gated step to proceed",
          }),
        });
      } catch {
        /* best-effort */
      }
    },

    async approvalActor() {
      if (!mr || !token) return undefined;
      try {
        const res = await fetch(`${mr}/resource_label_events?per_page=100`, { headers: headers(token) });
        if (!res.ok) return undefined;
        const events = (await res.json()) as Array<{
          action?: string;
          label?: { name?: string };
          user?: { username?: string };
        }>;
        const added = events.filter(
          (e) => e.action === "add" && e.label?.name?.startsWith(APPROVE_LABEL_PREFIX) && e.user?.username,
        );
        return added.at(-1)?.user?.username;
      } catch {
        return undefined;
      }
    },

    approveHint: (label) =>
      `Add the MR label \`${label}\`, then start a new pipeline (MR → Pipelines → Run pipeline) — label changes alone don't trigger one.`,
  };
}

/**
 * The MR description in full. CI_MERGE_REQUEST_DESCRIPTION is truncated at 2700
 * characters; this reads the MR itself, which the job token is allowed to do.
 */
export async function fetchMrDescription(target: GitLabTarget = gitLabTargetFromEnv()): Promise<string | undefined> {
  const { apiUrl, projectId, mrIid } = target;
  const auth: Record<string, string> | undefined = target.token
    ? { "PRIVATE-TOKEN": target.token }
    : target.jobToken
      ? { "JOB-TOKEN": target.jobToken }
      : undefined;
  if (!apiUrl || !projectId || !mrIid || !auth) return undefined;
  try {
    const res = await fetch(`${apiUrl}/projects/${encodeURIComponent(projectId)}/merge_requests/${mrIid}`, {
      headers: auth,
    });
    if (!res.ok) return undefined;
    return ((await res.json()) as { description?: string }).description ?? undefined;
  } catch {
    return undefined;
  }
}
