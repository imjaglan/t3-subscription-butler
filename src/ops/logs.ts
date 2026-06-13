import "dotenv/config";
import { initT3n } from "../t3n.js";
import { readDeployState } from "./state.js";

/**
 * Read back the contract's `logging::info/debug/error` output.
 * Requires the tenant's log quota (`log_max_entries`) to be enabled node-side;
 * an empty result with logs clearly emitted usually means the quota is off.
 *
 *   npm run logs            # last entries, info+
 *   npm run logs -- error   # errors only
 */
async function main(): Promise<void> {
  const minLevel = (process.argv[2] as "info" | "debug" | "error" | undefined) ?? "info";
  const state = await readDeployState();
  if (!state) {
    console.error("✖ no .butler-deploy.json — run `npm run deploy` first.");
    process.exitCode = 1;
    return;
  }

  const session = await initT3n();
  const page = await session.tenant.contracts.logs(state.tail, { minLevel, limit: 100 });

  if (page.entries.length === 0) {
    console.log(
      "No log entries. Either nothing has run yet, or the tenant log quota " +
        "(log_max_entries) is disabled node-side.",
    );
    return;
  }
  for (const entry of page.entries) {
    const ts = new Date(entry.ts_ms).toISOString();
    console.log(`${ts} [${entry.level}] ${entry.message}`);
  }
  if (page.truncated) console.log(`… truncated (next_seq=${page.next_seq})`);
}

main().catch((err) => {
  console.error(`\n✖ logs failed: ${err instanceof Error ? err.message : err}`);
  process.exitCode = 1;
});
