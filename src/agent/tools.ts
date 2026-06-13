import type Anthropic from "@anthropic-ai/sdk";
import type { ButlerFunction } from "./invoker.js";

/** Minimal contract-invoker surface — structural so tests can supply a fake. */
interface InvokerLike {
  invoke(fn: ButlerFunction, input?: unknown): Promise<unknown>;
}

/**
 * Claude tool surface for the Butler. Each tool maps 1:1 to a contract
 * function. Mutating tools (cancel, charge) are flagged so the chat loop can
 * gate them behind a human confirmation — the model proposes, the user
 * approves, the contract acts.
 */
export interface ButlerTool {
  readonly definition: Anthropic.Tool;
  readonly fn: ButlerFunction;
  /** True for state-changing calls that require explicit user confirmation. */
  readonly mutating: boolean;
  /** Map validated tool input → contract input. */
  buildInput(args: Record<string, unknown>): unknown;
}

const auditTool: ButlerTool = {
  fn: "audit-subscriptions",
  mutating: false,
  buildInput: (a) =>
    a.monthly_budget_cents !== undefined
      ? { monthly_budget_cents: a.monthly_budget_cents }
      : {},
  definition: {
    name: "audit_subscriptions",
    description:
      "Fetch the live subscription list and analyse it: dead-weight (unused) subscriptions, " +
      "duplicate categories, and budget overrun. Read-only — safe to call any time. " +
      "Call this before recommending cancellations.",
    input_schema: {
      type: "object",
      properties: {
        monthly_budget_cents: {
          type: "integer",
          minimum: 0,
          description:
            "Optional monthly budget in USD cents. When set, the audit flags the lowest-value subscriptions if the active total exceeds it.",
        },
      },
      required: [],
      additionalProperties: false,
    },
  },
};

const cancelTool: ButlerTool = {
  fn: "cancel-subscription",
  mutating: true,
  buildInput: (a) => ({ subscription_id: a.subscription_id }),
  definition: {
    name: "cancel_subscription",
    description:
      "Cancel ONE subscription via the billing API. State-changing and must be confirmed by the user first. " +
      "Idempotent server-side: cancelling an already-cancelled subscription succeeds with changed=false.",
    input_schema: {
      type: "object",
      properties: {
        subscription_id: {
          type: "string",
          pattern: "^[A-Za-z0-9_.-]{1,128}$",
          description: "The subscription id, e.g. sub_gym_app.",
        },
      },
      required: ["subscription_id"],
      additionalProperties: false,
    },
  },
};

const chargeTool: ButlerTool = {
  fn: "charge-subscription",
  mutating: true,
  buildInput: (a) => ({
    subscription_id: a.subscription_id,
    idempotency_key: a.idempotency_key,
    ...(a.email_receipt_to_profile !== undefined
      ? { email_receipt_to_profile: a.email_receipt_to_profile }
      : {}),
  }),
  definition: {
    name: "charge_subscription",
    description:
      "Charge ONE subscription. The card token is read inside the enclave — never supplied here. " +
      "State-changing and must be confirmed by the user first. The idempotency_key makes a retried " +
      "charge safe (the same key never double-bills). Set email_receipt_to_profile to email a receipt " +
      "resolved from the user's profile inside the enclave (requires a user-bound call).",
    input_schema: {
      type: "object",
      properties: {
        subscription_id: {
          type: "string",
          pattern: "^[A-Za-z0-9_.-]{1,128}$",
          description: "The subscription id, e.g. sub_netflix.",
        },
        idempotency_key: {
          type: "string",
          pattern: "^[A-Za-z0-9_-]{1,64}$",
          description: "Unique key for this charge attempt; reuse it verbatim to retry safely.",
        },
        email_receipt_to_profile: {
          type: "boolean",
          description: "Email a receipt to the user's profile address, resolved inside the enclave.",
        },
      },
      required: ["subscription_id", "idempotency_key"],
      additionalProperties: false,
    },
  },
};

const auditLogTool: ButlerTool = {
  fn: "get-audit-log",
  mutating: false,
  buildInput: (a) => (a.limit !== undefined ? { limit: a.limit } : {}),
  definition: {
    name: "get_audit_log",
    description:
      "Read the tamper-evident audit trail of actions this agent has taken (newest first). Read-only.",
    input_schema: {
      type: "object",
      properties: {
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 100,
          description: "How many entries to return (default 20).",
        },
      },
      required: [],
      additionalProperties: false,
    },
  },
};

export const BUTLER_TOOLS: readonly ButlerTool[] = [
  auditTool,
  cancelTool,
  chargeTool,
  auditLogTool,
];

const BY_NAME = new Map(BUTLER_TOOLS.map((t) => [t.definition.name, t]));

export function toolByName(name: string): ButlerTool | undefined {
  return BY_NAME.get(name);
}

export function toolDefinitions(): Anthropic.Tool[] {
  return BUTLER_TOOLS.map((t) => t.definition);
}

/**
 * Execute one tool call against the contract. Confirmation gating is the
 * caller's responsibility (see chat loop) — by the time this runs, a mutating
 * call has already been approved.
 */
export async function runTool(
  invoker: InvokerLike,
  tool: ButlerTool,
  args: Record<string, unknown>,
): Promise<unknown> {
  return invoker.invoke(tool.fn, tool.buildInput(args));
}
