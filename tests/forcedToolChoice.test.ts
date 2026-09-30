import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createForcedToolJudgeCompletion, supportsForcedToolChoice } from "@auto-factory/shared";

describe("supportsForcedToolChoice", () => {
  it("accepts forced tool use on pre-5.5 Opus/Sonnet, Haiku, and Fable 5", () => {
    for (const m of [
      "claude-sonnet-4-6",
      "claude-opus-5",
      "claude-sonnet-5",
      "claude-haiku-4-5",
      "claude-opus-4-20250514",
      "claude-sonnet-4-5-20250929",
      "claude-fable-5",
      "anthropic.claude-sonnet-4-6",
    ]) {
      assert.equal(supportsForcedToolChoice(m), true, m);
    }
  });

  it("rejects it on Opus 5.5, Sonnet 5.5, Fable/Mythos 5.1, including Bedrock ids", () => {
    for (const m of [
      "claude-opus-5-5",
      "claude-sonnet-5-5",
      "claude-fable-5-1",
      "claude-mythos-5-1",
      "anthropic.claude-opus-5-5",
      "us.anthropic.claude-sonnet-5-5",
      "claude-opus-6",
    ]) {
      assert.equal(supportsForcedToolChoice(m), false, m);
    }
  });

  it("assumes unrecognized ids accept it", () => {
    assert.equal(supportsForcedToolChoice("some-custom-model"), true);
  });
});

describe("forced-tool judge completion", () => {
  const usage = { input_tokens: 10, output_tokens: 5 };
  const toolUse = { type: "tool_use", id: "t1", name: "record_evaluation", input: { score: 0.9, reasoning: "ok" } };

  function fakeClient(responses: unknown[]) {
    const calls: any[] = [];
    return {
      calls,
      client: {
        messages: {
          create: async (params: any) => {
            calls.push(structuredClone(params));
            return responses.shift() as any;
          },
        },
      },
    };
  }

  it("forces the tool on models that support it", async () => {
    const { client, calls } = fakeClient([{ content: [toolUse], stop_reason: "tool_use", usage }]);
    const r = await createForcedToolJudgeCompletion(client, (n) => n!)({
      model: "claude-sonnet-4-6",
      system: "Judge.",
      input: "x",
      schema: { type: "object" },
    } as any);
    assert.deepEqual(calls[0].tool_choice, { type: "tool", name: "record_evaluation" });
    assert.equal(r.success, true);
  });

  it("uses auto + one nudge on models that reject forced tool use", async () => {
    const { client, calls } = fakeClient([
      { content: [{ type: "text", text: "Looks good." }], stop_reason: "end_turn", usage },
      { content: [toolUse], stop_reason: "tool_use", usage },
    ]);
    const r = await createForcedToolJudgeCompletion(client, (n) => n!)({
      model: "claude-opus-5-5",
      system: "Judge.",
      input: "x",
      schema: { type: "object" },
    } as any);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0].tool_choice, { type: "auto" });
    assert.match(calls[0].system, /record_evaluation/);
    assert.equal(calls[1].messages.length, 3);
    assert.equal(r.success, true);
    assert.deepEqual(r.parsed, { score: 0.9, reasoning: "ok" });
    assert.equal(r.tokens?.total, 30);
  });
});

describe("effortConfig", () => {
  it("maps a valid LD effort parameter to output_config", async () => {
    const { effortConfig } = await import("@auto-factory/shared");
    assert.deepEqual(effortConfig({ effort: "high", temperature: 0.2 }), { effort: "high" });
    assert.equal(effortConfig({ effort: "turbo" }), undefined);
    assert.equal(effortConfig({ temperature: 0.2 }), undefined);
    assert.equal(effortConfig(undefined), undefined);
  });
});
