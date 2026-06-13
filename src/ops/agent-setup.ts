import "dotenv/config";
import { randomBytes } from "node:crypto";
import { readFile, appendFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { initT3nWithKey } from "../t3n.js";

/**
 * Create (or show) the Butler agent's own T3N identity.
 *
 * The agent is a SEPARATE principal from the tenant: its own ETH key, its own
 * DID. The tenant then writes a SCOPED grant for that DID (npm run grant with
 * GRANT_FUNCTIONS) — that on-chain grant, enforced per-call by the node, is
 * the delegation primitive. The agent never holds the tenant key, the billing
 * secret, or the card token.
 *
 * Idempotent: reuses AGENT_T3N_KEY from .env when present, otherwise
 * generates one and appends it.
 */

const ENV_PATH = fileURLToPath(new URL("../../.env", import.meta.url));

async function ensureAgentKey(): Promise<string> {
  const existing = process.env.AGENT_T3N_KEY?.trim();
  if (existing) return existing;

  const key = randomBytes(32).toString("hex");
  // Append rather than rewrite — never risk clobbering the rest of .env.
  const current = await readFile(ENV_PATH, "utf8");
  const lead = current.endsWith("\n") ? "" : "\n";
  await appendFile(ENV_PATH, `${lead}AGENT_T3N_KEY=${key}\n`, "utf8");
  console.log("✔ generated a new agent key and appended AGENT_T3N_KEY to .env");
  return key;
}

async function main(): Promise<void> {
  const key = await ensureAgentKey();

  console.log("→ authenticating the agent identity against testnet…");
  const session = await initT3nWithKey(key);
  console.log(`✔ agent DID: ${session.tenantDid}`);

  const upsert = await appendDidToEnv(session.tenantDid);
  if (upsert) console.log("✔ AGENT_DID written to .env");

  console.log(
    "\nNext: grant the agent SCOPED access (audit + cancel + log — deliberately NOT charge):\n" +
      `  AGENT_DID=${session.tenantDid} GRANT_FUNCTIONS=audit-subscriptions,cancel-subscription,get-audit-log npm run grant`,
  );
}

async function appendDidToEnv(did: string): Promise<boolean> {
  const current = await readFile(ENV_PATH, "utf8");
  if (current.includes("AGENT_DID=")) return false;
  const lead = current.endsWith("\n") ? "" : "\n";
  await appendFile(ENV_PATH, `${lead}AGENT_DID=${did}\n`, "utf8");
  return true;
}

main().catch((err) => {
  console.error(`\n✖ agent setup failed: ${err instanceof Error ? err.message : err}`);
  process.exitCode = 1;
});
