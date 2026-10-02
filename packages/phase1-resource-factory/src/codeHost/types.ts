/**
 * The code host the Action reports to: where the summary comment, the status
 * checks, and the approval gesture live. GitHub (PR comments, check runs, PR
 * labels) is the original; GitLab (MR notes, commit statuses, MR labels) is the
 * second. Everything else in the run — graph walk, gates, judges, runners, git
 * pushes — is host-neutral and never sees this interface.
 *
 * Every method is best-effort and non-fatal, like the GitHub helpers it wraps:
 * missing credentials or a failed API call logs and returns, never throws.
 */

export type StatusConclusion = "action_required" | "success" | "neutral" | "failure";

export interface StatusOptions {
  /** Status/check name; defaults to the approval-gate check. */
  name?: string;
  /** Commit to attach the status to; skipped when absent. */
  sha?: string;
  conclusion: StatusConclusion;
  title: string;
  summary: string;
}

export interface CodeHost {
  readonly name: "github" | "gitlab";
  /** Upper-case noun for the change request in user-facing text ("PR" / "MR"). */
  readonly changeNoun: string;
  /**
   * Exit code when the chain pauses (approval gate or a human question). GitHub
   * exits 0 and lets the `action_required` check run carry the signal; GitLab has
   * no such state, so it exits a code the template marks `allow_failure` — the job
   * shows "passed with warnings" instead of green or red.
   */
  readonly pauseExitCode: number;
  /** Post or update this run's single summary comment on the change request. */
  postComment(body: string): Promise<void>;
  postStatus(opts: StatusOptions): Promise<void>;
  /** Node keys approved via `af-approve:<nodeKey>` labels on the change request. */
  approvedSteps(): Promise<Set<string>>;
  /** Pre-create the approval label so approvers can pick it rather than type it. */
  ensureApprovalLabel(label: string): Promise<void>;
  /** Who last added an approval label (feeds releaseIntent.approvedBy). */
  approvalActor(): Promise<string | undefined>;
  /** What a human does to approve, after adding `label`, phrased for this host. */
  approveHint(label: string): string;
}
