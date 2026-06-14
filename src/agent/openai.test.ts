import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type Anthropic from "@anthropic-ai/sdk";
import { OllamaMessagesClient } from "./ollama.js";
import { DEFAULT_OPENAI_MODEL, openaiConfigFromEnv } from "./openai.js";
import { resolveProvider } from "./provider.js";

/**
 * OpenAI reuses the OpenAI-compatible client; these tests pin the bits that
 * differ from a local Ollama server: the Bearer header, the
 * `max_completion_tokens` field (GPT-5 rejects `max_tokens`), `reasoning_effort`,
 * and env-config validation.
 */

function capturingFetch(payload: unknown): {
  fn: typeof fetch;
  calls: Array<{ url: string; headers: Record<string, string>; body: Record<string, any> }>;
} {
  const calls: Array<{ url: string; headers: Record<string, string>; body: Record<string, any> }> = [];
  const fn = (async (url: any, init: any) => {
    calls.push({
      url: String(url),
      headers: (init.headers ?? {}) as Record<string, string>,
      body: JSON.parse(init.body as string),
    });
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { fn, calls };
}

function params(): Anthropic.MessageCreateParamsNonStreaming {
  return {
    model: "claude-opus-4-8", // what the brain sends — must be overridden on the wire
    max_tokens: 4096,
    messages: [{ role: "user", content: "hi" }],
  };
}

describe("openaiConfigFromEnv", () => {
  it("requires OPENAI_API_KEY with an actionable message", () => {
    assert.throws(() => openaiConfigFromEnv({}), /OPENAI_API_KEY/);
  });

  it("defaults model, token param, reasoning effort, and display name", () => {
    const cfg = openaiConfigFromEnv({ OPENAI_API_KEY: "sk-test" });
    assert.equal(cfg.model, DEFAULT_OPENAI_MODEL);
    assert.equal(cfg.tokenParam, "max_completion_tokens");
    assert.equal(cfg.reasoningEffort, "low");
    assert.equal(cfg.displayName, "OpenAI");
    assert.equal(cfg.baseUrl, "https://api.openai.com");
    assert.equal(cfg.apiKey, "sk-test");
  });

  it("strips a trailing /v1 from the base URL", () => {
    const cfg = openaiConfigFromEnv({ OPENAI_API_KEY: "sk", OPENAI_BASE_URL: "https://api.openai.com/v1/" });
    assert.equal(cfg.baseUrl, "https://api.openai.com");
  });

  it("rejects an unknown reasoning effort", () => {
    assert.throws(
      () => openaiConfigFromEnv({ OPENAI_API_KEY: "sk", OPENAI_REASONING_EFFORT: "turbo" }),
      /OPENAI_REASONING_EFFORT/,
    );
  });
});

describe("OpenAI wire request", () => {
  it("sends the Bearer key, max_completion_tokens (not max_tokens), and reasoning_effort", async () => {
    const cfg = openaiConfigFromEnv({ OPENAI_API_KEY: "sk-live-123" });
    const { fn, calls } = capturingFetch({
      choices: [{ message: { content: "hello", role: "assistant" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });

    await new OllamaMessagesClient(cfg, fn).messages.create(params());

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://api.openai.com/v1/chat/completions");
    assert.equal(calls[0].headers.authorization, "Bearer sk-live-123");
    assert.equal(calls[0].body.max_completion_tokens, 4096);
    assert.equal("max_tokens" in calls[0].body, false);
    assert.equal(calls[0].body.reasoning_effort, "low");
    assert.equal(calls[0].body.model, DEFAULT_OPENAI_MODEL);
  });
});

describe("resolveProvider — openai", () => {
  it("requires OPENAI_API_KEY", () => {
    assert.throws(() => resolveProvider({ LLM_PROVIDER: "openai" }), /OPENAI_API_KEY/);
  });

  it("resolves an openai brain with a labelled provider", () => {
    const resolved = resolveProvider({ LLM_PROVIDER: "openai", OPENAI_API_KEY: "sk" });
    assert.equal(resolved.options.model, DEFAULT_OPENAI_MODEL);
    assert.match(resolved.label, /^openai · /);
  });
});
