import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type Anthropic from "@anthropic-ai/sdk";
import { ButlerBrain, type ChatUI, type ContractInvoker, type MessagesClient } from "./brain.js";

/**
 * These tests drive the brain with a SCRIPTED fake model and a fake invoker —
 * no network, no API key. They verify the parts that must be correct
 * regardless of what the real model says: confirmation gating on mutating
 * tools, tool dispatch, and how denials/errors are fed back to the model.
 */

/** A fake Anthropic client that returns a pre-scripted sequence of responses. */
function fakeClient(responses: Anthropic.Message[]): {
  client: MessagesClient;
  calls: Anthropic.MessageCreateParamsNonStreaming[];
} {
  const calls: Anthropic.MessageCreateParamsNonStreaming[] = [];
  let i = 0;
  const client: MessagesClient = {
    messages: {
      create: async (body) => {
        // Snapshot the messages array — the brain reuses one array reference
        // and appends to it across iterations, so storing it by reference
        // would always show the final state.
        calls.push({ ...body, messages: [...body.messages] });
        const resp = responses[i];
        i += 1;
        if (!resp) throw new Error("fakeClient ran out of scripted responses");
        return resp;
      },
    },
  };
  return { client, calls };
}

function textResponse(text: string): Anthropic.Message {
  return {
    id: "msg_text",
    type: "message",
    role: "assistant",
    model: "fake",
    stop_reason: "end_turn",
    stop_sequence: null,
    content: [{ type: "text", text, citations: null }],
    usage: usage(),
  } as unknown as Anthropic.Message;
}

function toolUseResponse(name: string, input: Record<string, unknown>): Anthropic.Message {
  return {
    id: "msg_tool",
    type: "message",
    role: "assistant",
    model: "fake",
    stop_reason: "tool_use",
    stop_sequence: null,
    content: [{ type: "tool_use", id: `toolu_${name}`, name, input }],
    usage: usage(),
  } as unknown as Anthropic.Message;
}

function usage() {
  return { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
}

function recordingInvoker(impl?: ContractInvoker["invoke"]): {
  invoker: ContractInvoker;
  calls: Array<{ fn: string; input: unknown }>;
} {
  const calls: Array<{ fn: string; input: unknown }> = [];
  const invoker: ContractInvoker = {
    invoke: async (fn, input) => {
      calls.push({ fn, input });
      return impl ? impl(fn, input) : { ok: true };
    },
  };
  return { invoker, calls };
}

const silentUI = (): ChatUI => ({ assistantText() {}, status() {}, toolDenied() {} });

describe("ButlerBrain — confirmation gating", () => {
  it("runs a read-only tool without asking for confirmation", async () => {
    const { client } = fakeClient([
      toolUseResponse("audit_subscriptions", { monthly_budget_cents: 5000 }),
      textResponse("You have 2 subscriptions to cancel."),
    ]);
    const { invoker, calls } = recordingInvoker();
    let confirmCalls = 0;
    const brain = new ButlerBrain(invoker, async () => {
      confirmCalls += 1;
      return true;
    }, silentUI(), { client });

    await brain.send("audit me");

    assert.equal(confirmCalls, 0, "read-only tools must not trigger a confirmation");
    assert.deepEqual(calls, [{ fn: "audit-subscriptions", input: { monthly_budget_cents: 5000 } }]);
  });

  it("does NOT invoke a mutating tool when the user denies", async () => {
    const { client } = fakeClient([
      toolUseResponse("cancel_subscription", { subscription_id: "sub_gym_app" }),
      textResponse("Okay, I won't cancel it."),
    ]);
    const { invoker, calls } = recordingInvoker();
    const brain = new ButlerBrain(invoker, async () => false, silentUI(), { client });

    await brain.send("cancel my gym membership");

    assert.equal(calls.length, 0, "a denied mutating tool must never reach the contract");
  });

  it("feeds a denial back as an is_error tool_result so the model can adjust", async () => {
    const { client, calls: apiCalls } = fakeClient([
      toolUseResponse("cancel_subscription", { subscription_id: "sub_gym_app" }),
      textResponse("Understood."),
    ]);
    const { invoker } = recordingInvoker();
    const brain = new ButlerBrain(invoker, async () => false, silentUI(), { client });

    await brain.send("cancel gym");

    // Second API call carries the tool_result the brain produced for the denial.
    const secondCall = apiCalls[1];
    const toolResultTurn = secondCall.messages[secondCall.messages.length - 1];
    const block = (toolResultTurn.content as Anthropic.ToolResultBlockParam[])[0];
    assert.equal(block.type, "tool_result");
    assert.equal(block.is_error, true);
    assert.match(String(block.content), /denied-by-user/);
  });

  it("invokes a mutating tool when the user approves", async () => {
    const { client } = fakeClient([
      toolUseResponse("cancel_subscription", { subscription_id: "sub_news" }),
      textResponse("Cancelled."),
    ]);
    const { invoker, calls } = recordingInvoker(async () => ({
      subscriptionId: "sub_news",
      status: "cancelled",
      changed: true,
    }));
    const brain = new ButlerBrain(invoker, async () => true, silentUI(), { client });

    await brain.send("cancel the news subscription");

    assert.deepEqual(calls, [{ fn: "cancel-subscription", input: { subscription_id: "sub_news" } }]);
  });

  it("surfaces a contract error back to the model as is_error without throwing", async () => {
    const { client, calls: apiCalls } = fakeClient([
      toolUseResponse("cancel_subscription", { subscription_id: "sub_missing" }),
      textResponse("That subscription doesn't exist."),
    ]);
    const { invoker } = recordingInvoker(async () => {
      throw new Error('not-found: billing API HTTP 404 — not_found: No subscription with id "sub_missing".');
    });
    const brain = new ButlerBrain(invoker, async () => true, silentUI(), { client });

    await brain.send("cancel sub_missing");

    const secondCall = apiCalls[1];
    const toolResultTurn = secondCall.messages[secondCall.messages.length - 1];
    const block = (toolResultTurn.content as Anthropic.ToolResultBlockParam[])[0];
    assert.equal(block.is_error, true);
    assert.match(String(block.content), /not-found/);
  });

  it("rejects an unknown tool name with a bad-input result instead of crashing", async () => {
    const { client, calls: apiCalls } = fakeClient([
      toolUseResponse("delete_everything", {}),
      textResponse("I can't do that."),
    ]);
    const { invoker, calls } = recordingInvoker();
    const brain = new ButlerBrain(invoker, async () => true, silentUI(), { client });

    await brain.send("delete everything");

    assert.equal(calls.length, 0);
    const block = (apiCalls[1].messages.at(-1)!.content as Anthropic.ToolResultBlockParam[])[0];
    assert.equal(block.is_error, true);
    assert.match(String(block.content), /unknown tool/);
  });

  it("stops the tool loop after the safety bound and reports it", async () => {
    // Always return a tool_use → would loop forever without the bound.
    const loopResponses = Array.from({ length: 20 }, () =>
      toolUseResponse("audit_subscriptions", {}),
    );
    const { client } = fakeClient(loopResponses);
    const { invoker } = recordingInvoker();
    let statusLines = 0;
    const ui: ChatUI = { assistantText() {}, status: () => { statusLines += 1; }, toolDenied() {} };
    const brain = new ButlerBrain(invoker, async () => true, ui, { client });

    await brain.send("loop forever");

    assert.ok(statusLines > 0, "should emit a status line when hitting the iteration bound");
  });
});
