import { DEFAULT_MODEL, type ButlerBrainOptions } from "./brain.js";
import { OllamaMessagesClient, ollamaConfigFromEnv } from "./ollama.js";

/**
 * Selects which LLM drives the chat brain, from LLM_PROVIDER:
 *   - "anthropic" (default) — Claude via ANTHROPIC_API_KEY; most reliable tool calling.
 *   - "ollama"              — a local model (e.g. Gemma); nothing leaves the machine.
 *
 * Resolved once at startup so misconfiguration fails fast, before any
 * testnet connection is made.
 */
export interface ResolvedProvider {
  readonly options: ButlerBrainOptions;
  /** Human-readable "which brain am I talking to" line for the CLI. */
  readonly label: string;
}

export function resolveProvider(env: NodeJS.ProcessEnv = process.env): ResolvedProvider {
  const provider = (env.LLM_PROVIDER ?? "anthropic").trim().toLowerCase();
  switch (provider) {
    case "anthropic":
      // Validate here, not in the brain constructor: by then the caller has
      // already paid for a testnet handshake it is about to throw away.
      if (!env.ANTHROPIC_API_KEY?.trim()) {
        throw new Error(
          "ANTHROPIC_API_KEY missing — set it in .env to use the Anthropic brain, or set LLM_PROVIDER=ollama to use a local model.",
        );
      }
      return { options: {}, label: `anthropic · ${DEFAULT_MODEL}` };
    case "ollama": {
      const config = ollamaConfigFromEnv(env);
      return {
        options: { client: new OllamaMessagesClient(config), model: config.model },
        label: `ollama · ${config.model} @ ${config.baseUrl}`,
      };
    }
    default:
      throw new Error(`LLM_PROVIDER must be "anthropic" or "ollama", got "${provider}".`);
  }
}
