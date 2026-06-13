import type Anthropic from "@anthropic-ai/sdk";
import type { MessagesClient } from "./brain.js";

/**
 * Local-model adapter: implements the brain's `MessagesClient` slice against
 * an Ollama server's OpenAI-compatible endpoint (`/v1/chat/completions`).
 * The brain keeps speaking Anthropic shapes; this file owns the translation
 * in both directions, so swapping providers never touches the agent loop or
 * the confirmation gate.
 *
 * Failure policy: a chat completion is read-only — tool EXECUTION happens in
 * the brain after this returns — so one retry on transient failures (network
 * errors, 5xx, malformed tool-call JSON from a flaky local model) is safe and
 * never double-spends anything. Timeouts are not retried: the budget is
 * already generous and a second wait would double it.
 */

export interface OllamaConfig {
  /** Server origin WITHOUT /v1, e.g. http://localhost:11434 */
  readonly baseUrl: string;
  /** Model tag as shown by `ollama list`. Must support tool calling. */
  readonly model: string;
  /** Per-attempt request timeout. Local models can be slow on first load. */
  readonly timeoutMs: number;
  /** Pause before the single retry; overridable so tests don't sleep. */
  readonly retryDelayMs?: number;
}

const DEFAULT_BASE_URL = "http://localhost:11434";
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_RETRY_DELAY_MS = 500;
const MAX_RETRIES = 1;
const ERROR_EXCERPT_LIMIT = 300;

export class OllamaError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message);
    this.name = "OllamaError";
  }
}

/**
 * Build a validated config from the environment. Throws with an actionable
 * message on anything missing or malformed — misconfiguration must fail at
 * startup, not mid-conversation.
 */
export function ollamaConfigFromEnv(env: NodeJS.ProcessEnv = process.env): OllamaConfig {
  const model = env.OLLAMA_MODEL?.trim();
  if (!model) {
    throw new Error(
      'OLLAMA_MODEL is not set — set it to a tool-calling-capable model from "ollama list" (e.g. OLLAMA_MODEL=gemma4).',
    );
  }

  const rawUrl = env.OLLAMA_BASE_URL?.trim() || DEFAULT_BASE_URL;
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`OLLAMA_BASE_URL is not a valid URL: "${rawUrl}".`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`OLLAMA_BASE_URL must be http(s), got "${parsed.protocol}//".`);
  }
  // Accept both ...:11434 and ...:11434/v1 (with or without trailing slash).
  const baseUrl = parsed.toString().replace(/\/+$/, "").replace(/\/v1$/, "");

  let timeoutMs = DEFAULT_TIMEOUT_MS;
  const rawTimeout = env.OLLAMA_TIMEOUT_MS?.trim();
  if (rawTimeout) {
    const n = Number(rawTimeout);
    if (!Number.isInteger(n) || n <= 0) {
      throw new Error(`OLLAMA_TIMEOUT_MS must be a positive integer (milliseconds), got "${rawTimeout}".`);
    }
    timeoutMs = n;
  }

  return { baseUrl, model, timeoutMs };
}

// ── OpenAI-compatible wire shapes (the subset we use) ────────────────────────

interface WireToolCall {
  id?: string;
  function?: { name?: unknown; arguments?: unknown };
}

interface WireMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
}

interface WireRequest {
  model: string;
  max_tokens: number;
  messages: WireMessage[];
  tools?: Array<{ type: "function"; function: { name: string; description?: string; parameters: unknown } }>;
}

export class OllamaMessagesClient implements MessagesClient {
  readonly messages = { create: (body: Anthropic.MessageCreateParamsNonStreaming) => this.create(body) };

  private readonly retryDelayMs: number;
  private toolUseSeq = 0;

  constructor(
    private readonly config: OllamaConfig,
    private readonly fetchFn: typeof fetch = fetch,
  ) {
    this.retryDelayMs = config.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  }

