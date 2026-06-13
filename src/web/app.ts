import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { verifyAuditEntries, type VerifiableEntry } from "../audit/verify.js";
import { ChatSession } from "./session.js";
import type { ChatEvent } from "./events.js";

/**
 * HTTP layer for the Subscription Butler web UI.
 *
 * Pure factory (no port binding) mirroring `billing/app.ts`: tests drive it
 * via `app.request(...)`. The server entry point binds it to 127.0.0.1 ONLY —
 * this app has no authentication of its own (it fronts a single local demo
 * session whose mutating actions are already gated by explicit confirms), so
 * it must never listen on a public interface.
 *
 * Routes:
 *   GET  /                  single-page UI (static)
 *   GET  /api/events        SSE stream, replayable via Last-Event-ID
 *   POST /api/chat          start a turn  -> 202 (events carry the progress)
 *   POST /api/confirm       approve/deny a pending mutating tool call
 *   GET  /api/audit-log     contract audit trail + offline signature verdicts
 *   GET  /api/state         who/what is running (principal, DID, brain, contract)
 */

export interface WebAppState {
  readonly principal: string;
  readonly did: string;
  readonly brainLabel: string;
  readonly contract: { readonly tail: string; readonly version: string; readonly contractId: number };
}

export interface WebAppDeps {
  readonly session: ChatSession;
  /** Read-only `get-audit-log` contract call. */
  readonly fetchAuditLog: (limit: number) => Promise<unknown>;
  readonly state: WebAppState;
  /** Override for tests; defaults to ./public next to this module. */
  readonly staticDir?: string;
}

interface ErrorBody {
  error: { code: string; message: string };
}

const MAX_MESSAGE_CHARS = 4_000;
const DEFAULT_AUDIT_LIMIT = 20;
const MAX_AUDIT_LIMIT = 100;
const SSE_HEARTBEAT_MS = 25_000;

const STATIC_FILES: Record<string, { file: string; type: string }> = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
  "/styles.css": { file: "styles.css", type: "text/css; charset=utf-8" },
};

function errorBody(code: string, message: string): ErrorBody {
  return { error: { code, message } };
}

/** SSE wire format for one event. */
function sseFrame(event: ChatEvent): string {
  return `id: ${event.id}\nevent: chat\ndata: ${JSON.stringify(event)}\n\n`;
}

function parseAfterId(lastEventId: string | undefined, afterParam: string | undefined): number {
  const raw = lastEventId ?? afterParam;
  if (!raw) return 0;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
}

