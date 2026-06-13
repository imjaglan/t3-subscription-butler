/**
 * Domain types for the mock billing API.
 *
 * This service stands in for a Stripe-like subscription processor. The agent
 * never holds the API secret required to call it — Terminal 3's enclave injects
 * the secret at send time via `http-with-placeholders`. The agent orchestrates
 * the call; the secret only ever materialises here, server-side.
 */

export type BillingCadence = "monthly" | "yearly";
export type SubscriptionStatus = "active" | "cancelled";

export interface Subscription {
  readonly id: string;
  readonly name: string;
  readonly category: string;
  /** Price in the smallest currency unit (cents) to avoid float rounding bugs. */
  readonly amountCents: number;
  /** ISO 4217 currency code, e.g. "USD". */
  readonly currency: string;
  readonly cadence: BillingCadence;
  status: SubscriptionStatus;
  /** ISO-8601 timestamp of the last successful charge, or null if never charged. */
  lastChargedAt: string | null;
  /**
   * Normalised usage signal in [0, 1]. Lower = more likely unused / cancellable.
   * The audit logic (later phase) reasons over this to recommend cancellations.
   */
  readonly usageScore: number;
}

export interface ChargeReceipt {
  readonly chargeId: string;
  readonly subscriptionId: string;
  readonly amountCents: number;
  readonly currency: string;
  readonly chargedAt: string;
  readonly status: "succeeded";
}

/**
 * Body the enclave sends with a charge. `cardToken` is REQUIRED — it lives in
 * the T3N secrets KV map and is injected inside the enclave, so its presence
 * here proves the agent could not have made this call on its own.
 * `receiptEmail` / `cardholderName` arrive resolved from `{{profile.*}}`
 * placeholders when the call is user-bound.
 */
export interface ChargeBody {
  readonly cardToken: string;
  readonly receiptEmail?: string;
  readonly cardholderName?: string;
}

/**
 * Receipt as served over HTTP: the stored receipt plus masked echoes of the
 * sensitive fields this request presented. Masked server-side so raw values
 * never round-trip back to the orchestrating agent.
 */
export interface ChargeResponse extends ChargeReceipt {
  /** e.g. "tok_••••7890" — proves the real token arrived, without leaking it. */
  readonly paidWith: string;
  readonly receiptEmailMasked?: string;
}

export interface CancelResult {
  readonly subscriptionId: string;
  readonly status: "cancelled";
  /** True when this call performed the cancellation; false if it was already cancelled. */
  readonly changed: boolean;
}

/** Uniform error envelope returned for every non-2xx response. */
export interface ErrorBody {
  readonly error: {
    readonly code: string;
    readonly message: string;
  };
}
