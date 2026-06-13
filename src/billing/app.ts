import { timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { BillingError } from "./errors.js";
import { SubscriptionStore } from "./store.js";
import type { ChargeBody, ChargeResponse, ErrorBody } from "./types.js";

export interface AppConfig {
  /**
   * The secret the caller must present as `Authorization: Bearer <secret>`.
   * In the real flow this is read from the T3N secrets KV map inside the
   * enclave; the agent never holds it. The mock verifies it so the demo can
   * *prove* the secret arrived without the agent ever seeing it.
   */
  readonly apiSecret: string;
  /**
   * When set, a charge's `cardToken` must equal this value exactly (the
   * "stored card" this mock vault knows about). Strengthens the demo: only
   * the enclave-held token — never anything the agent could invent — clears
   * a charge. When unset, any well-formed `tok_*` token is accepted.
   */
  readonly expectedCardToken?: string;
  readonly store?: SubscriptionStore;
}

/** Constant-time credential check — avoids leaking secret length/prefix via timing. */
function secretMatches(presented: string, expected: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function extractBearer(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}

const CARD_TOKEN_PATTERN = /^tok_[A-Za-z0-9]{8,64}$/;
// Deliberately loose — a mock processor validates shape, not deliverability.
const EMAIL_PATTERN = /^[^\s@]{1,64}@[^\s@]{1,255}$/;

/** "tok_abc1234567" -> "tok_••••4567". Never returns raw token material. */
function maskCardToken(token: string): string {
  return `tok_••••${token.slice(-4)}`;
}

/** "jane.doe@example.com" -> "j•••@example.com". */
function maskEmail(email: string): string {
  const at = email.indexOf("@");
  return `${email[0]}•••${email.slice(at)}`;
}

/**
 * Parse + validate the charge body. Throws BillingError with a stable code so
 * the contract (and agent) can branch without string-matching messages.
 */
async function readChargeBody(req: Request, expectedCardToken?: string): Promise<ChargeBody> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw BillingError.badRequest(
      "Charge requires a JSON body with a cardToken. The token lives in the T3N secrets map — the enclave injects it.",
    );
  }
  if (typeof raw !== "object" || raw === null) {
    throw BillingError.badRequest("Charge body must be a JSON object.");
  }
  const body = raw as Record<string, unknown>;

  const cardToken = typeof body.cardToken === "string" ? body.cardToken.trim() : "";
  if (!CARD_TOKEN_PATTERN.test(cardToken)) {
    throw BillingError.badRequest("cardToken is required and must match tok_<8-64 alphanumerics>.");
  }
  if (expectedCardToken !== undefined && !secretMatches(cardToken, expectedCardToken)) {
    throw new BillingError(402, "card_declined", "cardToken does not match any stored card.");
  }

  let receiptEmail: string | undefined;
  if (body.receiptEmail !== undefined) {
    if (typeof body.receiptEmail !== "string" || !EMAIL_PATTERN.test(body.receiptEmail)) {
      throw BillingError.badRequest("receiptEmail must be a plausible email address.");
    }
    receiptEmail = body.receiptEmail;
  }

  let cardholderName: string | undefined;
  if (body.cardholderName !== undefined) {
    if (typeof body.cardholderName !== "string" || body.cardholderName.length > 256) {
      throw BillingError.badRequest("cardholderName must be a string of at most 256 chars.");
    }
    cardholderName = body.cardholderName;
  }

  return { cardToken, receiptEmail, cardholderName };
}

/**
 * Builds the billing Hono app. Pure factory (no port binding) so tests can drive
 * it via `app.request(...)` without opening a socket.
 */
export function createApp(config: AppConfig): Hono {
  if (!config.apiSecret) {
    throw new Error("createApp: apiSecret is required and must be non-empty.");
  }
  const store = config.store ?? new SubscriptionStore();
  const app = new Hono();

  // Lightweight request log that NEVER prints the Authorization header.
  // (Reinforces the project's whole premise: secrets do not end up in logs.)
  app.use("*", async (c, next) => {
    const start = Date.now();
    await next();
    const ms = Date.now() - start;
    console.log(`${c.req.method} ${c.req.path} -> ${c.res.status} (${ms}ms)`);
  });

  // Unauthenticated health probe for readiness checks / demo sanity.
  app.get("/health", (c) => c.json({ status: "ok" }));

  // Auth gate for everything under /subscriptions.
  app.use("/subscriptions/*", async (c, next) => {
    const token = extractBearer(c.req.header("Authorization"));
    if (!token || !secretMatches(token, config.apiSecret)) {
      throw BillingError.unauthorized();
    }
    await next();
  });
  app.use("/subscriptions", async (c, next) => {
    const token = extractBearer(c.req.header("Authorization"));
    if (!token || !secretMatches(token, config.apiSecret)) {
      throw BillingError.unauthorized();
    }
    await next();
  });

  app.get("/subscriptions", (c) => c.json({ subscriptions: store.list() }));

  app.get("/subscriptions/:id", (c) => c.json(store.get(c.req.param("id"))));

  app.post("/subscriptions/:id/charge", async (c) => {
    const id = c.req.param("id");
    const idempotencyKey = c.req.header("Idempotency-Key") || undefined;
    const body = await readChargeBody(c.req.raw, config.expectedCardToken);

    const receipt = store.charge(id, idempotencyKey);
    // Masked echoes are presentation, derived from THIS request — never stored,
    // never returned raw. An idempotent replay re-masks what it presented.
    const response: ChargeResponse = {
      ...receipt,
      paidWith: maskCardToken(body.cardToken),
      ...(body.receiptEmail ? { receiptEmailMasked: maskEmail(body.receiptEmail) } : {}),
    };
    return c.json(response, 201);
  });

  app.post("/subscriptions/:id/cancel", (c) => {
    const result = store.cancel(c.req.param("id"));
    return c.json(result);
  });

  // Central error handling — uniform envelope, no leaked internals.
  app.onError((err, c) => {
    if (err instanceof BillingError) {
      const body: ErrorBody = { error: { code: err.code, message: err.message } };
      return c.json(body, err.status as 400 | 401 | 402 | 404 | 409);
    }
    console.error("Unhandled billing error:", err);
    const body: ErrorBody = {
      error: { code: "internal_error", message: "Unexpected server error." },
    };
    return c.json(body, 500);
  });

  app.notFound((c) => {
    const body: ErrorBody = {
      error: { code: "not_found", message: `No route for ${c.req.method} ${c.req.path}.` },
    };
    return c.json(body, 404);
  });

  return app;
}
