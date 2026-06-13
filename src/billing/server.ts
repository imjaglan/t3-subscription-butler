import "dotenv/config";
import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { loadBillingConfig } from "./config.js";

/**
 * Entry point for the mock billing API. Run with `npm run billing`.
 * Simulates a Stripe-like subscription processor for the Subscription Butler demo.
 */
function main(): void {
  const config = loadBillingConfig();
  const app = createApp({
    apiSecret: config.apiSecret,
    ...(config.cardToken ? { expectedCardToken: config.cardToken } : {}),
  });

  const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
    console.log(`Mock billing API listening on http://localhost:${info.port}`);
    console.log(`Health:  GET http://localhost:${info.port}/health`);
  });

  // Graceful shutdown so the port is released cleanly between dev runs.
  const shutdown = (signal: string) => {
    console.log(`\n${signal} received, shutting down...`);
    server.close(() => process.exit(0));
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main();
