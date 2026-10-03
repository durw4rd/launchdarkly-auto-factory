import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { MARKER } from "../packages/phase1-resource-factory/src/comment.js";
import { isGitLab, resolveCodeHost } from "../packages/phase1-resource-factory/src/codeHost/index.js";
import {
  PAUSE_EXIT_CODE,
  createGitLabHost,
  fetchMrDescription,
} from "../packages/phase1-resource-factory/src/codeHost/gitlab.js";
import { assemblePrContext } from "../packages/phase1-resource-factory/src/prContext.js";
import { parseSlug } from "../packages/shared/src/workingTree.js";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
}

const realFetch = globalThis.fetch;
let calls: Call[] = [];

/** Stub fetch: `respond` maps a call to [status, json]. */
function stubFetch(respond: (c: Call) => [number, unknown] = () => [200, {}]): void {
  calls = [];
  globalThis.fetch = (async (url: string | URL, init: RequestInit = {}) => {
    const call: Call = {
      url: String(url),
      method: init.method ?? "GET",
      headers: (init.headers ?? {}) as Record<string, string>,
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    const [status, json] = respond(call);
    return new Response(JSON.stringify(json), { status });
  }) as typeof fetch;
}

const target = { apiUrl: "https://gitlab.example/api/v4", projectId: "grp/sub/app", mrIid: "7", token: "glpat-x" };
const MR = "https://gitlab.example/api/v4/projects/grp%2Fsub%2Fapp/merge_requests/7";

const ENV_KEYS = [
  "GITLAB_CI",
  "AUTOFACTORY_CODE_HOST",
  "CI_MERGE_REQUEST_LABELS",
  "CI_JOB_URL",
  "CI_PIPELINE_ID",
  "CI_PROJECT_PATH",
  "CI_COMMIT_SHA",
  "CI_MERGE_REQUEST_IID",
  "CI_MERGE_REQUEST_TITLE",
  "CI_MERGE_REQUEST_DESCRIPTION",
  "GITHUB_REPOSITORY",
  "GITHUB_SHA",
  "GITHUB_EVENT_PATH",
  "PR_NUMBER",
  "PR_TITLE",
  "PR_BODY",
  "PR_HEAD_SHA",
];
let savedEnv: Record<string, string | undefined> = {};
beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
});
afterEach(() => {
  globalThis.fetch = realFetch;
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe("GitLab code host: MR note", () => {
  it("posts a marked note when none exists, with the PRIVATE-TOKEN header", async () => {
    stubFetch((c) => (c.method === "GET" ? [200, [{ id: 1, body: "someone else" }]] : [201, {}]));
    await createGitLabHost(target).postComment("hello");
    const post = calls.find((c) => c.method === "POST");
    assert.equal(post?.url, `${MR}/notes`);
    assert.equal(post?.headers["PRIVATE-TOKEN"], "glpat-x");
    assert.equal((post?.body as { body: string }).body, `${MARKER}\nhello`);
  });

  it("updates the existing marked note in place instead of appending", async () => {
    stubFetch((c) => (c.method === "GET" ? [200, [{ id: 42, body: `${MARKER}\nold` }]] : [200, {}]));
    await createGitLabHost(target).postComment("new");
    assert.deepEqual(
      calls.map((c) => `${c.method} ${c.url.replace(MR, "")}`),
      ["GET /notes?per_page=100&sort=desc", "PUT /notes/42"],
    );
  });

  it("skips without a write token", async () => {
    stubFetch();
    await createGitLabHost({ ...target, token: undefined }).postComment("x");
    assert.equal(calls.length, 0);
  });
});

describe("GitLab code host: commit status", () => {
  it("a pause posts NO status (a pending one would leave the pipeline running forever)", async () => {
    stubFetch();
    await createGitLabHost(target).postStatus({ sha: "abc", conclusion: "action_required", title: "t", summary: "s" });
    assert.equal(calls.length, 0);
  });

  it("truncates the description to 255, links the job, and pins only the pipeline's own commit", async () => {
    Object.assign(process.env, { CI_JOB_URL: "https://gitlab.example/job/1", CI_PIPELINE_ID: "42", CI_COMMIT_SHA: "abc" });
    stubFetch();
    const host = createGitLabHost(target);
    await host.postStatus({ sha: "abc", conclusion: "success", title: "x".repeat(300), summary: "s" });
    const body = calls[0]?.body as Record<string, unknown>;
    assert.equal(calls[0]?.url, "https://gitlab.example/api/v4/projects/grp%2Fsub%2Fapp/statuses/abc");
    assert.equal(body.name, "AutoFactory — Approval gate");
    assert.equal((body.description as string).length, 255);
    assert.equal(body.target_url, "https://gitlab.example/job/1");
    assert.equal(body.pipeline_id, 42);

    // The post-chain HEAD (the agents' commits) isn't this pipeline's commit: not pinned.
    await host.postStatus({ sha: "def", conclusion: "success", title: "t", summary: "s" });
    assert.equal((calls[1]?.body as Record<string, unknown>).pipeline_id, undefined);
  });

  it("maps success / failure and keeps an explicit name", async () => {
    stubFetch();
    const host = createGitLabHost(target);
    await host.postStatus({ name: "AutoFactory — Phase 1", sha: "a", conclusion: "success", title: "t", summary: "" });
    await host.postStatus({ name: "AutoFactory — Phase 1", sha: "a", conclusion: "failure", title: "t", summary: "" });
    assert.deepEqual(
      calls.map((c) => (c.body as Record<string, string>).state),
      ["success", "failed"],
    );
    assert.equal((calls[0]?.body as Record<string, string>).name, "AutoFactory — Phase 1");
  });

  it("skips without a SHA", async () => {
    stubFetch();
    await createGitLabHost(target).postStatus({ conclusion: "success", title: "t", summary: "" });
    assert.equal(calls.length, 0);
  });
});

describe("GitLab code host: approvals", () => {
  it("reads af-approve:* labels from CI_MERGE_REQUEST_LABELS", async () => {
    process.env.CI_MERGE_REQUEST_LABELS = "feature, af-approve:autofactory-flag-implementer,af-approve:x";
    const steps = await createGitLabHost(target).approvedSteps();
    assert.deepEqual([...steps].sort(), ["autofactory-flag-implementer", "x"]);
  });

  it("returns the last user who added an approval label", async () => {
    stubFetch(() => [
      200,
      [
        { action: "add", label: { name: "af-approve:a" }, user: { username: "first" } },
        { action: "add", label: { name: "bug" }, user: { username: "noise" } },
        { action: "remove", label: { name: "af-approve:a" }, user: { username: "remover" } },
        { action: "add", label: { name: "af-approve:b" }, user: { username: "last" } },
      ],
    ]);
    assert.equal(await createGitLabHost(target).approvalActor(), "last");
    assert.equal(calls[0]?.url, `${MR}/resource_label_events?per_page=100`);
  });

  it("drops the [skip ci] marker (job-token pushes start no pipeline; the marker would skip manual resumes)", () => {
    assert.equal(createGitLabHost(target).skipCiMarker, false);
    assert.equal(resolveCodeHost({}).skipCiMarker, true, "GitHub keeps it");
  });

  it("pauses with exit 78 and says a new pipeline is needed", () => {
    const host = createGitLabHost(target);
    assert.equal(host.pauseExitCode, PAUSE_EXIT_CODE);
    assert.equal(PAUSE_EXIT_CODE, 78);
    assert.match(host.approveHint("af-approve:x"), /Run pipeline/);
  });
});

describe("GitLab MR description", () => {
  it("falls back to the job token for the read", async () => {
    stubFetch(() => [200, { description: "full body" }]);
    const d = await fetchMrDescription({ ...target, token: undefined, jobToken: "job" });
    assert.equal(d, "full body");
    assert.equal(calls[0]?.url, MR);
    assert.equal(calls[0]?.headers["JOB-TOKEN"], "job");
  });
});

describe("code host selection", () => {
  it("picks GitLab in GitLab CI, GitHub otherwise, and honours the override", () => {
    assert.equal(isGitLab({}), false);
    assert.equal(isGitLab({ GITLAB_CI: "true" }), true);
    assert.equal(isGitLab({ GITLAB_CI: "true", AUTOFACTORY_CODE_HOST: "github" }), false);
    assert.equal(isGitLab({ AUTOFACTORY_CODE_HOST: "GitLab" }), true);
    assert.equal(resolveCodeHost({}).name, "github");
    process.env.GITLAB_CI = "true";
    assert.equal(resolveCodeHost({}).name, "gitlab");
  });
});

describe("PR context from GitLab variables", () => {
  it("fills the context from CI_* in GitLab CI, with PR_* still overriding", () => {
    Object.assign(process.env, {
      GITLAB_CI: "true",
      CI_PROJECT_PATH: "grp/sub/app",
      CI_COMMIT_SHA: "sha1",
      CI_MERGE_REQUEST_IID: "7",
      CI_MERGE_REQUEST_TITLE: "Add bulk discount",
      CI_MERGE_REQUEST_DESCRIPTION: "body",
      PR_TITLE: "override",
    });
    const ctx = assemblePrContext();
    assert.equal(ctx.REPO, "grp/sub/app");
    assert.equal(ctx.HEAD_SHA, "sha1");
    assert.equal(ctx.PR_NUMBER, "7");
    assert.equal(ctx.PR_BODY, "body");
    assert.equal(ctx.PR_TITLE, "override");
  });

  it("ignores CI_* outside GitLab CI", () => {
    process.env.CI_MERGE_REQUEST_IID = "7";
    assert.equal(assemblePrContext().PR_NUMBER, undefined);
  });
});

describe("parseSlug", () => {
  it("keeps GitHub owner/name and full nested GitLab paths", () => {
    assert.equal(parseSlug("git@github.com:owner/name.git"), "owner/name");
    assert.equal(parseSlug("https://github.com/owner/name"), "owner/name");
    assert.equal(parseSlug("https://github.com/owner/name.git\n"), "owner/name");
    assert.equal(parseSlug("git@gitlab.com:grp/sub/app.git"), "grp/sub/app");
    assert.equal(parseSlug("https://gitlab-ci-token:tok@gitlab.com/grp/sub/app.git"), "grp/sub/app");
    assert.equal(parseSlug("ssh://git@gitlab.com:2222/grp/app.git"), "grp/app");
    assert.equal(parseSlug("/local/path/repo"), undefined);
  });
});
