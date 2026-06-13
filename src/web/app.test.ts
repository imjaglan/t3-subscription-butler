import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { createWebApp, type WebAppDeps } from "./app.js";
import { ChatSession } from "./session.js";
import type { Confirmer } from "../agent/brain.js";

/**
 * Route-level tests: the app is driven via `app.request(...)` with a real
 * ChatSession around a scripted brain — exactly how billing/app.test.ts
 * exercises its Hono app. No sockets, no model, no testnet.
 */

const STATE = {
  principal: "tenant",
  did: "did:t3n:test",
  brainLabel: "fake · test",
  contract: { tail: "subscription-butler", version: "0.2.0", contractId: 33 },
};

function makeApp(overrides: Partial<WebAppDeps> & { brain?: (confirm: Confirmer) => Promise<void> } = {}) {
  const session =
    overrides.session ??
    new ChatSession({
      createBrain: (confirm) => ({
        send: () => (overrides.brain ? overrides.brain(confirm) : Promise.resolve()),
      }),
      confirmTimeoutMs: 5_000,
    });
  const app = createWebApp({
    session,
    fetchAuditLog: overrides.fetchAuditLog ?? (async () => ({ entries: [] })),
    state: STATE,
    ...(overrides.staticDir ? { staticDir: overrides.staticDir } : {}),
  });
  return { app, session };
}

async function postJson(app: ReturnType<typeof makeApp>["app"], path: string, body: unknown) {
  return app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("web app — /api/chat", () => {
  it("accepts a valid message with 202 and logs it as an event", async () => {
    const { app, session } = makeApp();
    const res = await postJson(app, "/api/chat", { message: "  audit please  " });
    assert.equal(res.status, 202);
    await waitFor(() => session.eventLog.some((e) => e.type === "turn_complete"));
    const user = session.eventLog.find((e) => e.type === "user_message") as { text: string };
    assert.equal(user.text, "audit please", "message must be trimmed");
  });

  it("rejects a non-JSON body", async () => {
    const { app } = makeApp();
    const res = await app.request("/api/chat", { method: "POST", body: "not json" });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error.code, "bad_request");
  });

  it("rejects empty and whitespace-only messages", async () => {
    const { app } = makeApp();
    for (const message of ["", "   ", undefined, 42]) {
      const res = await postJson(app, "/api/chat", { message });
      assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(message)}`);
    }
  });

  it("rejects messages over the length cap", async () => {
    const { app } = makeApp();
    const res = await postJson(app, "/api/chat", { message: "x".repeat(4001) });
    assert.equal(res.status, 400);
  });

  it("returns 409 while a turn is in progress", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const { app } = makeApp({ brain: () => gate });

    const first = await postJson(app, "/api/chat", { message: "one" });
    assert.equal(first.status, 202);
    const second = await postJson(app, "/api/chat", { message: "two" });
    assert.equal(second.status, 409);
    const body = await second.json();
    assert.equal(body.error.code, "turn_in_progress");
    release();
  });
});

describe("web app — /api/confirm", () => {
  it("resolves a pending confirmation", async () => {
    const { app, session } = makeApp({
      brain: async (confirm) => {
        const approved = await confirm("Cancel sub_gym_app?");
        assert.equal(approved, true);
      },
    });
    await postJson(app, "/api/chat", { message: "cancel it" });
    await waitFor(() => session.eventLog.some((e) => e.type === "confirm_request"));
    const { confirmId } = session.eventLog.find((e) => e.type === "confirm_request") as {
      confirmId: string;
    };

    const res = await postJson(app, "/api/confirm", { confirmId, approved: true });
    assert.equal(res.status, 200);
    await waitFor(() => session.eventLog.some((e) => e.type === "turn_complete"));
  });

  it("404s for an unknown or already-resolved id", async () => {
    const { app } = makeApp();
    const res = await postJson(app, "/api/confirm", { confirmId: "confirm_999", approved: true });
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.error.code, "confirm_not_pending");
  });

  it("rejects malformed bodies", async () => {
    const { app } = makeApp();
    const cases = [
      { confirmId: "", approved: true },
      { confirmId: "confirm_1" }, // missing approved
      { confirmId: "confirm_1", approved: "yes" }, // truthy string must NOT count
      { approved: true },
    ];
    for (const body of cases) {
      const res = await postJson(app, "/api/confirm", body);
      assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(body)}`);
    }
  });
});

