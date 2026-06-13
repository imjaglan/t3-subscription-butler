import "dotenv/config";
import { serve } from "@hono/node-server";
import { ButlerBrain } from "../agent/brain.js";
import { ButlerInvoker, type Principal } from "../agent/invoker.js";
import { resolveProvider } from "../agent/provider.js";
import { readDeployState } from "../ops/state.js";
import { createWebApp } from "./app.js";
import { ChatSession } from "./session.js";

/**
 * Entry point for the Subscription Butler web UI. Run with `npm run web`.
 *
 *   WEB_PORT            port (default 8788)
 *   BUTLER_PRINCIPAL    "tenant" (default) or "agent" (delegated DID)
 *   CONFIRM_TIMEOUT_MS  unattended approve/deny auto-denies after this (default 300000)
 *   LLM_PROVIDER        "anthropic" (default) or "ollama" — same as the CLI
 *
 * SECURITY: binds to 127.0.0.1 ONLY. The app has no authentication — it
 * exposes a chat that can move (mock) money behind user confirms. Do not
 * re-bind it to a public interface; put the demo on a screenshare instead.
 */

const DEFAULT_PORT = 8788;

function readPort(env: NodeJS.ProcessEnv): number {
  const raw = env.WEB_PORT?.trim() ?? String(DEFAULT_PORT);
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`WEB_PORT must be an integer in 1-65535, got "${raw}".`);
  }
  return port;
}

function readConfirmTimeout(env: NodeJS.ProcessEnv): number {
  const raw = env.CONFIRM_TIMEOUT_MS?.trim();
  if (!raw) return 300_000;
  const ms = Number(raw);
  if (!Number.isInteger(ms) || ms < 1_000 || ms > 3_600_000) {
    throw new Error(`CONFIRM_TIMEOUT_MS must be 1000-3600000, got "${raw}".`);
  }
  return ms;
}

async function main(): Promise<void> {
  const port = readPort(process.env);
  const confirmTimeoutMs = readConfirmTimeout(process.env);

  const principal = (process.env.BUTLER_PRINCIPAL as Principal) || "tenant";
  if (principal !== "tenant" && principal !== "agent") {
    throw new Error(`BUTLER_PRINCIPAL must be "tenant" or "agent", got "${principal}".`);
  }

  // Fail fast on LLM misconfig before any testnet round-trip (same order as the CLI).
  const provider = resolveProvider();

  const deployState = await readDeployState();
  if (!deployState) {
    throw new Error("No .butler-deploy.json — run `npm run deploy` first.");
  }

  console.log("Connecting to Terminal 3 testnet…");
  const invoker = await ButlerInvoker.create(principal);
  console.log(`Connected as ${principal}: ${invoker.did}`);

  const session = new ChatSession({
    createBrain: (confirm, ui) => new ButlerBrain(invoker, confirm, ui, provider.options),
    confirmTimeoutMs,
  });

  const app = createWebApp({
    session,
    fetchAuditLog: (limit) => invoker.invoke("get-audit-log", { limit }),
    state: {
      principal,
      did: invoker.did,
      brainLabel: provider.label,
      contract: {
        tail: deployState.tail,
        version: deployState.version,
        contractId: deployState.contractId,
      },
    },
  });

  const server = serve({ fetch: app.fetch, port, hostname: "127.0.0.1" }, (info) => {
    console.log(`\nSubscription Butler web UI: http://127.0.0.1:${info.port}`);
    console.log(`Brain: ${provider.label}`);
    console.log(`Confirm timeout: ${confirmTimeoutMs / 1000}s (unanswered approvals auto-deny)\n`);
  });

  const shutdown = (signal: string) => {
    console.log(`\n${signal} received, shutting down…`);
    session.close(); // denies pending confirms so no turn is left hanging
    server.close(() => process.exit(0));
    // SSE connections hold the server open; don't let close() wait on them forever.
    setTimeout(() => process.exit(0), 2_000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error(`\n✖ web server failed to start: ${err instanceof Error ? err.message : err}`);
  process.exitCode = 1;
});
