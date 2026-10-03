import { postCheckRun } from "../checkRun.js";
import { postPrComment } from "../comment.js";
import { ensureLabel, fetchApprovalActor, fetchApprovedSteps } from "../labels.js";
import type { CodeHost } from "./types.js";

/** GitHub: a thin adapter over the original comment / check-run / label helpers. */
export function createGitHubHost(target: { repo?: string; prNumber?: string }): CodeHost {
  const token = () => process.env.GITHUB_TOKEN;
  return {
    name: "github",
    changeNoun: "PR",
    pauseExitCode: 0,
    skipCiMarker: true,
    postComment: (body) => postPrComment(body, { prNumber: target.prNumber, repo: target.repo }),
    postStatus: (opts) =>
      postCheckRun({
        name: opts.name,
        repo: target.repo,
        headSha: opts.sha,
        conclusion: opts.conclusion,
        title: opts.title,
        summary: opts.summary,
      }),
    approvedSteps: () => fetchApprovedSteps(target.repo, target.prNumber, token()),
    ensureApprovalLabel: (label) => ensureLabel(target.repo, label, token()),
    approvalActor: () => fetchApprovalActor(target.repo, target.prNumber, token()),
    approveHint: (label) => `Add the PR label \`${label}\` to approve; the chain resumes on the next run.`,
  };
}
