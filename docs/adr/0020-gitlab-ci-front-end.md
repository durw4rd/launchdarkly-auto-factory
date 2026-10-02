# ADR 0020: GitLab CI/CD front end — a code-host seam under the Action

Date: 2026-10-02
Status: proposed (proof of concept)

## Context

Phase 1 runs from GitHub Actions on pull requests. Teams on GitLab want the
same thing on merge requests, triggered from GitLab CI/CD. Almost all of the
Action is already host-neutral: the graph walk, gates, judges, runners, the
sandbox's `commit_and_push` (with its `[skip ci]` guard) and the release
manifest. The GitHub coupling sat in three small modules of raw `fetch` calls
(`comment.ts`, `checkRun.ts`, `labels.ts`) plus `prContext.ts`, all called
directly from `action.ts`.

GitLab differs where it matters:

- `CI_JOB_TOKEN` can push (with the project's *Allow Git push requests* setting)
  and a job-token push starts no pipeline, but it cannot create MR notes,
  commit statuses or labels.
- There is no `action_required` state: a job is green, red, or "passed with
  warnings" (`allow_failure: exit_codes`).
- Label changes on an MR do not start a pipeline.
- MR pipelines check out a detached `refs/merge-requests/<iid>/head`, shallow.

## Decision

1. **A `CodeHost` interface** (`packages/phase1-resource-factory/src/codeHost/`)
   carries everything host-specific: `postComment`, `postStatus`,
   `approvedSteps`, `ensureApprovalLabel`, `approvalActor`, `approveHint`, and
   `pauseExitCode`. The GitHub implementation wraps the original helpers
   unchanged; `action.ts` only talks to the interface. `resolveCodeHost()`
   picks GitLab when `GITLAB_CI=true` (or `AUTOFACTORY_CODE_HOST=gitlab`).
2. **GitLab implementation over REST v4.** The single summary note is found by
   the same hidden marker and updated in place. Statuses use the same names as
   the GitHub check runs, with `action_required` mapped to `pending`. Writes
   need `AUTOFACTORY_GITLAB_TOKEN` (`api` scope); reads the job token covers
   (the full MR description, which `CI_MERGE_REQUEST_DESCRIPTION` truncates at
   2700 characters) fall back to it.
3. **Pauses exit 78 on GitLab**, which the template lists under `allow_failure`,
   so a paused run is yellow, not green and not red. GitHub keeps exit 0 plus
   the `action_required` check run.
4. **Approval stays label-based** (`af-approve:<step>`, read from
   `CI_MERGE_REQUEST_LABELS`), and resuming is explicit: add the label, then
   run a new pipeline. Agent questions (M14) need nothing new: pushing the
   manifest answer starts the MR pipeline.
5. **Context from GitLab's predefined variables** in `prContext.ts`; the
   template supplies `PR_BRANCH` / `PR_BASE_REF`, checks out the source branch,
   fetches the target, and points `origin` at a job-token URL.
6. **Template** `bootstrap/gitlab-ci-template/.gitlab-ci.yml` clones the public
   tool repo and runs the pre-built `dist/action.bundle.js`, the same way the
   Cursor workflow does on GitHub. It sets the surface `gitlab`, which the
   provider flag routes to `anthropic` (the bundle runs without `npm ci`, so
   there is no Cursor SDK).
7. `parseSlug` keeps the full remote path so nested GitLab groups survive.

## Consequences

- The GitHub path is unchanged in behaviour; it now goes through an adapter.
- GitLab gets the core loop and both pauses. Resuming an approval takes one
  more click than on GitHub (Run pipeline after the label).
- On the gitlab.com Free tier the write token is a personal access token;
  project access tokens need Premium.
- Not yet on GitLab, each a follow-up: issue intake (`shared/src/github/intake.ts`),
  cross-repo research (`relatedRepos.ts`), Beacon's repo client
  (`packages/beacon/src/github.ts`), `config-bridge init/doctor --front-end
  gitlab`, and `glab mr create` in the pre-push hooks. Label-triggered resumes
  would need a webhook listener calling the create-MR-pipeline API.
