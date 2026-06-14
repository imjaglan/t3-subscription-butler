import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type Anthropic from "@anthropic-ai/sdk";
import { OllamaError, OllamaMessagesClient, ollamaConfigFromEnv, type OllamaConfig } from "./ollama.js";
import { resolveProvider } from "./provider.js";

/**
 * The adapter is exercised with an injected fake fetch — no Ollama server,
 * no network. Covered: env-config validation, both translation directions,
 * the defensive stop_reason rule the confirmation gate depends on, and the
 * failure/retry policy (network, 5xx, 404, malformed tool JSON, timeout).
 */

// ── helpers ───────────────────────────────────────────────────────────────────

type FetchHandler = (url: string, init: RequestInit) => Response | Promise<Response>;

function fakeFetch(handlers: FetchHandler[]): {
  fn: typeof fetch;
  calls: Array<{ url: string; body: Record<string, any> }>;
} {
  const calls: Array<{ url: string; body: Record<string, any> }> = [];
  const fn = (async (url: any, init: any) => {
    calls.push({ url: String(url), body: JSON.parse(init.body as string) });
    const handler = handlers[Math.min(calls.length - 1, handlers.length - 1)];
    return handler(String(url), init);
  }) as typeof fetch;
  return { fn, calls };
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function completion(message: Record<string, unknown>, finish_reason = "stop"): unknown {
  return {
    choices: [{ message, finish_reason }],
    usage: { prompt_tokens: 7, completion_tokens: 3 },
  };
}

const CONFIG: OllamaConfig = {
  baseUrl: "http://localhost:11434",
  model: "gemma-test",
  timeoutMs: 5_000,
  retryDelayMs: 1, // keep retry tests fast
};

function client(handlers: FetchHandler[], config: Partial<OllamaConfig> = {}) {
  const { fn, calls } = fakeFetch(handlers);
  return { adapter: new OllamaMessagesClient({ ...CONFIG, ...config }, fn), calls };
}

function params(
  messages: Anthropic.MessageParam[],
  extra: Partial<Anthropic.MessageCreateParamsNonStreaming> = {},
): Anthropic.MessageCreateParamsNonStreaming {
  return {
    model: "claude-opus-4-8", // what the brain sends — must be overridden on the wire
    max_tokens: 4096,
    messages,
    ...extra,
  };
}

// ── env config ────────────────────────────────────────────────────────────────

describe("ollamaConfigFromEnv", () => {
  it("requires OLLAMA_MODEL with an actionable message", () => {
    assert.throws(() => ollamaConfigFromEnv({}), /OLLAMA_MODEL/);
  });

  it("applies defaults for base URL and timeout", () => {
    const cfg = ollamaConfigFromEnv({ OLLAMA_MODEL: "gemma4" });
    assert.equal(cfg.baseUrl, "http://localhost:11434");
    assert.equal(cfg.model, "gemma4");
    assert.equal(cfg.timeoutMs, 120_000);
  });

  it("normalizes a base URL given with /v1 and trailing slashes", () => {
    const cfg = ollamaConfigFromEnv({
      OLLAMA_MODEL: "gemma4",
      OLLAMA_BASE_URL: "http://127.0.0.1:11434/v1/",
    });
    assert.equal(cfg.baseUrl, "http://127.0.0.1:11434");
  });

  it("rejects an invalid or non-http base URL", () => {
    assert.throws(
      () => ollamaConfigFromEnv({ OLLAMA_MODEL: "m", OLLAMA_BASE_URL: "not a url" }),
      /OLLAMA_BASE_URL/,
    );
    assert.throws(
      () => ollamaConfigFromEnv({ OLLAMA_MODEL: "m", OLLAMA_BASE_URL: "ftp://host" }),
      /http/,
    );
  });

  it("rejects a non-positive or non-numeric timeout", () => {
    for (const bad of ["abc", "-5", "0", "1.5"]) {
      assert.throws(
        () => ollamaConfigFromEnv({ OLLAMA_MODEL: "m", OLLAMA_TIMEOUT_MS: bad }),
        /OLLAMA_TIMEOUT_MS/,
        `expected "${bad}" to be rejected`,
      );
    }
  });
});

// ── request translation ───────────────────────────────────────────────────────

describe("OllamaMessagesClient — request translation", () => {
  it("translates system, tools, tool_use history and tool_result (with error prefix)", async () => {
    const { adapter, calls } = client([() => json(completion({ content: "ok" }))]);

    await adapter.messages.create(params(
      [
        { role: "user", content: "cancel gym" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "Cancelling." },
            { type: "tool_use", id: "toolu_1", name: "cancel_subscription", input: { subscription_id: "sub_gym" } },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_1", content: "denied-by-user: nope", is_error: true },
          ],
        },
      ],
      {
        system: "be a butler",
        tools: [
          {
            name: "cancel_subscription",
            description: "Cancel one subscription.",
            input_schema: { type: "object", properties: {} },
          },
        ],
      },
    ));

    const body = calls[0].body;
    assert.equal(calls[0].url, "http://localhost:11434/v1/chat/completions");
    assert.equal(body.model, "gemma-test", "the Anthropic model id must never reach the wire");
    assert.equal(body.max_tokens, 4096);
    assert.equal(body.thinking, undefined, "Anthropic-only params must be dropped");

    assert.deepEqual(body.messages[0], { role: "system", content: "be a butler" });
    assert.deepEqual(body.messages[1], { role: "user", content: "cancel gym" });
    assert.deepEqual(body.messages[2], {
      role: "assistant",
      content: "Cancelling.",
      tool_calls: [{
        id: "toolu_1",
        type: "function",
        function: { name: "cancel_subscription", arguments: '{"subscription_id":"sub_gym"}' },
      }],
    });
    assert.deepEqual(body.messages[3], {
      role: "tool",
      tool_call_id: "toolu_1",
      content: "[tool error] denied-by-user: nope",
    });

    assert.deepEqual(body.tools, [{
      type: "function",
      function: {
        name: "cancel_subscription",
        description: "Cancel one subscription.",
        parameters: { type: "object", properties: {} },
      },
    }]);
  });
});

