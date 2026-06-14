import type { OllamaConfig } from "./ollama.js";

/**
 * Config builder for OpenAI's hosted Chat Completions API. OpenAI speaks the
 * same wire protocol as a local Ollama server, so it reuses `OllamaMessagesClient`
 * — only the differences live here:
 *   - a Bearer API key (local Ollama needs none),
 *   - `max_completion_tokens` instead of `max_tokens` (GPT-5 rejects the latter),
 *   - a `reasoning_effort` knob for the gpt-5 reasoning family.
 *
 * Validated up front so misconfiguration fails at startup, before any testnet
 * round-trip — same contract as `ollamaConfigFromEnv`.
 */

export const DEFAULT_OPENAI_MODEL = "gpt-5-mini";
const DEFAULT_BASE_URL = "https://api.openai.com";
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_REASONING_EFFORT = "low";
const REASONING_EFFORTS = ["minimal", "low", "medium", "high"] as const;
type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export function openaiConfigFromEnv(env: NodeJS.ProcessEnv = process.env): OllamaConfig {
  const apiKey = env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error(
      "OPENAI_API_KEY is required when LLM_PROVIDER=openai. Set it in .env (see .env.example).",
    );
  }

  const model = env.OPENAI_MODEL?.trim() || DEFAULT_OPENAI_MODEL;

  const rawUrl = env.OPENAI_BASE_URL?.trim() || DEFAULT_BASE_URL;
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`OPENAI_BASE_URL is not a valid URL: "${rawUrl}".`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`OPENAI_BASE_URL must be http(s), got "${parsed.protocol}//".`);
  }
  // The client appends `/v1/chat/completions`, so strip a trailing /v1 if the
  // user pasted the full base (accept both forms).
  const baseUrl = parsed.toString().replace(/\/+$/, "").replace(/\/v1$/, "");

  let timeoutMs = DEFAULT_TIMEOUT_MS;
  const rawTimeout = env.OPENAI_TIMEOUT_MS?.trim();
  if (rawTimeout) {
    const n = Number(rawTimeout);
    if (!Number.isInteger(n) || n <= 0) {
      throw new Error(`OPENAI_TIMEOUT_MS must be a positive integer (milliseconds), got "${rawTimeout}".`);
    }
    timeoutMs = n;
  }

  const rawEffort = env.OPENAI_REASONING_EFFORT?.trim().toLowerCase() || DEFAULT_REASONING_EFFORT;
  if (!REASONING_EFFORTS.includes(rawEffort as ReasoningEffort)) {
    throw new Error(
      `OPENAI_REASONING_EFFORT must be one of ${REASONING_EFFORTS.join(", ")}, got "${rawEffort}".`,
    );
  }

  return {
    baseUrl,
    model,
    timeoutMs,
    apiKey,
    tokenParam: "max_completion_tokens",
    reasoningEffort: rawEffort as ReasoningEffort,
    displayName: "OpenAI",
  };
}
