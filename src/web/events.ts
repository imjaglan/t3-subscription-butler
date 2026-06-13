/**
 * Event vocabulary for the web chat session. Every UI-visible thing that
 * happens during a turn becomes one event with a monotonically increasing id,
 * so the browser can replay missed events after a refresh/reconnect
 * (SSE `Last-Event-ID`) and multiple tabs render the same session.
 */

export type ChatEventBody =
  | { type: "user_message"; text: string }
  | { type: "assistant_text"; text: string }
  | { type: "status"; line: string }
  | { type: "tool_call"; name: string; args: Record<string, unknown> }
  | { type: "tool_result"; name: string; result: unknown }
  | { type: "tool_denied"; name: string }
  | {
      type: "confirm_request";
      confirmId: string;
      summary: string;
      /** Epoch ms after which the request auto-denies — lets the UI show a countdown. */
      expiresAtMs: number;
    }
  | {
      type: "confirm_resolved";
      confirmId: string;
      approved: boolean;
      via: "user" | "timeout";
    }
  | { type: "turn_started" }
  | { type: "turn_complete"; ok: boolean; error?: string };

export type ChatEvent = ChatEventBody & {
  /** Monotonic per-session sequence — also the SSE event id. */
  id: number;
  /** ISO timestamp, for display only. */
  ts: string;
};