  private async create(body: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message> {
    const request = this.toWire(body);
    for (let attempt = 0; ; attempt++) {
      try {
        return this.toMessage(await this.post(request));
      } catch (err) {
        const retryable = err instanceof OllamaError && err.retryable;
        if (!retryable || attempt >= MAX_RETRIES) throw err;
        await sleep(this.retryDelayMs);
      }
    }
  }

  // ── Anthropic params → OpenAI-compatible request ──────────────────────────

  private toWire(body: Anthropic.MessageCreateParamsNonStreaming): WireRequest {
    const messages: WireMessage[] = [];

    const system = typeof body.system === "string"
      ? body.system
      : body.system?.filter((b) => b.type === "text").map((b) => b.text).join("\n");
    if (system) messages.push({ role: "system", content: system });

    for (const m of body.messages) {
      if (typeof m.content === "string") {
        messages.push({ role: m.role, content: m.content });
        continue;
      }
      if (m.role === "assistant") {
        messages.push(...this.assistantTurn(m.content));
      } else {
        messages.push(...this.userTurn(m.content));
      }
    }

    // Only plain custom tools exist in this app; guard anyway so a future
    // server-tool entry fails loudly here rather than confusing the server.
    const tools = (body.tools ?? []).map((t) => {
      if (!("input_schema" in t)) {
        throw new OllamaError(`Unsupported tool type for the Ollama provider: "${t.name}".`, false);
      }
      return {
        type: "function" as const,
        function: { name: t.name, description: t.description, parameters: t.input_schema },
      };
    });

    return {
      model: this.config.model, // the brain's default model id is Anthropic-specific — always override
      max_tokens: body.max_tokens,
      messages,
      ...(tools.length ? { tools } : {}),
    };
  }

  private assistantTurn(blocks: Anthropic.ContentBlockParam[]): WireMessage[] {
    const texts: string[] = [];
    const toolCalls: NonNullable<WireMessage["tool_calls"]> = [];
    for (const b of blocks) {
      if (b.type === "text") texts.push(b.text);
      else if (b.type === "tool_use") {
        toolCalls.push({
          id: b.id,
          type: "function",
          function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
        });
      }
      // thinking/redacted_thinking are provider-internal — never re-sent.
    }
    if (!texts.length && !toolCalls.length) return [];
    return [{
      role: "assistant",
      content: texts.length ? texts.join("\n") : null,
      ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
    }];
  }

  private userTurn(blocks: Anthropic.ContentBlockParam[]): WireMessage[] {
    // Tool results must directly follow the assistant tool_calls turn in the
    // OpenAI shape, so they are emitted before any user text in this turn.
    const toolMessages: WireMessage[] = [];
    const texts: string[] = [];
    for (const b of blocks) {
      if (b.type === "tool_result") {
        toolMessages.push({
          role: "tool",
          tool_call_id: b.tool_use_id,
          content: toolResultText(b),
        });
      } else if (b.type === "text") {
        texts.push(b.text);
      }
    }
    return texts.length ? [...toolMessages, { role: "user", content: texts.join("\n") }] : toolMessages;
  }

  // ── HTTP ───────────────────────────────────────────────────────────────────

  private async post(request: WireRequest): Promise<unknown> {
    const url = `${this.config.baseUrl}/v1/chat/completions`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      let res: Response;
      try {
        res = await this.fetchFn(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(request),
          signal: controller.signal,
        });
      } catch (err) {
        if (controller.signal.aborted) {
          throw new OllamaError(
            `Ollama request timed out after ${this.config.timeoutMs}ms — local models can be slow on first load; raise OLLAMA_TIMEOUT_MS or use a smaller model.`,
            false,
          );
        }
        throw new OllamaError(
          `Cannot reach Ollama at ${this.config.baseUrl} — is "ollama serve" running? (${errMessage(err)})`,
          true,
        );
      }

      if (!res.ok) throw await this.httpError(res);

      try {
        return await res.json();
      } catch {
        // A half-written body is as transient as a 5xx — worth the one retry.
        throw new OllamaError(`Ollama returned a non-JSON response (HTTP ${res.status}).`, true);
      }
    } finally {
      clearTimeout(timer);
    }
  }

  private async httpError(res: Response): Promise<OllamaError> {
    const detail = await errorDetail(res);
    const suffix = detail ? ` — ${detail}` : "";
    if (res.status === 404) {
      return new OllamaError(
        `Ollama returned 404 for model "${this.config.model}" — pull it with "ollama pull ${this.config.model}" or pick one from "ollama list"${suffix}`,
        false,
      );
    }
    if (res.status >= 500) {
      return new OllamaError(`Ollama server error (HTTP ${res.status})${suffix}`, true);
    }
    const toolHint = res.status === 400 && /tool/i.test(detail)
      ? ' (the model\'s template may not support tool calling — the Butler requires a tool-capable model)'
      : "";
    return new OllamaError(`Ollama rejected the request (HTTP ${res.status})${suffix}${toolHint}`, false);
  }

  // ── OpenAI-compatible response → Anthropic.Message ────────────────────────

  private toMessage(payload: unknown): Anthropic.Message {
    const choice = firstChoice(payload);
    const message = choice.message;

    const content: unknown[] = [];
    if (typeof message.content === "string" && message.content.trim()) {
      content.push({ type: "text", text: message.content, citations: null });
    }

    const toolCalls = Array.isArray(message.tool_calls) ? (message.tool_calls as WireToolCall[]) : [];
    for (const tc of toolCalls) {
      const name = tc.function?.name;
      if (typeof name !== "string" || !name) {
        throw new OllamaError(`Model "${this.config.model}" emitted a tool call without a name.`, true);
      }
      content.push({
        type: "tool_use",
        id: tc.id || `toolu_local_${++this.toolUseSeq}`,
        name,
        input: this.parseToolArguments(name, tc.function?.arguments),
      });
    }

    // Local models are sloppy about finish_reason; presence of tool calls is
    // the truth the brain's gate must act on, so it wins.
    const finishReason = typeof choice.finish_reason === "string" ? choice.finish_reason : "";
    const stopReason = toolCalls.length ? "tool_use" : finishReason === "length" ? "max_tokens" : "end_turn";

    const usage = usageOf(payload);
    // Minimal Message — exactly the fields the brain reads. The SDK type also
    // carries streaming/billing fields that have no meaning for a local server.
    return {
      id: `msg_local_${++this.toolUseSeq}`,
      type: "message",
      role: "assistant",
      model: this.config.model,
      content,
      stop_reason: stopReason,
      stop_sequence: null,
      usage,
    } as unknown as Anthropic.Message;
  }

  private parseToolArguments(toolName: string, raw: unknown): Record<string, unknown> {
    if (raw == null || raw === "") return {};
    if (typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>; // some servers pre-parse
    if (typeof raw !== "string") {
      throw new OllamaError(`Model "${this.config.model}" emitted non-string arguments for tool "${toolName}".`, true);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new OllamaError(
        `Model "${this.config.model}" emitted malformed JSON for tool "${toolName}": ${truncate(raw)}`,
        true,
      );
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new OllamaError(
        `Model "${this.config.model}" emitted non-object arguments for tool "${toolName}": ${truncate(raw)}`,
        true,
      );
    }
    return parsed as Record<string, unknown>;
  }
}