// ── response translation ──────────────────────────────────────────────────────

describe("OllamaMessagesClient — response translation", () => {
  it("maps plain text to a text block with stop_reason end_turn and usage", async () => {
    const { adapter } = client([() => json(completion({ content: "All audited." }))]);
    const msg = await adapter.messages.create(params([{ role: "user", content: "audit" }]));

    assert.equal(msg.stop_reason, "end_turn");
    assert.equal(msg.content.length, 1);
    assert.equal(msg.content[0].type, "text");
    assert.equal((msg.content[0] as Anthropic.TextBlock).text, "All audited.");
    assert.deepEqual({ in: msg.usage.input_tokens, out: msg.usage.output_tokens }, { in: 7, out: 3 });
  });

  it("forces stop_reason tool_use whenever tool calls are present, even if finish_reason lies", async () => {
    const { adapter } = client([
      () => json(completion(
        {
          content: null,
          tool_calls: [{
            id: "call_1",
            type: "function",
            function: { name: "audit_subscriptions", arguments: '{"monthly_budget_cents":5000}' },
          }],
        },
        "stop", // local models often mislabel this — the gate must not trust it
      )),
    ]);

    const msg = await adapter.messages.create(params([{ role: "user", content: "audit" }]));
    assert.equal(msg.stop_reason, "tool_use");
    const block = msg.content[0] as Anthropic.ToolUseBlock;
    assert.equal(block.type, "tool_use");
    assert.equal(block.id, "call_1");
    assert.equal(block.name, "audit_subscriptions");
    assert.deepEqual(block.input, { monthly_budget_cents: 5000 });
  });

  it("synthesizes a tool_use id when the server omits one", async () => {
    const { adapter } = client([
      () => json(completion({
        tool_calls: [{ type: "function", function: { name: "get_audit_log", arguments: "" } }],
      })),
    ]);
    const msg = await adapter.messages.create(params([{ role: "user", content: "log" }]));
    const block = msg.content[0] as Anthropic.ToolUseBlock;
    assert.ok(block.id.length > 0, "must synthesize an id — the brain round-trips it in tool_result");
    assert.deepEqual(block.input, {}, "empty arguments must become an empty object");
  });

  it("maps finish_reason length to max_tokens", async () => {
    const { adapter } = client([() => json(completion({ content: "truncated…" }, "length"))]);
    const msg = await adapter.messages.create(params([{ role: "user", content: "hi" }]));
    assert.equal(msg.stop_reason, "max_tokens");
  });

  it("rejects a response without choices instead of returning garbage", async () => {
    const { adapter, calls } = client([() => json({ unexpected: true })]);
    await assert.rejects(
      adapter.messages.create(params([{ role: "user", content: "hi" }])),
      /no choices/,
    );
    assert.equal(calls.length, 2, "shape errors are treated as transient and retried once");
  });
});

// ── failures & retry policy ───────────────────────────────────────────────────

