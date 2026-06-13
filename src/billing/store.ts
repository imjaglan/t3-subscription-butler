import { randomUUID } from "node:crypto";
import { BillingError } from "./errors.js";
import type { CancelResult, ChargeReceipt, Subscription } from "./types.js";

/**
 * In-memory subscription store. Pure of any HTTP concern so it can be unit
 * tested in isolation and re-seeded deterministically per test run.
 *
 * Concurrency note: Node runs this single-threaded, and every operation here is
 * synchronous (no `await` between read and write), so there is no interleaving /
 * lost-update window. If this ever moved to a real async datastore, charge and
 * cancel would need row-level locking or a compare-and-set.
 */
export class SubscriptionStore {
  private readonly subs = new Map<string, Subscription>();
  /** Idempotency cache: key -> receipt, so a retried charge never double-bills. */
  private readonly chargeIdempotency = new Map<string, ChargeReceipt>();

  constructor(seed: readonly Subscription[] = DEFAULT_SEED) {
    for (const s of seed) {
      // Defensive copy so external mutation of the seed array can't leak in.
      this.subs.set(s.id, { ...s });
    }
  }

  list(): Subscription[] {
    return [...this.subs.values()].map((s) => ({ ...s }));
  }

  get(id: string): Subscription {
    const sub = this.subs.get(id);
    if (!sub) throw BillingError.notFound(`No subscription with id "${id}".`);
    return { ...sub };
  }

  /**
   * Charge a subscription. Idempotent when an `idempotencyKey` is supplied:
   * the same key returns the original receipt instead of charging again.
   */
  charge(id: string, idempotencyKey?: string): ChargeReceipt {
    if (idempotencyKey) {
      const prior = this.chargeIdempotency.get(idempotencyKey);
      if (prior) {
        if (prior.subscriptionId !== id) {
          throw BillingError.conflict(
            "Idempotency-Key already used for a different subscription.",
          );
        }
        return prior;
      }
    }

    const sub = this.subs.get(id);
    if (!sub) throw BillingError.notFound(`No subscription with id "${id}".`);
    if (sub.status === "cancelled") {
      throw BillingError.conflict(`Subscription "${id}" is cancelled and cannot be charged.`);
    }

    const chargedAt = new Date().toISOString();
    const receipt: ChargeReceipt = {
      chargeId: `ch_${randomUUID()}`,
      subscriptionId: id,
      amountCents: sub.amountCents,
      currency: sub.currency,
      chargedAt,
      status: "succeeded",
    };

    sub.lastChargedAt = chargedAt;
    if (idempotencyKey) this.chargeIdempotency.set(idempotencyKey, receipt);
    return receipt;
  }

  /** Cancel a subscription. Idempotent: cancelling an already-cancelled sub succeeds. */
  cancel(id: string): CancelResult {
    const sub = this.subs.get(id);
    if (!sub) throw BillingError.notFound(`No subscription with id "${id}".`);

    const changed = sub.status === "active";
    sub.status = "cancelled";
    return { subscriptionId: id, status: "cancelled", changed };
  }
}

/**
 * Seed data crafted so the audit logic has clear signal: obvious dead weight
 * (low usageScore), an active-but-used core, and a duplicate-category pair.
 */
export const DEFAULT_SEED: readonly Subscription[] = [
  {
    id: "sub_netflix",
    name: "Netflix Premium",
    category: "streaming",
    amountCents: 2299,
    currency: "USD",
    cadence: "monthly",
    status: "active",
    lastChargedAt: "2026-05-15T00:00:00.000Z",
    usageScore: 0.82,
  },
  {
    id: "sub_spotify",
    name: "Spotify Family",
    category: "music",
    amountCents: 1699,
    currency: "USD",
    cadence: "monthly",
    status: "active",
    lastChargedAt: "2026-05-20T00:00:00.000Z",
    usageScore: 0.74,
  },
  {
    id: "sub_gym_app",
    name: "PelotonGo Fitness",
    category: "fitness",
    amountCents: 1299,
    currency: "USD",
    cadence: "monthly",
    status: "active",
    lastChargedAt: "2026-05-01T00:00:00.000Z",
    usageScore: 0.04, // never opened since January — prime cancellation candidate
  },
  {
    id: "sub_cloud_a",
    name: "Dropbox Plus 2TB",
    category: "cloud-storage",
    amountCents: 1199,
    currency: "USD",
    cadence: "monthly",
    status: "active",
    lastChargedAt: "2026-05-10T00:00:00.000Z",
    usageScore: 0.21, // duplicate of cloud-storage with iCloud below
  },
  {
    id: "sub_cloud_b",
    name: "iCloud+ 2TB",
    category: "cloud-storage",
    amountCents: 999,
    currency: "USD",
    cadence: "monthly",
    status: "active",
    lastChargedAt: "2026-05-10T00:00:00.000Z",
    usageScore: 0.68,
  },
  {
    id: "sub_news",
    name: "The Daily Times Digital",
    category: "news",
    amountCents: 799,
    currency: "USD",
    cadence: "monthly",
    status: "active",
    lastChargedAt: "2026-04-28T00:00:00.000Z",
    usageScore: 0.09, // forgotten free-trial-turned-paid
  },
];
