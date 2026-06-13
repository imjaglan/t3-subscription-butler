import "dotenv/config";
import { parseContractResponse } from "@terminal3/t3n-sdk";
import { initT3n } from "../t3n.js";
import { readDeployState } from "./state.js";

/**
 * Ad-hoc contract invocation CLI.
 *
 *   npm run invoke -- audit-subscriptions
 *   npm run invoke -- audit-subscriptions '{"monthly_budget_cents":5000}'
 *   npm run invoke -- cancel-subscription '{"subscription_id":"sub_gym_app"}'
 *   npm run invoke -- get-audit-log '{"limit":10}'
 *
 * No automatic retries: charge/cancel are mutations and a blind retry could
 * double-fire. The billing API's Idempotency-Key is the safe retry mechanism.
 */

const KNOWN_FUNCTIONS = new Set([
  "audit-subscriptions",
  "cancel-subscription",
  "charge-subscription",
  "get-audit-log",
]);

async function main(): Promise<void> {
  const [functionName, rawInput] = process.argv.slice(2);
  if (!functionName) {
    console.error(
      `Usage: npm run invoke -- <function> ['<json-input>']\nFunctions: ${[...KNOWN_FUNCTIONS].join(", ")}`,
    );
    process.exitCode = 1;
    return;
  }
  if (!KNOWN_FUNCTIONS.has(functionName)) {
    console.warn(`⚠ "${functionName}" is not a known Butler function — invoking anyway.`);
  }

  let input: unknown;
  if (rawInput !== undefined) {
    try {
      input = JSON.parse(rawInput);
    } catch (err) {
      console.error(`✖ input is not valid JSON: ${(err as Error).message}`);
      process.exitCode = 1;
      return;
    }
  }

  const state = await readDeployState();
  if (!state) {
    console.error("✖ no .butler-deploy.json — run `npm run deploy` first.");
    process.exitCode = 1;
    return;
  }

  const session = await initT3n();
  if (session.tenantDid !== state.tenantDid) {
    console.warn(
      `⚠ authenticated tenant ${session.tenantDid} differs from deploy-state tenant ${state.tenantDid}`,
    );
  }

  console.log(`→ ${state.tail}@${state.version} :: ${functionName}`);
  const startedAt = Date.now();
  const raw = await session.tenant.contracts.execute(state.tail, {
    version: state.version,
    functionName,
    ...(input !== undefined ? { input } : {}),
  });
  const elapsed = Date.now() - startedAt;

  const decoded = typeof raw === "string" ? parseContractResponse(raw) : raw;
  console.log(`✔ ${elapsed}ms\n`);
  console.log(JSON.stringify(decoded, null, 2));
}

main().catch((err) => {
  console.error(`\n✖ invoke failed: ${err instanceof Error ? err.message : err}`);
  process.exitCode = 1;
});
