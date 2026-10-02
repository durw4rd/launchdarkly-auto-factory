# AutoFactory in GitLab CI/CD

Phase 1 on GitLab merge requests — the GitLab counterpart of the
[GitHub Action](../github-action-template/). Same core, same agent chain, same
LaunchDarkly configs; only the reporting surface differs: one sticky **MR note**
for the summary and **commit statuses** instead of PR comments and check runs
(ADR 0020). Proof of concept: tested on gitlab.com.

## Setup (in your GitLab project)

1. Bootstrap the factory project in LaunchDarkly per the
   [root README](../../README.md) (configs provisioned).
2. Copy [`.gitlab-ci.yml`](.gitlab-ci.yml) into the project root (or `include:`
   it from your existing pipeline).
3. **Settings → CI/CD → Job token permissions:** enable *Allow Git push requests
   to the repository*. The agents push their commits with `CI_JOB_TOKEN`; a
   job-token push starts no pipeline, so the bot can't trigger itself.
4. **Create an access token with `api` scope** for MR notes, commit statuses and
   approval labels — `CI_JOB_TOKEN` can't write those. A project access token
   (Premium+) or, on the Free tier, a personal access token from a bot or your
   own account.
5. **Settings → CI/CD → Variables** — masked, and **not protected** (protected
   variables aren't passed to MR pipelines from unprotected branches):

   | Variable | Value |
   |---|---|
   | `LD_SDK_KEY` | factory project server SDK key |
   | `LD_API_KEY` | API token that writes flags/metrics in the app project |
   | `ANTHROPIC_API_KEY` | default `anthropic` provider |
   | `AUTOFACTORY_GITLAB_TOKEN` | the `api` token from step 4 |
   | `LD_APP_PROJECT_KEY` | app project key (plain, not secret) |
   | `TYPESAFE_API_KEY` | optional: Jev pre-classification |

Then open an MR. The pipeline runs the chain, the agents commit to the MR
branch, and the MR gets the summary note and an `AutoFactory — Phase 1` status.

**Don't expose these variables to fork MRs** — a fork's pipeline would run
untrusted code with your keys.

## Pauses

| Pause | What you see | To continue |
|---|---|---|
| Approval gate (`auto-factory-approval-gates` flag) | Note lists the gated steps; status `pending`; job "passed with warnings" (exit 78) | Add the MR label `af-approve:<step>`, then **Run pipeline** on the MR's Pipelines tab — label changes alone don't start a pipeline |
| Agent question (M14) | Note quotes the question; status `pending`; exit 78 | Set `humanInput.answer` in `.release-flags/pr-<iid>.json` on the MR branch and push — the push starts the pipeline |

## Not yet on GitLab

Issue intake (`autofactory intake`), cross-repo research (`relatedRepos`),
Beacon's deploy-driven releases, and `config-bridge init/doctor --front-end
gitlab` are GitHub-only for now — see ADR 0020 for the follow-ups.
