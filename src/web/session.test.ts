import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ChatUI, Confirmer } from "../agent/brain.js";
import { ChatSession, SessionBusyError } from "./session.js";
import type { ChatEvent } from "./events.js";

/**
 * The session is the safety boundary between the browser and the brain: it
 * owns the busy lock, the confirm registry (with auto-deny timeout) and the
 * replayable event log. These tests drive it with scripted fake brains —
 * no model, no network.
 */

interface Harness {
  session: ChatSession;
  confirm: () => Confirmer;
  ui: () => ChatUI;
}

function makeSession(
  brainImpl: (confirm: Confirmer, ui: ChatUI) => (msg: string) => Promise<void>,
  options: { confirmTimeoutMs?: number; maxEvents?: number } = {},
): Harness {
  let capturedConfirm: Confirmer;
  let capturedUi: ChatUI;
  const session = new ChatSession({
    createBrain: (confirm, ui) => {
      capturedConfirm = confirm;
      capturedUi = ui;
      return { send: brainImpl(confirm, ui) };
    },
    ...options,
  });
  return { session, confirm: () => capturedConfirm, ui: () => capturedUi };
}

const types = (events: readonly ChatEvent[]) => events.map((e) => e.type);

describe("ChatSession", () => {
  it("emits an ordered event log for a simple turn", async () => {
    const { session } = makeSession((_, ui) => async (msg) => {
      ui.status(`→ audit {}`);
      ui.toolCall?.("audit_subscriptions", {});
      ui.toolResult?.("audit_subscriptions", { active: 4 });
      ui.assistantText(`You said: ${msg}`);
    });

    await session.send("audit please");

    assert.deepEqual(types(session.eventLog), [
      "user_message",
      "turn_started",
      "status",
      "tool_call",
      "tool_result",
      "assistant_text",
      "turn_complete",
    ]);
    const last = session.eventLog.at(-1) as ChatEvent & { ok: boolean };
    assert.equal(last.ok, true);
    // Ids must be strictly increasing — SSE replay depends on it.
    const ids = session.eventLog.map((e) => e.id);
    assert.deepEqual(ids, [...ids].sort((a, b) => a - b));
  });

  it("rejects a second send while a turn is running, then frees the lock", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { session } = makeSession(() => () => gate);

    const first = session.send("one");
    assert.equal(session.busy, true);
    await assert.rejects(session.send("two"), SessionBusyError);

    release();
    await first;
    assert.equal(session.busy, false);
    await session.send("three"); // lock released — works again
    assert.equal(
      session.eventLog.filter((e) => e.type === "user_message").length,
      2,
      "the rejected send must not have logged a user message",
    );
  });

  it("a brain crash becomes turn_complete{ok:false} and releases the lock", async () => {
    const { session } = makeSession(() => async () => {
      throw new Error("model exploded");
    });
    await session.send("hi"); // must not reject
    const last = session.eventLog.at(-1) as ChatEvent & { ok: boolean; error?: string };
    assert.equal(last.type, "turn_complete");
    assert.equal(last.ok, false);
    assert.match(last.error!, /model exploded/);
    assert.equal(session.busy, false);
  });

  it("approve resolves the pending confirm and emits both events", async () => {
    const { session } = makeSession((confirm) => async () => {
      const approved = await confirm("Cancel sub_gym_app?");
      assert.equal(approved, true);
    });

    const turn = session.send("cancel it");
    // Wait for the confirm_request to land in the log.
    await waitFor(() => session.eventLog.some((e) => e.type === "confirm_request"));
    const request = session.eventLog.find((e) => e.type === "confirm_request") as ChatEvent & {
      confirmId: string;
      summary: string;
      expiresAtMs: number;
    };
    assert.equal(request.summary, "Cancel sub_gym_app?");
    assert.ok(request.expiresAtMs > Date.now());

    assert.equal(session.resolveConfirm(request.confirmId, true), true);
    await turn;

    const resolved = session.eventLog.find((e) => e.type === "confirm_resolved") as ChatEvent & {
      approved: boolean;
      via: string;
    };
    assert.equal(resolved.approved, true);
    assert.equal(resolved.via, "user");
  });

  it("deny resolves false and a second resolve of the same id is rejected", async () => {
    const { session } = makeSession((confirm) => async () => {
      const approved = await confirm("Charge sub_netflix?");
      assert.equal(approved, false);
    });
    const turn = session.send("charge it");
    await waitFor(() => session.eventLog.some((e) => e.type === "confirm_request"));
    const { confirmId } = session.eventLog.find((e) => e.type === "confirm_request") as ChatEvent & {
      confirmId: string;
    };

    assert.equal(session.resolveConfirm(confirmId, false), true);
    assert.equal(session.resolveConfirm(confirmId, true), false, "double-resolve must fail");
    assert.equal(session.resolveConfirm("confirm_nope", true), false, "unknown id must fail");
    await turn;
  });

  it("an unanswered confirm auto-denies after the timeout", async () => {
    const { session } = makeSession(
      (confirm) => async () => {
        const approved = await confirm("Charge sub_netflix?");
        assert.equal(approved, false, "timeout must deny, never approve");
      },
      { confirmTimeoutMs: 25 },
    );

    await session.send("charge it"); // resolves only because the timeout fires
    const resolved = session.eventLog.find((e) => e.type === "confirm_resolved") as ChatEvent & {
      approved: boolean;
      via: string;
    };
    assert.equal(resolved.approved, false);
    assert.equal(resolved.via, "timeout");
  });

  it("subscribe replays history after the given id, then streams live", async () => {
    const { session } = makeSession(() => async () => {});
    await session.send("first");

    const replayed: ChatEvent[] = [];
    const unsubscribe = session.subscribe((e) => replayed.push(e), 1);
    assert.deepEqual(
      replayed.map((e) => e.id),
      session.eventLog.filter((e) => e.id > 1).map((e) => e.id),
    );

    const before = replayed.length;
    await session.send("second");
    assert.ok(replayed.length > before, "live events must keep flowing");

    unsubscribe();
    const after = replayed.length;
    await session.send("third");
    assert.equal(replayed.length, after, "unsubscribed listeners must not receive events");
  });

  it("caps the event log by dropping oldest events", async () => {
    const { session } = makeSession(() => async () => {}, { maxEvents: 5 });
    for (let i = 0; i < 4; i++) await session.send(`m${i}`);
    assert.equal(session.eventLog.length, 5);
    // Newest events survive.
    assert.equal(session.eventLog.at(-1)?.type, "turn_complete");
  });

  it("a throwing subscriber does not break the turn or other subscribers", async () => {
    const { session } = makeSession(() => async () => {});
    const received: ChatEvent[] = [];
    session.subscribe(() => { throw new Error("broken pipe"); });
    session.subscribe((e) => received.push(e));
    await session.send("hello");
    assert.ok(received.length >= 3, "healthy subscriber still got events");
  });

  it("close() denies all pending confirms", async () => {
    const { session } = makeSession((confirm) => async () => {
      const approved = await confirm("Cancel everything?");
      assert.equal(approved, false);
    });
    const turn = session.send("cancel");
    await waitFor(() => session.eventLog.some((e) => e.type === "confirm_request"));
    session.close();
    await turn;
  });
});

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}
