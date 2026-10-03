/**
 * Post (or update) a summary comment on the PR. Best-effort and non-fatal: if the
 * token / repo / PR number aren't available, it logs and returns.
 *
 * Idempotent per PR: the comment carries a hidden marker, and re-runs (every
 * `synchronize` — including the agents' own pushes) PATCH the existing comment
 * instead of appending a new one, so busy PRs don't accumulate duplicate summaries.
 */

/** Hidden marker used to find this action's prior comment on a PR. */
export const MARKER = "<!-- auto-factory-phase1 -->";

export interface CommentTarget {
  prNumber?: string;
  repo?: string; // owner/name
  token?: string;
}

interface GhComment {
  id: number;
  body?: string;
}

export async function postPrComment(body: string, target: CommentTarget = {}): Promise<void> {
  const token = target.token ?? process.env.GITHUB_TOKEN;
  const repo = target.repo ?? process.env.GITHUB_REPOSITORY;
  const prNumber = target.prNumber ?? process.env.PR_NUMBER;

  if (!token || !repo || !prNumber) {
    console.log("(PR comment skipped — missing token / repo / PR number)");
    return;
  }

  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type": "application/json",
  };
  const markedBody = `${MARKER}\n${body}`;

  try {
    // Find a prior comment from this action (by marker) to update in place.
    const existingId = await findExistingComment(repo, prNumber, headers);
    const url = existingId
      ? `https://api.github.com/repos/${repo}/issues/comments/${existingId}`
      : `https://api.github.com/repos/${repo}/issues/${prNumber}/comments`;
    const res = await fetch(url, {
      method: existingId ? "PATCH" : "POST",
      headers,
      body: JSON.stringify({ body: markedBody }),
    });
    if (res.ok) {
      console.log(existingId ? "Updated PR summary comment." : "Posted PR summary comment.");
    } else {
      console.log(`PR comment failed: HTTP ${res.status}`);
    }
  } catch (e) {
    console.warn(`PR comment error (non-fatal): ${e instanceof Error ? e.message : e}`);
  }
}

/** Return the id of this action's existing marked comment on the PR, if any. */
async function findExistingComment(
  repo: string,
  prNumber: string,
  headers: Record<string, string>,
): Promise<number | undefined> {
  try {
    const res = await fetch(
      `https://api.github.com/repos/${repo}/issues/${prNumber}/comments?per_page=100`,
      { headers },
    );
    if (!res.ok) return undefined;
    const comments = (await res.json()) as GhComment[];
    return comments.find((c) => c.body?.includes(MARKER))?.id;
  } catch {
    return undefined;
  }
}
