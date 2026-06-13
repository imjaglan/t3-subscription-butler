import {
  T3nClient,
  TenantClient,
  setEnvironment,
  loadWasmComponent,
  eth_get_address,
  metamask_sign,
  createEthAuthInput,
  getNodeUrl,
} from "@terminal3/t3n-sdk";

export interface T3nSession {
  t3n: T3nClient;
  tenant: TenantClient;
  tenantDid: string;
}

/**
 * Authenticates against the T3N testnet using the developer API key
 * and returns a ready-to-use session.
 *
 * The tenant DID is opaque (did:t3n:<40 hex>) and MUST be read from the
 * authenticated session — never hardcoded or derived locally.
 */
export async function initT3n(): Promise<T3nSession> {
  const apiKey = process.env.T3N_API_KEY;
  if (!apiKey || apiKey === "paste-your-key-here") {
    throw new Error(
      "T3N_API_KEY missing. Copy .env.example to .env and paste your key from the claim page."
    );
  }
  return initT3nWithKey(apiKey);
}

/**
 * Same flow with an explicit key — used for the Butler agent's own identity:
 * a separate ETH key with its own DID, distinct from the tenant. The tenant
 * delegates scoped access to that DID via `agent-auth-update` (npm run grant).
 */
export async function initT3nWithKey(apiKey: string): Promise<T3nSession> {
  setEnvironment("testnet");

  const wasmComponent = await loadWasmComponent();
  const address = eth_get_address(apiKey);

  const t3n = new T3nClient({
    wasmComponent,
    handlers: {
      EthSign: metamask_sign(address, undefined, apiKey),
    },
  });

  await t3n.handshake();
  const did = await t3n.authenticate(createEthAuthInput(address));
  const tenantDid = did.value;

  const tenant = new TenantClient({
    t3n,
    baseUrl: getNodeUrl(),
    tenantDid,
  });

  return { t3n, tenant, tenantDid };
}