describe("OllamaMessagesClient — failures", () => {
  it("404 names the model and the fix, and is not retried", async () => {
    const { adapter, calls } = client([
      () => json({ error: { message: 'model "gemma-test" not found' } }, 404),
    ]);
    await assert.rejects(
      adapter.messages.create(params([{ role: "user", content: "hi" }])),
      (err: Error) => {
        assert.ok(err instanceof OllamaError);
        assert.match(err.message, /ollama pull gemma-test/);
        assert.match(err.message, /not found/);
        return true;
      },
    );
    assert.equal(calls.length, 1);
  });

  it("a 400 mentioning tools points at missing tool-calling support", async () => {
    const { adapter } = client([
      () => json({ error: { message: "registry.ollama.ai/x does not support tools" } }, 400),
    ]);
    await assert.rejects(
      adapter.messages.create(params([{ role: "user", content: "hi" }])),
      /tool calling/,
    );
  });

  it("retries once on a network error, then fails with a reachability hint", async () => {
    const calls: string[] = [];
    const fn = (async (url: any) => {
      calls.push(String(url));
      throw new TypeError("fetch failed: ECONNREFUSED");
    }) as typeof fetch;
    const adapter = new OllamaMessagesClient(CONFIG, fn);

    await assert.rejects(
      adapter.messages.create(params([{ role: "user", content: "hi" }])),
      /Cannot reach Ollama at http:\/\/localhost:11434.*ollama serve/,
    );
    assert.equal(calls.length, 2, "exactly one retry");
  });

  it("recovers when a 500 is followed by a good response", async () => {
    const { adapter, calls } = client([
      () => json({ error: "overloaded" }, 500),
      () => json(completion({ content: "recovered" })),
    ]);
    const msg = await adapter.messages.create(params([{ role: "user", content: "hi" }]));
    assert.equal((msg.content[0] as Anthropic.TextBlock).text, "recovered");
    assert.equal(calls.length, 2);
  });

  it("retries malformed tool-call JSON once, then surfaces a precise error", async () => {
    const broken = () => json(completion({
      tool_calls: [{ id: "c1", type: "function", function: { name: "audit_subscriptions", arguments: "{not json" } }],
    }));
    const { adapter, calls } = client([broken, broken]);

    await assert.rejects(
      adapter.messages.create(params([{ role: "user", content: "hi" }])),
      /malformed JSON for tool "audit_subscriptions"/,
    );
    assert.equal(calls.length, 2);
  });

  it("times out with an actionable message and does not retry", async () => {
    let attempts = 0;
    const fn = ((_url: any, init: any) =>
      new Promise((_resolve, reject) => {
        attempts += 1;
        (init.signal as AbortSignal).addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
      })) as typeof fetch;
    const adapter = new OllamaMessagesClient({ ...CONFIG, timeoutMs: 20 }, fn);

    await assert.rejects(
      adapter.messages.create(params([{ role: "user", content: "hi" }])),
      /timed out after 20ms.*OLLAMA_TIMEOUT_MS/,
    );
    assert.equal(attempts, 1, "timeouts must not be retried");
  });
});

// ── provider selection ────────────────────────────────────────────────────────

describe("resolveProvider", () => {
  it("defaults to anthropic with no injected client (brain builds its own)", () => {
    const resolved = resolveProvider({ ANTHROPIC_API_KEY: "sk-test" });
    assert.equal(resolved.options.client, undefined);
    assert.equal(resolved.options.model, undefined);
    assert.match(resolved.label, /anthropic/);
  });

  it("fails fast when the anthropic key is missing — before any testnet connect", () => {
    assert.throws(() => resolveProvider({}), /ANTHROPIC_API_KEY/);
    assert.throws(() => resolveProvider({ ANTHROPIC_API_KEY: "   " }), /ANTHROPIC_API_KEY/);
  });

  it("builds an Ollama client + model override when LLM_PROVIDER=ollama", () => {
    const resolved = resolveProvider({ LLM_PROVIDER: "ollama", OLLAMA_MODEL: "gemma4" });
    assert.ok(resolved.options.client instanceof OllamaMessagesClient);
    assert.equal(resolved.options.model, "gemma4");
    assert.match(resolved.label, /ollama · gemma4/);
  });

  it("fails fast when LLM_PROVIDER=ollama but OLLAMA_MODEL is missing", () => {
    assert.throws(() => resolveProvider({ LLM_PROVIDER: "ollama" }), /OLLAMA_MODEL/);
  });

  it("rejects an unknown provider by name", () => {
    assert.throws(() => resolveProvider({ LLM_PROVIDER: "gpt4all" }), /LLM_PROVIDER.*got "gpt4all"/);
  });
});