// ── helpers ───────────────────────────────────────────────────────────────────

function toolResultText(b: Anthropic.ToolResultBlockParam): string {
  const text = typeof b.content === "string"
    ? b.content
    : (b.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
  // OpenAI tool messages have no is_error flag — keep the signal in-band.
  return b.is_error ? `[tool error] ${text}` : text;
}

function firstChoice(payload: unknown): { message: { content?: unknown; tool_calls?: unknown }; finish_reason?: unknown } {
  if (payload && typeof payload === "object") {
    const choices = (payload as { choices?: unknown }).choices;
    if (Array.isArray(choices) && choices.length > 0) {
      const first = choices[0] as { message?: unknown; finish_reason?: unknown };
      if (first.message && typeof first.message === "object") {
        return first as ReturnType<typeof firstChoice>;
      }
    }
  }
  throw new OllamaError(`Ollama response had no choices/message: ${truncate(JSON.stringify(payload))}`, true);
}

function usageOf(payload: unknown): { input_tokens: number; output_tokens: number } {
  const u = (payload as { usage?: { prompt_tokens?: unknown; completion_tokens?: unknown } }).usage;
  return {
    input_tokens: typeof u?.prompt_tokens === "number" ? u.prompt_tokens : 0,
    output_tokens: typeof u?.completion_tokens === "number" ? u.completion_tokens : 0,
  };
}

async function errorDetail(res: Response): Promise<string> {
  try {
    const text = await res.text();
    if (!text) return "";
    try {
      const parsed = JSON.parse(text) as { error?: { message?: unknown } | string };
      const msg = typeof parsed.error === "string" ? parsed.error : parsed.error?.message;
      return typeof msg === "string" ? truncate(msg) : truncate(text);
    } catch {
      return truncate(text);
    }
  } catch {
    return "";
  }
}

function truncate(s: string): string {
  return s.length > ERROR_EXCERPT_LIMIT ? `${s.slice(0, ERROR_EXCERPT_LIMIT)}…` : s;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
