import "dotenv/config";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { initT3n, type T3nSession } from "../t3n.js";
import { readDeployState, writeDeployState, type DeployState } from "./state.js";

/**
 * Idempotent testnet deploy for the Subscription Butler contract:
 *   1. register the compiled WASM (skipped when the same version is recorded)
 *   2. create the `butler-secrets` + `butler-audit` KV maps, ACL-locked to
 *      the contract id (re-runs tolerate MapAlreadyExists and re-assert ACLs)
 *   3. seed the three secrets via the control-plane `map-entry-set`
 *
 * Required env: T3N_API_KEY, BILLING_API_SECRET, BILLING_CARD_TOKEN,
 * BILLING_PUBLIC_URL (the enclave-reachable URL of the billing API — a
 * tunnel/public URL, NOT localhost).
 */

const CONTRACT_TAIL = "subscription-butler";
const SECRETS_MAP_TAIL = "butler-secrets";
const AUDIT_MAP_TAIL = "butler-audit";

const WASM_PATH = fileURLToPath(
  new URL(
    "../../contract/target/wasm32-wasip2/release/subscription_butler.wasm",
    import.meta.url,
  ),
);
const CARGO_TOML_PATH = fileURLToPath(new URL("../../contract/Cargo.toml", import.meta.url));

/** Single source of truth for the version is the contract's Cargo.toml. */
async function readContractVersion(): Promise<string> {
  const toml = await readFile(CARGO_TOML_PATH, "utf8");
  const match = /^\s*version\s*=\s*"(\d+\.\d+\.\d+)"\s*$/m.exec(toml);
  if (!match) throw new Error(`Could not parse version from ${CARGO_TOML_PATH}`);
  return match[1];
}

interface SeedSecrets {
  readonly billing_base_url: string;
  readonly billing_api_secret: string;
  readonly card_token: string;
}

function loadSeedSecrets(env: NodeJS.ProcessEnv = process.env): SeedSecrets {
  const billingUrl = env.BILLING_PUBLIC_URL?.trim();
  const apiSecret = env.BILLING_API_SECRET?.trim();
  const cardToken = env.BILLING_CARD_TOKEN?.trim();

  const missing: string[] = [];
  if (!billingUrl) missing.push("BILLING_PUBLIC_URL (enclave-reachable billing URL, e.g. a tunnel)");
  if (!apiSecret) missing.push("BILLING_API_SECRET");
  if (!cardToken) missing.push("BILLING_CARD_TOKEN");
  if (missing.length > 0) {
    throw new Error(`Missing required env:\n  - ${missing.join("\n  - ")}`);
  }
  if (!/^https?:\/\//.test(billingUrl!)) {
    throw new Error("BILLING_PUBLIC_URL must start with http(s)://");
  }
  if (/localhost|127\.0\.0\.1/.test(billingUrl!)) {
    console.warn(
      "⚠ BILLING_PUBLIC_URL points at localhost — the T3N enclave cannot reach your machine. " +
        "Use a tunnel (e.g. `cloudflared tunnel --url http://localhost:8787`) and re-seed.",
    );
  }
  if (!/^tok_[A-Za-z0-9]{8,64}$/.test(cardToken!)) {
    throw new Error("BILLING_CARD_TOKEN must match tok_<8-64 alphanumerics>.");
  }
  return {
    billing_base_url: billingUrl!.replace(/\/+$/, ""),
    billing_api_secret: apiSecret!,
    card_token: cardToken!,
  };
}

function isAlreadyExists(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /already.?exists|duplicate|conflict/i.test(msg);
}

async function registerContract(session: T3nSession, version: string): Promise<number> {
  const prior = await readDeployState();
  if (prior && prior.version === version && prior.tenantDid === session.tenantDid) {
    console.log(`✔ contract already registered (id ${prior.contractId}, v${version}) — skipping`);
    return prior.contractId;
  }

  let wasm: Uint8Array;
  try {
    wasm = await readFile(WASM_PATH);
  } catch {
    throw new Error(
      `Compiled WASM not found at ${WASM_PATH}.\nBuild it first: cd contract && cargo build --release`,
    );
  }

  console.log(`→ registering ${CONTRACT_TAIL}@${version} (${(wasm.length / 1024).toFixed(0)} KiB)…`);
  let contractId: number;
  try {
    const result = (await session.tenant.contracts.register({
      tail: CONTRACT_TAIL,
      version,
      wasm,
    })) as { contract_id?: unknown };
    if (typeof result?.contract_id !== "number") {
      throw new Error(`register returned unexpected shape: ${JSON.stringify(result)}`);
    }
    contractId = result.contract_id;
  } catch (err) {
    if (isAlreadyExists(err) && prior) {
      console.log(`✔ version already on chain — reusing recorded contract id ${prior.contractId}`);
      contractId = prior.contractId;
    } else if (isAlreadyExists(err)) {
      throw new Error(
        `Contract ${CONTRACT_TAIL}@${version} already registered but no local state file exists. ` +
          `Bump the version in contract/Cargo.toml or restore .butler-deploy.json. Original: ${
            (err as Error).message
          }`,
      );
    } else {
      throw err;
    }
  }

  await writeDeployState({
    contractId,
    tail: CONTRACT_TAIL,
    version,
    tenantDid: session.tenantDid,
    deployedAt: new Date().toISOString(),
  } satisfies DeployState);
  console.log(`✔ registered: contract id ${contractId}`);
  return contractId;
}

async function ensureMap(
  session: T3nSession,
  tail: string,
  contractId: number,
): Promise<void> {
  const acl = { only: [contractId] };
  try {
    await session.tenant.maps.create({
      tail,
      visibility: "private",
      writers: acl,
      // Readers must be explicit — the KV governor defaults to deny, which
      // would fail the contract's own reads with AccessDenied.
      readers: acl,
    });
    console.log(`✔ map ${tail} created (ACL → contract ${contractId})`);
  } catch (err) {
    if (!isAlreadyExists(err)) throw err;
    // Map persists across re-deploys; re-assert ACLs so a re-registered
    // contract (new id) regains access instead of mysteriously 403ing.
    await session.tenant.maps.update(tail, { writers: acl, readers: acl });
    console.log(`✔ map ${tail} exists — ACL re-asserted for contract ${contractId}`);
  }
}

async function seedSecrets(session: T3nSession, secrets: SeedSecrets): Promise<void> {
  const mapName = session.tenant.canonicalName(SECRETS_MAP_TAIL);
  for (const [key, value] of Object.entries(secrets)) {
    // Control-plane write — bypasses the map's writers ACL by design, so the
    // tenant can seed a map only the contract may otherwise touch.
    await session.tenant.executeControl("map-entry-set", {
      map_name: mapName,
      key,
      value,
    });
    console.log(`✔ seeded ${key} (${key === "billing_base_url" ? value : `${value.length} chars, redacted`})`);
  }
}

async function main(): Promise<void> {
  const version = await readContractVersion();
  const secrets = loadSeedSecrets();

  console.log("→ authenticating against T3N testnet…");
  const session = await initT3n();
  console.log(`✔ authenticated as ${session.tenantDid}`);

  const contractId = await registerContract(session, version);
  await ensureMap(session, SECRETS_MAP_TAIL, contractId);
  await ensureMap(session, AUDIT_MAP_TAIL, contractId);
  await seedSecrets(session, secrets);

  console.log("\nDeploy complete. Next: npm run invoke -- audit-subscriptions");
}

main().catch((err) => {
  console.error(`\n✖ deploy failed: ${err instanceof Error ? err.message : err}`);
  process.exitCode = 1;
});
