import "dotenv/config";
import { initT3n } from "./t3n.js";

// Verification script: handshake + authenticate against T3N testnet.
// Success = credentials work and the SDK is wired correctly.
const main = async () => {
  console.log("Connecting to T3N testnet...");
  const { tenantDid } = await initT3n();
  console.log("Authenticated.");
  console.log("Tenant DID:", tenantDid);
};

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
