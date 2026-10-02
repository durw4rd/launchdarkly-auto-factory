/**
 * Assemble PR context for the agent chain from the GitHub Actions environment.
 * Reads the event payload (GITHUB_EVENT_PATH) when available, with env fallbacks.
 */

import { existsSync, readFileSync } from "node:fs";

export interface PrContext {
  PR_NUMBER?: string;
  PR_TITLE?: string;
  PR_BODY?: string;
  REPO?: string;
  SHA?: string;
  /**
   * The PR head commit SHA. On `pull_request` events GITHUB_SHA is the ephemeral
   * merge commit, not the PR head — check runs must attach to the head so they
   * appear on the PR's own commit. Read from the event payload.
   */
  HEAD_SHA?: string;
  [key: string]: unknown;
}

export function assemblePrContext(): PrContext {
  const ctx: PrContext = {
    REPO: process.env.GITHUB_REPOSITORY,
    SHA: process.env.GITHUB_SHA,
  };

  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (eventPath && existsSync(eventPath)) {
    try {
      const event = JSON.parse(readFileSync(eventPath, "utf8")) as {
        pull_request?: { number?: number; title?: string; body?: string; head?: { sha?: string } };
      };
      const pr = event.pull_request;
      if (pr) {
        if (pr.number !== undefined) ctx.PR_NUMBER = String(pr.number);
        if (pr.title) ctx.PR_TITLE = pr.title;
        if (pr.body) ctx.PR_BODY = pr.body;
        if (pr.head?.sha) ctx.HEAD_SHA = pr.head.sha;
      }
    } catch {
      /* fall through to env */
    }
  }

  // GitLab MR pipelines: the same fields from GitLab's predefined variables
  // (only set in merge_request_event pipelines). CI_MERGE_REQUEST_DESCRIPTION is
  // truncated at 2700 chars; action.ts swaps in the full text when it can.
  if (process.env.GITLAB_CI === "true") {
    ctx.REPO ??= process.env.CI_PROJECT_PATH;
    ctx.SHA ??= process.env.CI_COMMIT_SHA;
    ctx.HEAD_SHA ??= process.env.CI_COMMIT_SHA;
    ctx.PR_NUMBER ??= process.env.CI_MERGE_REQUEST_IID;
    ctx.PR_TITLE ??= process.env.CI_MERGE_REQUEST_TITLE;
    ctx.PR_BODY ??= process.env.CI_MERGE_REQUEST_DESCRIPTION;
  }

  // Explicit input overrides (action.yml inputs are exposed as INPUT_* / env).
  ctx.PR_NUMBER = process.env.PR_NUMBER ?? ctx.PR_NUMBER;
  ctx.PR_TITLE = process.env.PR_TITLE ?? ctx.PR_TITLE;
  ctx.PR_BODY = process.env.PR_BODY ?? ctx.PR_BODY;
  ctx.HEAD_SHA = process.env.PR_HEAD_SHA ?? ctx.HEAD_SHA;

  return ctx;
}
