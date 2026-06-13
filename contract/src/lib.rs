//! Subscription Butler — privacy-first subscription manager TEE contract.
//!
//! The agent orchestrating this contract NEVER sees the billing credential or
//! card token: both live in the enclave KV map `z:<tid>:butler-secrets`,
//! seeded by the tenant SDK before first use, and only materialise inside
//! outbound HTTP requests dispatched from the enclave. Receipt email and
//! cardholder name can additionally be resolved host-side from the calling
//! user's profile via `{{profile.*}}` placeholders, so that PII never enters
//! WASM memory at all.
//!
//! Functions (all take the node's 3-field `generic-input` envelope):
//!   - `audit-subscriptions`  read-only analysis + best-effort audit entry
//!   - `cancel-subscription`  mutating, audit entry committed with the tx
//!   - `charge-subscription`  mutating, idempotent via caller-supplied key
//!   - `get-audit-log`        reads back the contract's own audit trail
//!
//! # Host-capability requirements
//! `kv_store`, `logging`, `tenant_context`, `http`, `http_with_placeholders`,
//! `signing` (capabilities derive from the `world.wit` imports). `signing`
//! produces the per-entry enclave signature on the audit trail; if the host
//! cannot sign, entries degrade to unsigned-with-reason (see audit_log.rs).
//!
//! # Setup (tenant SDK, before first use)
//! Seed `z:<tid>:butler-secrets` with `billing_base_url`,
//! `billing_api_secret`, `card_token` — see `npm run seed`.
#![warn(clippy::style, missing_debug_implementations)]
#![cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]

extern crate alloc;

pub const CONTRACT_VERSION: &str = "0.2.1";

#[cfg(feature = "enclave-signing")]
wit_bindgen::generate!({
    world: "subscription-butler",
    path: "wit",
    additional_derives: [
        serde::Deserialize,
        serde::Serialize,
    ],
    generate_all,
});

// Fallback world without the `signing` import — see [features] in Cargo.toml.
#[cfg(not(feature = "enclave-signing"))]
wit_bindgen::generate!({
    world: "subscription-butler-nosign",
    path: "wit",
    additional_derives: [
        serde::Deserialize,
        serde::Serialize,
    ],
    generate_all,
});

pub mod audit;
pub mod audit_log;
pub mod billing;
pub mod types;

struct Component;

/// Parse an optional JSON input into a DTO, treating a missing payload as the
/// type's default (for functions where every field is optional).
#[cfg(target_arch = "wasm32")]
fn parse_optional_input<T: serde::de::DeserializeOwned + Default>(
    input: &Option<Vec<u8>>,
    function: &str,
) -> Result<T, String> {
    match input {
        None => Ok(T::default()),
        Some(bytes) if bytes.is_empty() => Ok(T::default()),
        Some(bytes) => serde_json::from_slice(bytes)
            .map_err(|e| format!("bad-input: {function}: {e}")),
    }
}

#[cfg(target_arch = "wasm32")]
fn parse_required_input<T: serde::de::DeserializeOwned>(
    input: &Option<Vec<u8>>,
    function: &str,
) -> Result<T, String> {
    let bytes = input
        .as_ref()
        .filter(|b| !b.is_empty())
        .ok_or_else(|| format!("bad-input: {function}: missing input"))?;
    serde_json::from_slice(bytes).map_err(|e| format!("bad-input: {function}: {e}"))
}

#[cfg(target_arch = "wasm32")]
impl exports::z::subscription_butler::contracts::Guest for Component {
    fn audit_subscriptions(
        req: exports::z::subscription_butler::contracts::GenericInput,
    ) -> Result<Vec<u8>, String> {
        use crate::host::{interfaces::logging, tenant::tenant_context};

        let request: types::AuditRequest =
            parse_optional_input(&req.input, "audit-subscriptions")?;

        let cfg = billing::load_config()?;
        let subs = billing::list_subscriptions(&cfg)?;
        let report = audit::compute_audit(&subs, request.monthly_budget_cents)?;

        // Read-only function: the audit entry is best effort. A KV hiccup
        // must not cost the caller their report — but it is never silent.
        let audit_entry_written = match audit_log::append(
            "audit",
            serde_json::json!({
                "active_count": report.active_count,
                "recommendation_count": report.recommendations.len(),
                "potential_monthly_saving_cents": report.potential_monthly_saving_cents,
            }),
        ) {
            Ok(_) => true,
            Err(e) => {
                let _ = logging::error(&format!("audit-subscriptions: audit append failed: {e}"));
                false
            }
        };

        let response = serde_json::json!({
            "report": report,
            "generated_at_secs": tenant_context::cluster_timestamp_secs(),
            // True when invoked through a user-bound session/delegated call —
            // the path where {{profile.*}} placeholder resolution is possible.
            "session_user_bound": tenant_context::calling_user_did().is_some(),
            "audit_entry_written": audit_entry_written,
        });
        serde_json::to_vec(&response).map_err(|e| format!("internal: serialize report: {e}"))
    }

