import "dotenv/config";
import { ButlerInvoker } from "../agent/invoker.js";

/**
 * Live proof of scoped delegation:
 *   1. The agent DID audits subscriptions   → ALLOWED by its grant
 *   2. The agent DID attempts a charge      → REFUSED by the node (no grant)
 *
 * Exit code 0 only when both behave as expected.
 */
async function main(): Promise<void> {
  const agent = await ButlerInvoker.create("agent");
  console.log(`agent principal: ${agent.did}\n`);

  console.log("→ [1/2] agent invokes audit-subscriptions (granted)…");
  const audit = (await agent.invoke("audit-subscriptions", {})) as {
    report?: { recommendations?: unknown[] };
  };
  const recs = audit.report?.recommendations?.length ?? 0;
  console.log(`✔ audit OK — ${recs} recommendation(s)\n`);

  console.log("→ [2/2] agent invokes charge-subscription (NOT granted)…");
  try {
    await agent.invoke("charge-subscription", {
      subscription_id: "sub_netflix",
      idempotency_key: "delegation-test-should-never-land",
    });
    console.error("✖ UNEXPECTED: charge succeeded — the grant scope is not being enforced!");
    process.exitCode = 1;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`✔ charge refused by the network as expected:\n   ${msg}`);
  }
}

main().catch((err) => {
  console.error(`\n✖ delegation test failed: ${err instanceof Error ? err.message : err}`);
  process.exitCode = 1;
});
