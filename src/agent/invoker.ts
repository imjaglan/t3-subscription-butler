import { parseContractResponse } from "@terminal3/t3n-sdk";
import { initT3n, initT3nWithKey, type T3nSession } from "../t3n.js";
import { readDeployState, type DeployState } from "../ops/state.js";

/**
 * Contract invoker with two principals:
 *
 *  - "tenant": the data owner's own session (`tenant.contracts.execute`).
 *  - "agent":  the Butler's OWN DID — a separate ETH key. Calls go through the
 *    base client with the full script name; the node enforces the on-chain
 *    `agent-auth-update` grant per call (functions + egress hosts). The
 *    scoped demo grants the agent everything except charge-subscription, so
 *    a charge attempt is refused BY THE NETWORK, not by app code.
 *
 * No automatic retries: cancel/charge are mutations. The billing API's
 * Idempotency-Key (caller-supplied on charge) is the safe retry mechanism.
 */
export type Principal = "tenant" | "agent";

export type ButlerFunction =
  | "audit-subscriptions"
  | "cancel-subscription"
  | "charge-subscription"
  | "get-audit-log";

export class ButlerInvoker {
  private constructor(
    private readonly session: T3nSession,
    private readonly state: DeployState,
    readonly principal: Principal,
  ) {}

  static async create(principal: Principal): Promise<ButlerInvoker> {
    const state = await readDeployState();
    if (!state) {
      throw new Error("No .butler-deploy.json — run `npm run deploy` first.");
    }
    if (principal === "tenant") {
      return new ButlerInvoker(await initT3n(), state, principal);
    }
    const agentKey = process.env.AGENT_T3N_KEY?.trim();
    if (!agentKey) {
      throw new Error("AGENT_T3N_KEY missing — run `npm run agent:setup` first.");
    }
    return new ButlerInvoker(await initT3nWithKey(agentKey), state, principal);
  }

  get did(): string {
    return this.session.tenantDid;
  }

  /** Full canonical script name, e.g. z:<tid>:subscription-butler. */
  private get scriptName(): string {
    return `z:${this.state.tenantDid.slice("did:t3n:".length)}:${this.state.tail}`;
  }

  async invoke(functionName: ButlerFunction, input?: unknown): Promise<unknown> {
    const raw =
      this.principal === "tenant"
        ? await this.session.tenant.contracts.execute(this.state.tail, {
            version: this.state.version,
            functionName,
            ...(input !== undefined ? { input } : {}),
          })
        : await this.session.t3n.execute({
            script_name: this.scriptName,
            script_version: this.state.version,
            function_name: functionName,
            ...(input !== undefined ? { input } : {}),
          });

    return typeof raw === "string" && raw.length > 0 ? parseContractResponse(raw) : raw;
  }
}