    fn cancel_subscription(
        req: exports::z::subscription_butler::contracts::GenericInput,
    ) -> Result<Vec<u8>, String> {
        let request: types::CancelRequest =
            parse_required_input(&req.input, "cancel-subscription")?;
        types::validate_subscription_id(&request.subscription_id)?;

        let cfg = billing::load_config()?;
        let result = billing::cancel_subscription(&cfg, &request.subscription_id)?;

        // Mutating path: the audit entry commits atomically with this tx. If
        // the append fails we surface a precise error — the upstream cancel
        // HAS happened (HTTP is not transactional); hiding that would be worse.
        audit_log::append(
            "cancel",
            serde_json::json!({
                "subscription_id": request.subscription_id,
                "changed": result.get("changed"),
            }),
        )
        .map_err(|e| {
            format!(
                "audit-write-failed: cancellation of {} succeeded upstream but the audit entry could not be written: {e}",
                request.subscription_id
            )
        })?;

        serde_json::to_vec(&result).map_err(|e| format!("internal: serialize cancel: {e}"))
    }

    fn charge_subscription(
        req: exports::z::subscription_butler::contracts::GenericInput,
    ) -> Result<Vec<u8>, String> {
        use crate::host::tenant::tenant_context;

        let request: types::ChargeRequest =
            parse_required_input(&req.input, "charge-subscription")?;
        types::validate_subscription_id(&request.subscription_id)?;
        types::validate_idempotency_key(&request.idempotency_key)?;

        // Fail fast with a actionable message instead of letting the host
        // return placeholder-no-user-context mid-flight.
        if request.email_receipt_to_profile && tenant_context::calling_user_did().is_none() {
            return Err(
                "denied: email_receipt_to_profile requires a user-bound (session/delegated) \
                 invocation — the host has no profile to resolve {{profile.*}} placeholders from. \
                 Retry without email_receipt_to_profile or call through a user session."
                    .to_string(),
            );
        }

        let cfg = billing::load_config()?;
        let receipt = billing::charge_subscription(
            &cfg,
            &request.subscription_id,
            &request.idempotency_key,
            request.email_receipt_to_profile,
        )?;

        audit_log::append(
            "charge",
            serde_json::json!({
                "subscription_id": request.subscription_id,
                "idempotency_key": request.idempotency_key,
                "amount_cents": receipt.get("amountCents"),
                "receipt_to_profile": request.email_receipt_to_profile,
            }),
        )
        .map_err(|e| {
            format!(
                "audit-write-failed: charge of {} succeeded upstream but the audit entry could not be written: {e}",
                request.subscription_id
            )
        })?;

        serde_json::to_vec(&receipt).map_err(|e| format!("internal: serialize receipt: {e}"))
    }

    fn get_audit_log(
        req: exports::z::subscription_butler::contracts::GenericInput,
    ) -> Result<Vec<u8>, String> {
        let request: types::AuditLogRequest = parse_optional_input(&req.input, "get-audit-log")?;
        let entries =
            audit_log::read_recent(request.limit.unwrap_or(audit_log::DEFAULT_READ_LIMIT))?;
        serde_json::to_vec(&serde_json::json!({ "entries": entries }))
            .map_err(|e| format!("internal: serialize audit log: {e}"))
    }
}

#[cfg(target_arch = "wasm32")]
export!(Component);

#[cfg(test)]
mod tests {
    use super::CONTRACT_VERSION;

    #[test]
    fn contract_version_is_semver() {
        let parts: Vec<&str> = CONTRACT_VERSION.split('.').collect();
        assert_eq!(parts.len(), 3, "CONTRACT_VERSION must be MAJOR.MINOR.PATCH");
        for part in parts {
            assert!(part.parse::<u32>().is_ok(), "each part must be a number");
        }
    }
}
