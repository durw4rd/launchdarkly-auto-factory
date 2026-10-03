import { createGitHubHost } from "./github.js";
import { createGitLabHost } from "./gitlab.js";
import type { CodeHost } from "./types.js";

export type { CodeHost, StatusConclusion, StatusOptions } from "./types.js";
export { fetchMrDescription } from "./gitlab.js";

/** GitLab when running in GitLab CI (or forced via AUTOFACTORY_CODE_HOST), else GitHub. */
export function isGitLab(env: NodeJS.ProcessEnv = process.env): boolean {
  const forced = env.AUTOFACTORY_CODE_HOST?.toLowerCase();
  if (forced) return forced === "gitlab";
  return env.GITLAB_CI === "true";
}

export function resolveCodeHost(target: { repo?: string; prNumber?: string }): CodeHost {
  return isGitLab() ? createGitLabHost() : createGitHubHost(target);
}