describe("web app — /api/audit-log", () => {
  it("returns entries with per-entry signature verdicts", async () => {
    // A genuinely signed entry, built the way the enclave would.
    const priv = secp256k1.utils.randomSecretKey();
    const pub = secp256k1.getPublicKey(priv, false);
    const payload = JSON.stringify({ seq: 1, ts_secs: 1, action: "cancel", detail: {} });
    const signature = secp256k1.sign(keccak_256(new TextEncoder().encode(payload)), priv);
    const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

    const { app } = makeApp({
      fetchAuditLog: async () => ({
        entries: [
          {
            seq: 1, ts_secs: 1, action: "cancel", detail: {}, signed: true, payload,
            sig: {
              signature: `0x${hex(signature)}`,
              pubKey: { x: `0x${hex(pub.slice(1, 33))}`, y: `0x${hex(pub.slice(33))}` },
            },
          },
          { seq: 0, ts_secs: 0, action: "audit", detail: {}, signed: false,
            sign_error: "legacy-unsigned: written by a pre-signing contract version" },
        ],
      }),
    });

    const res = await app.request("/api/audit-log?limit=10");
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.entries[0].verification.status, "verified");
    assert.equal(body.entries[1].verification.status, "unsigned");
    assert.match(body.entries[1].verification.reason, /legacy-unsigned/);
  });

  it("rejects an out-of-range limit", async () => {
    const { app } = makeApp();
    for (const limit of ["0", "101", "abc", "1.5"]) {
      const res = await app.request(`/api/audit-log?limit=${limit}`);
      assert.equal(res.status, 400, `expected 400 for limit=${limit}`);
    }
  });

  it("maps an upstream failure to 502 with the reason", async () => {
    const { app } = makeApp({
      fetchAuditLog: async () => {
        throw new Error("egress_denied: host not authorized");
      },
    });
    const res = await app.request("/api/audit-log");
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.match(body.error.message, /egress_denied/);
  });

  it("maps an unexpected upstream shape to 502", async () => {
    const { app } = makeApp({ fetchAuditLog: async () => "garbage" });
    const res = await app.request("/api/audit-log");
    assert.equal(res.status, 502);
  });
});

describe("web app — events, state, static", () => {
  it("streams replayed events over SSE with ids", async () => {
    const { app, session } = makeApp();
    await session.send("hello"); // populate the log before connecting

    const res = await app.request("/api/events");
    assert.equal(res.headers.get("Content-Type"), "text/event-stream");
    const reader = res.body!.getReader();
    let text = "";
    while (!text.includes("turn_complete")) {
      const { value, done } = await reader.read();
      if (done) break;
      text += new TextDecoder().decode(value);
    }
    await reader.cancel();
    assert.match(text, /id: 1\n/);
    assert.match(text, /"type":"user_message"/);
    assert.match(text, /"type":"turn_complete"/);
  });

  it("resumes after Last-Event-ID without duplicating history", async () => {
    const { app, session } = makeApp();
    await session.send("hello");
    const lastId = session.eventLog.at(-1)!.id;

    const res = await app.request("/api/events", {
      headers: { "Last-Event-ID": String(lastId) },
    });
    const reader = res.body!.getReader();
    const { value } = await reader.read(); // first frame is the retry directive
    const first = new TextDecoder().decode(value);
    await reader.cancel();
    assert.doesNotMatch(first, /"type":"user_message"/, "old events must not be replayed");
  });

  it("exposes session state including busy", async () => {
    const { app } = makeApp();
    const res = await app.request("/api/state");
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.did, "did:t3n:test");
    assert.equal(body.contract.contractId, 33);
    assert.equal(body.busy, false);
  });

  it("serves the static UI and 500s clearly when an asset is missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "butler-web-"));
    await writeFile(join(dir, "index.html"), "<!doctype html><title>t</title>");
    const { app } = makeApp({ staticDir: `${dir}/` });

    const ok = await app.request("/");
    assert.equal(ok.status, 200);
    assert.match(ok.headers.get("Content-Type")!, /text\/html/);

    const missing = await app.request("/app.js");
    assert.equal(missing.status, 500);
    const body = await missing.json();
    assert.equal(body.error.code, "static_missing");
  });

  it("404s unknown routes with the uniform envelope", async () => {
    const { app } = makeApp();
    const res = await app.request("/api/nope");
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.error.code, "not_found");
  });
});

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}
