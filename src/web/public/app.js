/**
 * Subscription Butler web UI.
 *
 * Event-driven: the page renders whatever arrives on the SSE stream, so a
 * refresh replays the whole session and several tabs stay in sync. All
 * dynamic content is inserted via textContent — model output and contract
 * data are untrusted and must never reach innerHTML.
 */
"use strict";

(() => {
  const chatLog = document.getElementById("chat-log");
  const composer = document.getElementById("composer");
  const composerInput = document.getElementById("composer-input");
  const composerSend = document.getElementById("composer-send");
  const auditList = document.getElementById("audit-list");
  const auditStatus = document.getElementById("audit-status");
  const auditRefresh = document.getElementById("audit-refresh");
  const proofList = document.getElementById("proof-list");
  const proofEmpty = document.getElementById("proof-empty");
  const toast = document.getElementById("toast");

  /** confirmId -> { card, countdownEl, meterEl, timer } */
  const pendingConfirms = new Map();
  /** Masked evidence already shown, to avoid duplicate chips. */
  const seenProofs = new Set();

  let busy = false;
  let toastTimer = null;

  // ───────────────────────── helpers ─────────────────────────

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function appendToChat(node) {
    chatLog.appendChild(node);
    chatLog.scrollTop = chatLog.scrollHeight;
  }

  function showToast(message, bad) {
    toast.textContent = message;
    toast.classList.toggle("bad", Boolean(bad));
    toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toast.hidden = true; }, 4000);
  }

  function setBusy(value) {
    busy = value;
    composerSend.disabled = value;
    composerSend.textContent = value ? "…" : "Send";
  }

  async function postJson(url, body) {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    let payload = null;
    try { payload = await response.json(); } catch { /* non-JSON error body */ }
    return { ok: response.ok, status: response.status, payload };
  }

  function describeHttpError(payload, fallback) {
    return (payload && payload.error && payload.error.message) || fallback;
  }

  // ───────────────────────── chat rendering ─────────────────────────

  function renderUserMessage(text) {
    appendToChat(el("div", "msg msg-user", text));
  }

  function renderButlerMessage(text) {
    const wrap = el("div", "msg msg-butler");
    wrap.appendChild(el("span", "who", "Butler"));
    wrap.appendChild(document.createTextNode(text));
    appendToChat(wrap);
  }

  function renderStatus(line, isError) {
    appendToChat(el("div", `msg msg-status${isError ? " msg-error" : ""}`, line));
  }

  function renderToolCall(name, args) {
    const line = el("div", "msg tool-line");
    line.appendChild(document.createTextNode("→ "));
    line.appendChild(el("span", "tool-name", name));
    const argText = JSON.stringify(args);
    if (argText && argText !== "{}") {
      line.appendChild(document.createTextNode(` ${argText}`));
    }
    appendToChat(line);
  }

  function renderToolResult(name, result) {
    const line = el("div", "msg tool-line");
    line.appendChild(document.createTextNode("✓ "));
    line.appendChild(el("span", "tool-name", name));
    line.appendChild(document.createTextNode(" returned "));
    const details = el("details");
    details.appendChild(el("summary", null, "view payload"));
    details.appendChild(el("pre", null, JSON.stringify(result, null, 2)));
    line.appendChild(details);
    appendToChat(line);
    harvestMaskedEvidence(result);
  }

  // ───────────────────────── masked-evidence panel ─────────────────────────

  const PROOF_FIELDS = {
    paidWith: "paid with",
    receiptEmailMasked: "receipt to",
    cardholderNameMasked: "cardholder",
  };

  /** Walk a tool result for masked echoes the billing API sent back. */
  function harvestMaskedEvidence(value) {
    if (value === null || typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.forEach(harvestMaskedEvidence);
      return;
    }
    for (const [key, val] of Object.entries(value)) {
      if (PROOF_FIELDS[key] && typeof val === "string") {
        const dedupeKey = `${key}:${val}`;
        if (!seenProofs.has(dedupeKey)) {
          seenProofs.add(dedupeKey);
          const chip = el("li", "proof-chip");
          chip.appendChild(el("span", "proof-label", PROOF_FIELDS[key]));
          chip.appendChild(document.createTextNode(val));
          proofList.appendChild(chip);
          proofEmpty.hidden = true;
        }
      } else {
        harvestMaskedEvidence(val);
      }
    }
  }

  // ───────────────────────── confirmation cards ─────────────────────────

  function renderConfirmRequest(event) {
    const card = el("div", "msg confirm-card");
    card.appendChild(el("p", "confirm-kicker", "authorization required"));
    card.appendChild(el("p", "confirm-summary", event.summary));

    const actions = el("div", "confirm-actions");
    const approve = el("button", "btn-approve", "Approve");
    const deny = el("button", "btn-deny", "Deny");
    approve.type = "button";
    deny.type = "button";
    const countdown = el("span", "confirm-countdown");
    actions.append(approve, deny, countdown);
    card.appendChild(actions);

    const meter = el("div", "confirm-meter");
    const meterFill = el("span");
    meter.appendChild(meterFill);
    card.appendChild(meter);

    const totalMs = Math.max(event.expiresAtMs - Date.now(), 1);
    const timer = setInterval(() => {
      const left = event.expiresAtMs - Date.now();
      if (left <= 0) return; // server announces the timeout; we just stop counting
      countdown.textContent = `auto-deny in ${Math.ceil(left / 1000)}s`;
      meterFill.style.transform = `scaleX(${Math.max(left / totalMs, 0)})`;
    }, 250);

    const submit = async (approved) => {
      approve.disabled = deny.disabled = true;
      const { ok, status, payload } = await postJson("/api/confirm", {
        confirmId: event.confirmId,
        approved,
      });
      if (!ok && status !== 404) {
        approve.disabled = deny.disabled = false;
        showToast(describeHttpError(payload, "Confirmation failed — try again."), true);
      }
      // 404 = already resolved elsewhere/timed out; the confirm_resolved
      // event that caused it will render the final state.
    };
    approve.addEventListener("click", () => submit(true));
    deny.addEventListener("click", () => submit(false));

    pendingConfirms.set(event.confirmId, { card, timer });
    appendToChat(card);
  }

  function renderConfirmResolved(event) {
    const pending = pendingConfirms.get(event.confirmId);
    if (!pending) return; // resolved before this tab existed; replay renders card first
    pendingConfirms.delete(event.confirmId);
    clearInterval(pending.timer);
    pending.card.classList.add("resolved");
    const verdict = event.approved
      ? el("p", "confirm-verdict ok", "✓ approved — executing inside the enclave")
      : el(
          "p",
          "confirm-verdict no",
          event.via === "timeout" ? "✕ timed out — auto-denied" : "✕ denied — nothing was spent",
        );
    pending.card.appendChild(verdict);
  }

  // ───────────────────────── audit trail ─────────────────────────

  const BADGE_LABEL = {
    verified: "✓ enclave-signed",
    unsigned: "○ unsigned",
    failed: "✖ VERIFY FAILED",
  };

  async function refreshAuditLog() {
    auditStatus.textContent = "Verifying signatures…";
    auditStatus.classList.remove("bad");
    try {
      const response = await fetch("/api/audit-log?limit=20");
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(describeHttpError(payload, `HTTP ${response.status}`));
      }
      auditList.replaceChildren();
      const entries = payload.entries || [];
      if (entries.length === 0) {
        auditStatus.textContent = "No entries yet — every action the agent takes lands here.";
        return;
      }
      let verified = 0;
      let failed = 0;
      for (const entry of entries) {
        const status = (entry.verification && entry.verification.status) || "unsigned";
        if (status === "verified") verified += 1;
        if (status === "failed") failed += 1;

        const row = el("li", "audit-row");
        row.appendChild(el("span", `audit-badge ${status}`, BADGE_LABEL[status] || status));
        row.appendChild(el("span", "audit-action", `${entry.action ?? "?"} · seq ${entry.seq ?? "?"}`));
        row.appendChild(
          el(
            "span",
            "audit-time",
            typeof entry.ts_secs === "number" ? new Date(entry.ts_secs * 1000).toLocaleString() : "",
          ),
        );
        if (entry.detail !== undefined) {
          row.appendChild(el("span", "audit-detail", JSON.stringify(entry.detail)));
        }
        if (status !== "verified" && entry.verification && entry.verification.reason) {
          const reason = el(
            "span",
            status === "failed" ? "audit-reason" : "audit-detail",
            entry.verification.reason,
          );
          row.appendChild(reason);
        }
        auditList.appendChild(row);
      }
      auditStatus.textContent = failed > 0
        ? `⚠ ${failed} entr${failed === 1 ? "y" : "ies"} FAILED verification`
        : `${verified}/${entries.length} entries verified against the in-enclave signature`;
      auditStatus.classList.toggle("bad", failed > 0);
    } catch (err) {
      auditStatus.textContent = `Audit log unavailable: ${err.message}`;
      auditStatus.classList.add("bad");
    }
  }

  // ───────────────────────── event stream ─────────────────────────

  function handleChatEvent(event) {
    switch (event.type) {
      case "user_message": renderUserMessage(event.text); break;
      case "assistant_text": renderButlerMessage(event.text); break;
      case "status": renderStatus(event.line); break;
      case "tool_call": renderToolCall(event.name, event.args); break;
      case "tool_result": renderToolResult(event.name, event.result); break;
      case "tool_denied": renderStatus(`(skipped ${event.name} — not approved)`); break;
      case "confirm_request": renderConfirmRequest(event); break;
      case "confirm_resolved": renderConfirmResolved(event); break;
      case "turn_started": setBusy(true); break;
      case "turn_complete":
        setBusy(false);
        if (!event.ok) renderStatus(`turn failed: ${event.error || "unknown error"}`, true);
        refreshAuditLog();
        composerInput.focus();
        break;
      default: break; // forward-compatible: ignore unknown event types
    }
  }

  function connectEvents() {
    const source = new EventSource("/api/events");
    const link = document.getElementById("meta-link");
    source.addEventListener("chat", (message) => {
      try {
        handleChatEvent(JSON.parse(message.data));
      } catch (err) {
        console.error("Bad event payload:", err, message.data);
      }
    });
    source.onopen = () => {
      link.replaceChildren(el("span", "dot dot-ok"), document.createTextNode(" live"));
    };
    source.onerror = () => {
      // EventSource retries automatically (server sets retry: 2000) and
      // resumes from Last-Event-ID, so no events are lost across blips.
      link.replaceChildren(el("span", "dot dot-bad"), document.createTextNode(" reconnecting…"));
    };
  }

  // ───────────────────────── boot ─────────────────────────

  composer.addEventListener("submit", async (e) => {
    e.preventDefault();
    const message = composerInput.value.trim();
    if (!message) return;
    if (busy) {
      showToast("The Butler is mid-turn — wait for it to finish.", true);
      return;
    }
    composerInput.value = "";
    const { ok, payload } = await postJson("/api/chat", { message });
    if (!ok) {
      showToast(describeHttpError(payload, "Could not send the message."), true);
      composerInput.value = message; // give the user their text back
    }
  });

  auditRefresh.addEventListener("click", refreshAuditLog);

  async function loadState() {
    try {
      const response = await fetch("/api/state");
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const state = await response.json();
      document.getElementById("meta-principal").textContent = state.principal;
      const didEl = document.getElementById("meta-did");
      didEl.textContent = state.did;
      didEl.title = state.did;
      document.getElementById("meta-contract").textContent =
        `${state.contract.tail}@${state.contract.version} · id ${state.contract.contractId}`;
      document.getElementById("meta-brain").textContent = state.brainLabel;
      if (state.busy) setBusy(true);
    } catch (err) {
      showToast(`Could not load session state: ${err.message}`, true);
    }
  }

  loadState();
  connectEvents();
  refreshAuditLog();
  composerInput.focus();
})();
