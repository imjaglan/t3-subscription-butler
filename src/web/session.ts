import type { ChatUI, Confirmer } from "../agent/brain.js";
import type { ChatEvent, ChatEventBody } from "./events.js";

/**
 * One shared chat session behind the web UI.
 *
 * Responsibilities:
 *  - own the event log (capped, replayable by id) and fan events out to SSE
 *    subscribers — any number of tabs can watch the same session;
 *  - adapt the browser to the brain's injected `Confirmer`/`ChatUI` seams:
 *    a mutating tool pauses the turn on a pending promise that an
 *    "Approve"/"Deny" button (POST /api/confirm) resolves;
 *  - serialize turns: the brain's message history is not re-entrant, so a
 *    second send while one is running is rejected (HTTP 409 upstream).
 *
 * Failure decisions:
 *  - confirms auto-DENY after `confirmTimeoutMs` — an unattended browser must
 *    never leave the turn hung or, worse, default to spending money;
 *  - a throwing brain ends the turn with `turn_complete{ok:false}` and always
 *    releases the busy lock.
 */

/** What the session needs from a brain — lets tests inject a scripted fake. */
export interface BrainLike {
  send(userMessage: string): Promise<void>;
}

/** Builds the brain with the session's confirm/ui seams wired in. */
export type BrainFactory = (confirm: Confirmer, ui: ChatUI) => BrainLike;

export interface ChatSessionOptions {
  readonly createBrain: BrainFactory;
  /** How long a confirmation may stay unanswered before auto-deny. */
  readonly confirmTimeoutMs?: number;
  /** Event-log cap; oldest events drop first (refresh loses oldest history). */
  readonly maxEvents?: number;
}

export class SessionBusyError extends Error {
  constructor() {
    super("A turn is already in progress — wait for it to finish.");
    this.name = "SessionBusyError";
  }
}

interface PendingConfirm {
  readonly resolve: (approved: boolean) => void;
  readonly timer: NodeJS.Timeout;
}

const DEFAULT_CONFIRM_TIMEOUT_MS = 300_000;
const DEFAULT_MAX_EVENTS = 2_000;

export class ChatSession {
  private readonly brain: BrainLike;
  private readonly confirmTimeoutMs: number;
  private readonly maxEvents: number;

  private readonly events: ChatEvent[] = [];
  private nextEventId = 1;
  private readonly subscribers = new Set<(event: ChatEvent) => void>();
  private readonly pendingConfirms = new Map<string, PendingConfirm>();
  private confirmSeq = 0;
  private turnInProgress = false;

  constructor(options: ChatSessionOptions) {
    this.confirmTimeoutMs = options.confirmTimeoutMs ?? DEFAULT_CONFIRM_TIMEOUT_MS;
    this.maxEvents = options.maxEvents ?? DEFAULT_MAX_EVENTS;

    const confirm: Confirmer = (summary) => this.requestConfirmation(summary);
    const ui: ChatUI = {
      assistantText: (text) => this.emit({ type: "assistant_text", text }),
      status: (line) => this.emit({ type: "status", line }),
      toolDenied: (name) => this.emit({ type: "tool_denied", name }),
      toolCall: (name, args) => this.emit({ type: "tool_call", name, args }),
      toolResult: (name, result) => this.emit({ type: "tool_result", name, result }),
    };
    this.brain = options.createBrain(confirm, ui);
  }

  get busy(): boolean {
    return this.turnInProgress;
  }

  /**
   * Run one user turn. Resolves when the turn finishes (the caller usually
   * does NOT await it — completion is announced via `turn_complete`).
   * Never rejects: brain errors become events, not unhandled rejections.
   */
  async send(text: string): Promise<void> {
    if (this.turnInProgress) throw new SessionBusyError();
    this.turnInProgress = true;
    this.emit({ type: "user_message", text });
    this.emit({ type: "turn_started" });
    try {
      await this.brain.send(text);
      this.emit({ type: "turn_complete", ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.emit({ type: "turn_complete", ok: false, error: message });
    } finally {
      this.turnInProgress = false;
    }
  }

  /**
   * Resolve a pending confirmation from the browser. Returns false for an
   * unknown/expired id — the route turns that into a 404 so a stale tab gets
   * an honest answer instead of silently "approving" nothing.
   */
  resolveConfirm(confirmId: string, approved: boolean): boolean {
    const pending = this.pendingConfirms.get(confirmId);
    if (!pending) return false;
    this.pendingConfirms.delete(confirmId);
    clearTimeout(pending.timer);
    this.emit({ type: "confirm_resolved", confirmId, approved, via: "user" });
    pending.resolve(approved);
    return true;
  }

  /**
   * Subscribe to events. Events with id > `afterId` are replayed synchronously
   * first (refresh recovery), then live events follow. Returns unsubscribe.
   */
  subscribe(listener: (event: ChatEvent) => void, afterId = 0): () => void {
    for (const event of this.events) {
      if (event.id > afterId) listener(event);
    }
    this.subscribers.add(listener);
    return () => this.subscribers.delete(listener);
  }

  /** Snapshot for tests and the state endpoint. */
  get eventLog(): readonly ChatEvent[] {
    return this.events;
  }

  /** Deny everything pending and drop subscribers — used at shutdown. */
  close(): void {
    for (const [confirmId, pending] of this.pendingConfirms) {
      clearTimeout(pending.timer);
      this.emit({ type: "confirm_resolved", confirmId, approved: false, via: "timeout" });
      pending.resolve(false);
    }
    this.pendingConfirms.clear();
    this.subscribers.clear();
  }

  private requestConfirmation(summary: string): Promise<boolean> {
    this.confirmSeq += 1;
    const confirmId = `confirm_${this.confirmSeq}`;
    const expiresAtMs = Date.now() + this.confirmTimeoutMs;

    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        // Unattended browser: deny, never spend money by default.
        if (this.pendingConfirms.delete(confirmId)) {
          this.emit({ type: "confirm_resolved", confirmId, approved: false, via: "timeout" });
          resolve(false);
        }
      }, this.confirmTimeoutMs);
      timer.unref?.();

      this.pendingConfirms.set(confirmId, { resolve, timer });
      this.emit({ type: "confirm_request", confirmId, summary, expiresAtMs });
    });
  }

  private emit(body: ChatEventBody): void {
    const event: ChatEvent = { ...body, id: this.nextEventId++, ts: new Date().toISOString() };
    this.events.push(event);
    if (this.events.length > this.maxEvents) {
      this.events.splice(0, this.events.length - this.maxEvents);
    }
    for (const listener of this.subscribers) {
      try {
        listener(event);
      } catch {
        // A broken SSE pipe must never take down the turn; the subscriber
        // is cleaned up by its own close handler.
      }
    }
  }
}