export function createWebApp(deps: WebAppDeps): Hono {
  const staticDir = deps.staticDir ?? fileURLToPath(new URL("./public/", import.meta.url));
  const app = new Hono();

  // Request log — bodies are never printed (chat text is user-private).
  app.use("*", async (c, next) => {
    const start = Date.now();
    await next();
    if (c.req.path !== "/api/events") {
      console.log(`${c.req.method} ${c.req.path} -> ${c.res.status} (${Date.now() - start}ms)`);
    }
  });

  // --- static UI ---------------------------------------------------------
  for (const [route, { file, type }] of Object.entries(STATIC_FILES)) {
    app.get(route, async (c) => {
      try {
        const body = await readFile(`${staticDir}${file}`);
        return c.body(body, 200, { "Content-Type": type, "Cache-Control": "no-store" });
      } catch {
        return c.json(
          errorBody("static_missing", `UI asset ${file} not found in ${staticDir}.`),
          500,
        );
      }
    });
  }

  // --- live events -------------------------------------------------------
  app.get("/api/events", (c) => {
    const afterId = parseAfterId(c.req.header("Last-Event-ID"), c.req.query("after"));
    const encoder = new TextEncoder();
    let unsubscribe: (() => void) | undefined;
    let heartbeat: NodeJS.Timeout | undefined;

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const push = (chunk: string) => {
          try {
            controller.enqueue(encoder.encode(chunk));
          } catch {
            // Stream already closed by the client; cleanup happens in cancel.
          }
        };
        push(`retry: 2000\n\n`);
        unsubscribe = deps.session.subscribe((event) => push(sseFrame(event)), afterId);
        heartbeat = setInterval(() => push(`: ping\n\n`), SSE_HEARTBEAT_MS);
        heartbeat.unref?.();
        // Belt and braces: some runtimes signal disconnect via abort, not cancel.
        c.req.raw.signal.addEventListener("abort", () => {
          unsubscribe?.();
          if (heartbeat) clearInterval(heartbeat);
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        });
      },
      cancel() {
        unsubscribe?.();
        if (heartbeat) clearInterval(heartbeat);
      },
    });

    return c.body(stream, 200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
    });
  });

  // --- chat ---------------------------------------------------------------
  app.post("/api/chat", async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json(errorBody("bad_request", "Body must be JSON: { message: string }."), 400);
    }
    const message =
      typeof (raw as { message?: unknown })?.message === "string"
        ? ((raw as { message: string }).message).trim()
        : "";
    if (message.length === 0) {
      return c.json(errorBody("bad_request", "message must be a non-empty string."), 400);
    }
    if (message.length > MAX_MESSAGE_CHARS) {
      return c.json(
        errorBody("bad_request", `message exceeds ${MAX_MESSAGE_CHARS} characters.`),
        400,
      );
    }
    if (deps.session.busy) {
      return c.json(
        errorBody("turn_in_progress", "A turn is already running — wait for it to finish."),
        409,
      );
    }

    // Fire-and-forget: progress and completion arrive on the event stream.
    // send() resolves errors into turn_complete events; the catch is a last
    // line of defence against unhandled rejections, not a control path.
    void deps.session.send(message).catch((err) => {
      console.error("chat turn crashed outside the session boundary:", err);
    });
    return c.json({ accepted: true }, 202);
  });

  // --- confirmation gate --------------------------------------------------
  app.post("/api/confirm", async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json(
        errorBody("bad_request", "Body must be JSON: { confirmId: string, approved: boolean }."),
        400,
      );
    }
    const body = raw as { confirmId?: unknown; approved?: unknown };
    if (typeof body.confirmId !== "string" || body.confirmId.length === 0 || body.confirmId.length > 64) {
      return c.json(errorBody("bad_request", "confirmId must be a non-empty string."), 400);
    }
    if (typeof body.approved !== "boolean") {
      return c.json(errorBody("bad_request", "approved must be a boolean."), 400);
    }
    const resolved = deps.session.resolveConfirm(body.confirmId, body.approved);
    if (!resolved) {
      return c.json(
        errorBody("confirm_not_pending", "No pending confirmation with that id — it may have expired or been resolved in another tab."),
        404,
      );
    }
    return c.json({ ok: true });
  });

  // --- audit trail + signature verdicts ------------------------------------
  app.get("/api/audit-log", async (c) => {
    const rawLimit = c.req.query("limit");
    let limit = DEFAULT_AUDIT_LIMIT;
    if (rawLimit !== undefined) {
      const parsed = Number(rawLimit);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_AUDIT_LIMIT) {
        return c.json(
          errorBody("bad_request", `limit must be an integer in 1-${MAX_AUDIT_LIMIT}.`),
          400,
        );
      }
      limit = parsed;
    }

    let response: unknown;
    try {
      response = await deps.fetchAuditLog(limit);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json(errorBody("upstream", `get-audit-log failed: ${message}`), 502);
    }

    const entries = (response as { entries?: unknown })?.entries;
    if (!Array.isArray(entries)) {
      return c.json(errorBody("upstream", "get-audit-log returned an unexpected shape."), 502);
    }

    // Verify server-side with the same library `npm run verify-audit` uses,
    // so the badge in the UI and the CLI verdict can never disagree.
    const verified = verifyAuditEntries(entries as VerifiableEntry[]).map(({ entry, result }) => ({
      ...entry,
      verification: result,
    }));
    return c.json({ entries: verified });
  });

  // --- metadata -------------------------------------------------------------
  app.get("/api/state", (c) =>
    c.json({ ...deps.state, busy: deps.session.busy }),
  );

  app.onError((err, c) => {
    console.error("Unhandled web error:", err);
    return c.json(errorBody("internal_error", "Unexpected server error."), 500);
  });

  app.notFound((c) =>
    c.json(errorBody("not_found", `No route for ${c.req.method} ${c.req.path}.`), 404),
  );

  return app;
}
