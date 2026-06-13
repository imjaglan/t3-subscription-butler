import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import type { Hono } from "hono";
import { createApp } from "./app.js";
import { SubscriptionStore } from "./store.js";

const SECRET = "test-secret-token";
const AUTH = { Authorization: `Bearer ${SECRET}` };

let app: Hono;
beforeEach(() => {
  // Fresh store per test so mutations (charge/cancel) never leak across cases.
  app = createApp({ apiSecret: SECRET, store: new SubscriptionStore() });
});

const get = (path: string, headers: Record<string, string> = {}) =>
  app.request(path, { headers });
const post = (path: string, headers: Record<string, string> = {}) =>
  app.request(path, { method: "POST", headers });

const CARD_TOKEN = "tok_test4242424242";
/** POST a charge with a JSON body (the shape the enclave contract sends). */
const charge = (
  path: string,
  headers: Record<string, string> = {},
  body: Record<string, unknown> = { cardToken: CARD_TOKEN },
) =>
  app.request(path, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

describe("billing API — auth", () => {
  it("health is public", async () => {
    const res = await get("/health");
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { status: "ok" });
  });

  it("rejects missing credential with 401", async () => {
    const res = await get("/subscriptions");
    assert.equal(res.status, 401);
    assert.equal((await res.json()).error.code, "unauthorized");
  });

  it("rejects wrong credential with 401", async () => {
    const res = await get("/subscriptions", { Authorization: "Bearer nope" });
    assert.equal(res.status, 401);
  });

  it("rejects a non-Bearer Authorization header", async () => {
    const res = await get("/subscriptions", { Authorization: SECRET });
    assert.equal(res.status, 401);
  });
});

describe("billing API — read", () => {
  it("lists seeded subscriptions when authorized", async () => {
    const res = await get("/subscriptions", AUTH);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.subscriptions));
    assert.equal(body.subscriptions.length, 6);
  });

  it("returns a single subscription by id", async () => {
    const res = await get("/subscriptions/sub_netflix", AUTH);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).name, "Netflix Premium");
  });

  it("404s for an unknown id", async () => {
    const res = await get("/subscriptions/sub_missing", AUTH);
    assert.equal(res.status, 404);
    assert.equal((await res.json()).error.code, "not_found");
  });
});

describe("billing API — charge", () => {
  it("charges an active subscription and returns a receipt with a masked token", async () => {
    const res = await charge("/subscriptions/sub_netflix/charge", AUTH);
    assert.equal(res.status, 201);
    const receipt = await res.json();
    assert.equal(receipt.subscriptionId, "sub_netflix");
    assert.equal(receipt.amountCents, 2299);
    assert.equal(receipt.status, "succeeded");
    assert.match(receipt.chargeId, /^ch_/);
    assert.equal(receipt.paidWith, "tok_••••4242");
    assert.ok(!JSON.stringify(receipt).includes(CARD_TOKEN), "raw token must never round-trip");
  });

  it("is idempotent when an Idempotency-Key is reused", async () => {
    const headers = { ...AUTH, "Idempotency-Key": "key-123" };
    const first = await (await charge("/subscriptions/sub_netflix/charge", headers)).json();
    const second = await (await charge("/subscriptions/sub_netflix/charge", headers)).json();
    assert.equal(first.chargeId, second.chargeId); // no double charge
  });

  it("rejects reusing an Idempotency-Key for a different subscription", async () => {
    const headers = { ...AUTH, "Idempotency-Key": "key-xyz" };
    await charge("/subscriptions/sub_netflix/charge", headers);
    const res = await charge("/subscriptions/sub_spotify/charge", headers);
    assert.equal(res.status, 409);
  });

  it("cannot charge a cancelled subscription (409)", async () => {
    await post("/subscriptions/sub_news/cancel", AUTH);
    const res = await charge("/subscriptions/sub_news/charge", AUTH);
    assert.equal(res.status, 409);
    assert.equal((await res.json()).error.code, "conflict");
  });

  it("404s when charging an unknown subscription", async () => {
    const res = await charge("/subscriptions/sub_missing/charge", AUTH);
    assert.equal(res.status, 404);
  });

  it("rejects a charge without a body (400)", async () => {
    const res = await post("/subscriptions/sub_netflix/charge", AUTH);
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, "bad_request");
  });

  it("rejects a malformed cardToken (400)", async () => {
    const res = await charge("/subscriptions/sub_netflix/charge", AUTH, { cardToken: "visa-1234" });
    assert.equal(res.status, 400);
  });

  it("rejects an implausible receiptEmail (400)", async () => {
    const res = await charge("/subscriptions/sub_netflix/charge", AUTH, {
      cardToken: CARD_TOKEN,
      receiptEmail: "not-an-email",
    });
    assert.equal(res.status, 400);
  });

  it("masks the receipt email in the response", async () => {
    const res = await charge("/subscriptions/sub_netflix/charge", AUTH, {
      cardToken: CARD_TOKEN,
      receiptEmail: "jane.doe@example.com",
    });
    assert.equal(res.status, 201);
    const receipt = await res.json();
    assert.equal(receipt.receiptEmailMasked, "j•••@example.com");
    assert.ok(!JSON.stringify(receipt).includes("jane.doe@"), "raw email must never round-trip");
  });

  it("declines a token that does not match the pinned card (402)", async () => {
    const pinned = createApp({
      apiSecret: SECRET,
      expectedCardToken: CARD_TOKEN,
      store: new SubscriptionStore(),
    });
    const ok = await pinned.request("/subscriptions/sub_netflix/charge", {
      method: "POST",
      headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({ cardToken: CARD_TOKEN }),
    });
    assert.equal(ok.status, 201);

    const declined = await pinned.request("/subscriptions/sub_spotify/charge", {
      method: "POST",
      headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({ cardToken: "tok_attacker99999" }),
    });
    assert.equal(declined.status, 402);
    assert.equal((await declined.json()).error.code, "card_declined");
  });
});

describe("billing API — cancel", () => {
  it("cancels an active subscription (changed=true)", async () => {
    const res = await post("/subscriptions/sub_gym_app/cancel", AUTH);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      subscriptionId: "sub_gym_app",
      status: "cancelled",
      changed: true,
    });
  });

  it("is idempotent — second cancel reports changed=false", async () => {
    await post("/subscriptions/sub_gym_app/cancel", AUTH);
    const res = await post("/subscriptions/sub_gym_app/cancel", AUTH);
    assert.equal((await res.json()).changed, false);
  });

  it("404s when cancelling an unknown subscription", async () => {
    const res = await post("/subscriptions/sub_missing/cancel", AUTH);
    assert.equal(res.status, 404);
  });
});

describe("billing API — routing", () => {
  it("404s unknown routes with the error envelope", async () => {
    const res = await get("/nope", AUTH);
    assert.equal(res.status, 404);
    assert.equal((await res.json()).error.code, "not_found");
  });
});

describe("createApp — guard", () => {
  it("throws when apiSecret is empty", () => {
    assert.throws(() => createApp({ apiSecret: "" }), /apiSecret is required/);
  });
});
