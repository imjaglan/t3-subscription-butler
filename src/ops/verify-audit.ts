import "dotenv/config";
import { ButlerInvoker, type Principal } from "../agent/invoker.js";
import { verifyAuditEntries, type VerifiableEntry } from "../audit/verify.js";

/**
 * Fetch the contract's audit trail from the testnet and verify every entry's
 * enclave signature offline.
 *
 *   npm run verify-audit              # newest 50 entries
 *   npm run verify-audit -- --limit 10
 *
 * Exit codes:
 *   0  every entry verified (or is explicitly unsigned/legacy — reported)
 *   1  at least one entry FAILED verification (tampering or signer mismatch)
 *   2  operational error (network, deploy state, bad arguments)
 *
 * "unsigned" is not a failure: legacy (pre-0.2.0) entries and entries written
 * while the host signing key was unavailable are expected and clearly marked.
 * A "failed" verdict is the alarm — the stored payload no longer matches its
 * enclave signature.
 */

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

function parseLimit(argv: readonly string[]): number {
  const flag = argv.indexOf("--limit");
  if (flag === -1) return DEFAULT_LIMIT;
  const raw = argv[flag + 1];
  const limit = Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new Error(`--limit must be an integer in 1-${MAX_LIMIT}, got "${raw ?? ""}".`);
  }
  return limit;
}

const ICON: Record<string, string> = {
  verified: "✔",
  unsigned: "○",
  failed: "✖",
};

function formatTimestamp(tsSecs: unknown): string {
  return typeof tsSecs === "number" && Number.isFinite(tsSecs)
    ? new Date(tsSecs * 1000).toISOString()
    : "unknown-time";
}

async function main(): Promise<void> {
  const limit = parseLimit(process.argv.slice(2));

  const principal = (process.env.BUTLER_PRINCIPAL as Principal) || "tenant";
  if (principal !== "tenant" && principal !== "agent") {
    throw new Error(`BUTLER_PRINCIPAL must be "tenant" or "agent", got "${principal}".`);
  }

  console.log(`Connecting to Terminal 3 testnet as ${principal}…`);
  const invoker = await ButlerInvoker.create(principal);

  const response = (await invoker.invoke("get-audit-log", { limit })) as {
    entries?: unknown;
  } | null;
  if (!response || !Array.isArray(response.entries)) {
    throw new Error(
      `get-audit-log returned an unexpected shape: ${JSON.stringify(response)?.slice(0, 300)}`,
    );
  }
  const entries = response.entries as VerifiableEntry[];

  if (entries.length === 0) {
    console.log("\nAudit log is empty — nothing to verify.");
    return;
  }

  console.log(`\nVerifying ${entries.length} entr${entries.length === 1 ? "y" : "ies"} (newest first):\n`);

  const results = verifyAuditEntries(entries);
  const counts = { verified: 0, unsigned: 0, failed: 0 };

  for (const { entry, result } of results) {
    counts[result.status] += 1;
    const seq = entry.seq !== undefined ? String(entry.seq).padStart(6) : "     ?";
    const action = (entry.action ?? "?").padEnd(8);
    const when = formatTimestamp((entry as { ts_secs?: unknown }).ts_secs);
    const line = `${ICON[result.status]} seq ${seq}  ${action} ${when}  ${result.status.toUpperCase()}`;
    console.log(result.reason ? `${line} — ${result.reason}` : line);
  }

  console.log(
    `\nSummary: ${counts.verified} verified · ${counts.unsigned} unsigned · ${counts.failed} failed`,
  );

  if (counts.failed > 0) {
    console.error(
      "\n✖ TAMPER ALERT: at least one entry's payload does not match its enclave signature.",
    );
    process.exitCode = 1;
  } else if (counts.verified > 0) {
    console.log(
      "\n✔ Every signed entry checks out: keccak256(payload) verifies against the cluster key embedded at write time.",
    );
  } else {
    console.log(
      "\n○ No signed entries found — the log predates contract 0.2.0 or the host signing key was unavailable.",
    );
  }
}

main().catch((err) => {
  console.error(`\n✖ verify-audit failed: ${err instanceof Error ? err.message : err}`);
  process.exitCode = 2;
});
