/**
 * Billing service configuration, loaded and validated from the environment.
 * Fails fast with a clear message rather than starting in a half-configured state.
 */
export interface BillingRuntimeConfig {
  readonly apiSecret: string;
  readonly port: number;
  /** Optional pinned card token — charges must present exactly this token. */
  readonly cardToken?: string;
}

export function loadBillingConfig(env: NodeJS.ProcessEnv = process.env): BillingRuntimeConfig {
  const apiSecret = env.BILLING_API_SECRET?.trim();
  if (!apiSecret) {
    throw new Error(
      "BILLING_API_SECRET is required. Set it in .env (see .env.example). " +
        "This is the secret the T3N enclave injects via http-with-placeholders.",
    );
  }

  const rawPort = env.BILLING_PORT?.trim() ?? "8787";
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`BILLING_PORT must be an integer in 1-65535, got "${rawPort}".`);
  }

  const cardToken = env.BILLING_CARD_TOKEN?.trim();
  if (cardToken !== undefined && cardToken !== "" && !/^tok_[A-Za-z0-9]{8,64}$/.test(cardToken)) {
    throw new Error("BILLING_CARD_TOKEN must match tok_<8-64 alphanumerics> when set.");
  }

  return { apiSecret, port, ...(cardToken ? { cardToken } : {}) };
}
