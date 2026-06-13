import "dotenv/config";
import { getNodeUrl, getScriptVersion, parseContractResponse } from "@terminal3/t3n-sdk";
import { initT3n } from "../t3n.js";
import { readDeployState } from "./state.js";

/**
 * Write the outbound-HTTP authorization grant for the Butler contract.
 *
 * T3N resolves a contract's egress allowlist per call from the CALLER's
 * grant (`tee:user/contracts::agent-auth-update`). For direct self-calls the
 * "agent" is our own DID; when a separate agent DID is delegated later, run
 * this again with AGENT_DID set to that DID.
 *
 *   npm run grant                 # self-grant for the tenant DID
 *   AGENT_DID=did:t3n:… npm run grant
 *
 * The allowed host is derived from BILLING_PUBLIC_URL — re-run after every
 * tunnel URL change.
 */

const ALL_BUTLER_FUNCTIONS = [
  "audit-subscriptions",
  "cancel-subscription",
  "charge-subscription",
  "get-audit-log",
] as const;

/**
 * GRANT_FUNCTIONS narrows the grant (comma-separated). Defaults to all four.
 * The scoped-agent demo grants everything EXCEPT charge-subscription so the
 * node itself — not the app — blocks the agent from spending money.
 */
function grantFunctions(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env.GRANT_FUNCTIONS?.trim();
  if (!raw) return [...ALL_BUTLER_FUNCTIONS];
  const requested = raw.split(",").map((f) => f.trim()).filter(Boolean);
  const unknown = requested.filter(
    (f) => !(ALL_BUTLER_FUNCTIONS as readonly string[]).includes(f),
  );
  if (requested.length === 0 || unknown.length > 0) {
    throw new Error(
      `GRANT_FUNCTIONS must be a comma-separated subset of: ${ALL_BUTLER_FUNCTIONS.join(", ")}` +
        (unknown.length > 0 ? ` (unknown: ${unknown.join(", ")})` : ""),
    );
  }
  // The credential schema requires sorted, deduped function lists.
  return [...new Set(requested)].sort();
}

function billingHost(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.BILLING_PUBLIC_URL?.trim();
  if (!raw) throw new Error("BILLING_PUBLIC_URL is required (the enclave-reachable billing URL).");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`BILLING_PUBLIC_URL is not a valid URL: ${raw}`);
  }
  if (!/^https?:$/.test(url.protocol)) {
    throw new Error("BILLING_PUBLIC_URL must be http(s).");
  }
  // The allowlist matches on host as the egress error reports it.
  return url.port ? `${url.hostname}:${url.port}` : url.hostname;
}

async function main(): Promise<void> {
  const state = await readDeployState();
  if (!state) {
    console.error("✖ no .butler-deploy.json — run `npm run deploy` first.");
    process.exitCode = 1;
    return;
  }
  const host = billingHost();

  const session = await initT3n();
  const scriptName = session.tenant.canonicalName(state.tail);

  // `agent-auth-update` REPLACES the caller's entire authorization document
  // (verified live: a grant that omitted the tenant self-grant revoked the
  // tenant's egress). So we always send the full set in one call:
  //   - the tenant's own DID with ALL functions (the owner/self path), and
  //   - the agent DID (when distinct) scoped by GRANT_FUNCTIONS.
  const agentDid = process.env.AGENT_DID?.trim();
  const agentFunctions = grantFunctions();

  const agents: Array<{
    agentDid: string;
    scripts: Array<{ scriptName: string; versionReq: string; functions: string[]; allowedHosts: string[] }>;
  }> = [
    {
      agentDid: session.tenantDid,
      scripts: [
        {
          scriptName,
          versionReq: state.version,
          functions: [...ALL_BUTLER_FUNCTIONS],
          allowedHosts: [host],
        },
      ],
    },
  ];

  if (agentDid && agentDid !== session.tenantDid) {
    agents.push({
      agentDid,
      scripts: [
        { scriptName, versionReq: state.version, functions: agentFunctions, allowedHosts: [host] },
      ],
    });
  }

  console.log(`→ updating agent-auth (script ${scriptName}@${state.version}, host ${host})`);
  for (const a of agents) {
    console.log(`   ${a.agentDid} → ${a.scripts[0].functions.join(", ")}`);
  }

  const userContractVersion = await getScriptVersion(getNodeUrl(), "tee:user/contracts");
  const raw = await session.t3n.execute({
    script_name: "tee:user/contracts",
    script_version: userContractVersion,
    function_name: "agent-auth-update",
    input: { agents },
  });

  const decoded = typeof raw === "string" && raw.length > 0 ? parseContractResponse(raw) : raw;
  console.log(`✔ grant written: ${JSON.stringify(decoded)}`);
}

main().catch((err) => {
  console.error(`\n✖ grant failed: ${err instanceof Error ? err.message : err}`);
  process.exitCode = 1;
});
