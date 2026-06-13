import "dotenv/config";
import * as readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { ButlerBrain, type ChatUI, type Confirmer } from "./brain.js";
import { ButlerInvoker, type Principal } from "./invoker.js";
import { resolveProvider } from "./provider.js";

/**
 * Interactive CLI for Subscription Butler.
 *
 *   npm run chat                 # act as the tenant (data owner) — funded
 *   BUTLER_PRINCIPAL=agent npm run chat   # act as the delegated agent DID
 *
 * The agent principal requires the agent DID to hold testnet credits; see
 * BUG-005 in bug-log.md. The tenant principal works out of the box.
 */

const COLOR = stdout.isTTY;
const dim = (s: string) => (COLOR ? `\x1b[2m${s}\x1b[0m` : s);
const cyan = (s: string) => (COLOR ? `\x1b[36m${s}\x1b[0m` : s);
const yellow = (s: string) => (COLOR ? `\x1b[33m${s}\x1b[0m` : s);

async function main(): Promise<void> {
  const principal = (process.env.BUTLER_PRINCIPAL as Principal) || "tenant";
  if (principal !== "tenant" && principal !== "agent") {
    throw new Error(`BUTLER_PRINCIPAL must be "tenant" or "agent", got "${principal}".`);
  }

  // Resolve the LLM provider before touching the network — a bad LLM config
  // should fail here, not after a testnet round-trip.
  const provider = resolveProvider();

  console.log(dim("Connecting to Terminal 3 testnet…"));
  const invoker = await ButlerInvoker.create(principal);
  console.log(dim(`Connected as ${principal}: ${invoker.did}\n`));

  const rl = readline.createInterface({ input: stdin, output: stdout });

  const confirm: Confirmer = async (summary) => {
    const answer = (await rl.question(yellow(`\n⚠ ${summary} [y/N] `))).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  };

  const ui: ChatUI = {
    assistantText: (text) => console.log(`\n${cyan("Butler")}: ${text}`),
    status: (line) => console.log(dim(`  ${line}`)),
    toolDenied: (name) => console.log(dim(`  (skipped ${name} — not approved)`)),
  };

  const brain = new ButlerBrain(invoker, confirm, ui, provider.options);

  console.log(dim(`Brain: ${provider.label}\n`));
  console.log("Subscription Butler ready. Try: \"audit my subscriptions and suggest cancellations\".");
  console.log(dim("Type 'exit' or Ctrl-C to quit.\n"));

  // Graceful Ctrl-C.
  rl.on("SIGINT", () => {
    console.log(dim("\nGoodbye."));
    rl.close();
    process.exit(0);
  });

  try {
    while (true) {
      const input = (await rl.question("You: ")).trim();
      if (!input) continue;
      if (input === "exit" || input === "quit") break;
      try {
        await brain.send(input);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(dim(`\n[error] ${msg}`));
      }
    }
  } finally {
    rl.close();
  }
}

main().catch((err) => {
  console.error(`\n✖ chat failed: ${err instanceof Error ? err.message : err}`);
  process.exitCode = 1;
});
