import Anthropic from "@anthropic-ai/sdk";
import type { ButlerInvoker } from "./invoker.js";
import { runTool, toolByName, toolDefinitions } from "./tools.js";

/**
 * The Butler chat brain: a manual Claude agentic loop with human-in-the-loop
 * confirmation for state-changing tools.
 *
 * Design choices:
 *  - Manual loop (not the tool runner) because mutating tools must pause for
 *    explicit user approval before they touch money.
 *  - `confirm` is injected so the same brain drives a CLI today and a web UI
 *    later without change.
 *  - History is retained across turns; the model sees prior tool results.
 */

export const DEFAULT_MODEL = "claude-opus-4-8";
const MAX_TOKENS = 4096;
const MAX_TOOL_ITERATIONS = 8; // safety bound on a single user turn

const SYSTEM_PROMPT = `You are Subscription Butler, an agent that audits, cancels, and charges a user's paid subscriptions through a billing API running inside Terminal 3's confidential-computing enclave.

Key facts about how you operate:
- You never see the billing API secret or the card token. They live sealed in the enclave's KV store; the enclave injects them into outbound calls. You orchestrate; you never hold the secret.
- Before recommending cancellations, call audit_subscriptions and reason over its output (dead-weight, duplicates, budget).
- cancel_subscription and charge_subscription change state and spend money. A system-level approval gate intercepts EVERY such call and shows the user an approve/deny button BEFORE it runs — that gate IS the confirmation. Do NOT ask the user to type a confirmation word or phrase, and do NOT wait for a second "yes": once the user has said which subscription(s) to act on, CALL THE TOOL DIRECTLY (one call per subscription) and let the gate handle approval. If the user denies, you'll get a "denied-by-user" error — acknowledge it and ask what they'd like instead; never retry a denied action. In your proposal name each subscription and its dollar impact, and never batch-cancel without naming each one.
- Subscription ids look like sub_<service> (e.g. sub_spotify, sub_netflix, sub_gym_app). When the user names a subscription in words, prefer an id you already saw in a prior audit; otherwise infer the obvious id from the name (Spotify → sub_spotify) and call the tool — the approval gate shows the user the exact id before any money moves, and a wrong id fails safely with a not-found error. Do not ask the user for the id when you can reasonably infer it.
- charge_subscription requires an idempotency_key: generate a short unique one yourself (e.g. the subscription id plus today's date). Set email_receipt_to_profile: true when the user asks for a receipt.
- Money amounts come back in cents — convert to dollars when talking to the user.
- Be concise and direct. When you've completed what was asked, say so plainly; don't pad with "want me to also…".

When a tool returns an error, read it: errors are prefixed (bad-input, not-found, conflict, config, upstream, denied). Explain what happened in plain language and suggest the fix, rather than blindly retrying.`;

/** Abstraction over "ask the user to approve this action". */
export type Confirmer = (summary: string) => Promise<boolean>;

/** Sink for streamed assistant text + status lines. */
export interface ChatUI {
  assistantText(text: string): void;
  status(line: string): void;
  toolDenied(name: string): void;
  /**
   * Optional structured hooks (the web UI renders tool activity from these;
   * the CLI relies on the status lines alone). Called in addition to, not
   * instead of, `status`.
   */
  toolCall?(name: string, args: Record<string, unknown>): void;
  toolResult?(name: string, result: unknown): void;
}

/** The slice of the Anthropic client the brain depends on (injectable for tests). */
export interface MessagesClient {
  messages: { create(body: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message> };
}

/** Anything the brain needs from the contract side (injectable for tests). */
export interface ContractInvoker {
  invoke(fn: import("./invoker.js").ButlerFunction, input?: unknown): Promise<unknown>;
}

export interface ButlerBrainOptions {
  /** Inject a client (real or fake). Defaults to a real Anthropic client from ANTHROPIC_API_KEY. */
  readonly client?: MessagesClient;
  readonly apiKey?: string;
  /** Model id sent on every request. Set by the provider layer for non-Claude clients. */
  readonly model?: string;
}

export class ButlerBrain {
  private readonly client: MessagesClient;
  private readonly model: string;
  private readonly messages: Anthropic.MessageParam[] = [];

  constructor(
    private readonly invoker: ContractInvoker,
    private readonly confirm: Confirmer,
    private readonly ui: ChatUI,
    options: ButlerBrainOptions = {},
  ) {
    this.model = options.model ?? DEFAULT_MODEL;
    if (options.client) {
      this.client = options.client;
      return;
    }
    const apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error(
        "ANTHROPIC_API_KEY missing — set it in .env to run the chat brain, or set LLM_PROVIDER=ollama to use a local model.",
      );
    }
    this.client = new Anthropic({ apiKey });
  }

  /** Handle one user turn end-to-end (may involve several tool round-trips). */
  async send(userMessage: string): Promise<void> {
    this.messages.push({ role: "user", content: userMessage });

    for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: MAX_TOKENS,
        thinking: { type: "adaptive" },
        system: SYSTEM_PROMPT,
        tools: toolDefinitions(),
        messages: this.messages,
      });

      this.messages.push({ role: "assistant", content: response.content });

      for (const block of response.content) {
        if (block.type === "text" && block.text.trim()) {
          this.ui.assistantText(block.text);
        }
      }

      if (response.stop_reason !== "tool_use") {
        if (response.stop_reason === "refusal") {
          this.ui.status("(The model declined to respond to that request.)");
        }
        return;
      }

      const toolUses = response.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
      );
      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const use of toolUses) {
        toolResults.push(await this.executeToolUse(use));
      }
      this.messages.push({ role: "user", content: toolResults });
    }

    this.ui.status(
      `(Stopped after ${MAX_TOOL_ITERATIONS} tool steps without finishing — ask me to continue if needed.)`,
    );
  }

  private async executeToolUse(
    use: Anthropic.ToolUseBlock,
  ): Promise<Anthropic.ToolResultBlockParam> {
    const tool = toolByName(use.name);
    if (!tool) {
      return this.errorResult(use.id, `bad-input: unknown tool "${use.name}"`);
    }
    const args = (use.input ?? {}) as Record<string, unknown>;

    if (tool.mutating) {
      const approved = await this.confirm(this.describeAction(use.name, args));
      if (!approved) {
        this.ui.toolDenied(use.name);
        // Feed the denial back so the model adjusts instead of assuming success.
        return this.errorResult(
          use.id,
          "denied-by-user: the user did not approve this action. Do not retry it; ask what they'd like to do instead.",
        );
      }
    }

    this.ui.status(`→ ${use.name} ${JSON.stringify(args)}`);
    this.ui.toolCall?.(use.name, args);
    try {
      const result = await runTool(this.invoker, tool, args);
      this.ui.toolResult?.(use.name, result);
      return {
        type: "tool_result",
        tool_use_id: use.id,
        content: JSON.stringify(result),
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.ui.status(`✖ ${use.name} failed: ${msg}`);
      return this.errorResult(use.id, msg);
    }
  }

  private errorResult(id: string, message: string): Anthropic.ToolResultBlockParam {
    return { type: "tool_result", tool_use_id: id, content: message, is_error: true };
  }

  private describeAction(name: string, args: Record<string, unknown>): string {
    if (name === "cancel_subscription") {
      return `Cancel subscription "${args.subscription_id}"?`;
    }
    if (name === "charge_subscription") {
      const receipt = args.email_receipt_to_profile ? " and email a receipt" : "";
      return `Charge subscription "${args.subscription_id}"${receipt}?`;
    }
    return `Run ${name} with ${JSON.stringify(args)}?`;
  }
}
