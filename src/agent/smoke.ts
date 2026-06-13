import "dotenv/config";
import { ButlerBrain, type ChatUI, type Confirmer } from "./brain.js";
import { ButlerInvoker } from "./invoker.js";
import { resolveProvider } from "./provider.js";

/**
 * Non-interactive end-to-end smoke test of the chat brain:
 *   - a read-only audit turn (auto-runs, no confirmation)
 *   - a cancel turn with confirmation DENIED (proves the gate blocks money moves)
 *   - a cancel turn with confirmation APPROVED (proves the full path works)
 *
 * Drives the real configured model (Claude or local Ollama, per LLM_PROVIDER)
 * + the real testnet contract. Requires a deployed contract.
 */
async function main(): Promise<void> {
  const provider = resolveProvider();
  console.log(`Brain: ${provider.label}`);
  const invoker = await ButlerInvoker.create("tenant");

  const ui: ChatUI = {
    assistantText: (t) => console.log(`\nButler: ${t}`),
    status: (l) => console.log(`  ${l}`),
    toolDenied: (n) => console.log(`  (denied ${n})`),
  };

  // Scripted confirmations: deny the first money-moving action, approve the second.
  const decisions = [false, true];
  let i = 0;
  const confirm: Confirmer = async (summary) => {
    const decision = decisions[Math.min(i, decisions.length - 1)];
    i += 1;
    console.log(`  [confirm] "${summary}" -> ${decision ? "APPROVE" : "DENY"}`);
    return decision;
  };

  const brain = new ButlerBrain(invoker, confirm, ui, provider.options);

  console.log("=== Turn 1: audit (read-only) ===");
  await brain.send("Audit my subscriptions with a $50/month budget and tell me what to cancel.");

  console.log("\n=== Turn 2: cancel, but I'll DENY at the prompt ===");
  await brain.send("Cancel the gym subscription.");

  console.log("\n=== Turn 3: cancel the news subscription, APPROVE this time ===");
  await brain.send("Actually cancel the forgotten news subscription (sub_news).");

  console.log("\n=== Turn 4: show the audit trail ===");
  await brain.send("Show me the last 3 entries of the audit log.");

  console.log("\n✔ smoke complete");
}

main().catch((err) => {
  console.error(`\n✖ smoke failed: ${err instanceof Error ? err.message : err}`);
  process.exitCode = 1;
});
