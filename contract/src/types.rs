//! Shared DTOs for contract inputs and the billing API wire shapes.
//!
//! The billing API uses camelCase JSON (mirrors `src/billing/types.ts` in the
//! mock server); contract inputs/outputs use snake_case. Both are pure serde
//! types so the audit engine stays host-testable.

use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// Contract function inputs
// ---------------------------------------------------------------------------

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AuditRequest {
    /// Optional monthly budget (USD cents). When the active USD total exceeds
    /// it, the lowest-value subscriptions are flagged for review.
    #[serde(default)]
    pub monthly_budget_cents: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CancelRequest {
    pub subscription_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ChargeRequest {
    pub subscription_id: String,
    /// Caller-supplied idempotency key — a retried charge with the same key
    /// never double-bills (enforced by the billing API).
    pub idempotency_key: String,
    /// When true, receipt email + cardholder name are sent as
    /// `{{profile.*}}` placeholders resolved by the host from the calling
    /// user's profile. Requires a user-bound (session/delegated) call.
    #[serde(default)]
    pub email_receipt_to_profile: bool,
}

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AuditLogRequest {
    #[serde(default)]
    pub limit: Option<u32>,
}

// ---------------------------------------------------------------------------
// Billing API wire shapes (camelCase)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Subscription {
    pub id: String,
    pub name: String,
    pub category: String,
    /// Smallest currency unit. i64 so negative values from a buggy upstream
    /// are caught by validation instead of wrapping.
    pub amount_cents: i64,
    pub currency: String,
    /// "monthly" | "yearly"
    pub cadence: String,
    /// "active" | "cancelled"
    pub status: String,
    #[serde(default)]
    pub last_charged_at: Option<String>,
    /// Normalised usage signal in [0, 1]. Lower = more likely unused.
    pub usage_score: f64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubscriptionList {
    pub subscriptions: Vec<Subscription>,
}

/// Billing API uniform error envelope: { "error": { "code", "message" } }.
#[derive(Debug, Deserialize)]
pub struct ErrorBody {
    pub error: ErrorDetail,
}

#[derive(Debug, Deserialize)]
pub struct ErrorDetail {
    pub code: String,
    pub message: String,
}

// ---------------------------------------------------------------------------
// Input validation helpers
// ---------------------------------------------------------------------------

/// Subscription ids travel into URL paths — restrict to a charset that cannot
/// change the path shape (no '/', '?', '#', '%', whitespace).
pub fn validate_subscription_id(id: &str) -> Result<(), String> {
    if id.is_empty() || id.len() > 128 {
        return Err("bad-input: subscription_id must be 1..=128 chars".to_string());
    }
    if !id
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-' || b == b'.')
    {
        return Err(
            "bad-input: subscription_id may only contain [A-Za-z0-9_.-]".to_string(),
        );
    }
    Ok(())
}

/// Idempotency keys travel into an HTTP header — printable ASCII, bounded.
pub fn validate_idempotency_key(key: &str) -> Result<(), String> {
    if key.is_empty() || key.len() > 64 {
        return Err("bad-input: idempotency_key must be 1..=64 chars".to_string());
    }
    if !key
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        return Err("bad-input: idempotency_key may only contain [A-Za-z0-9_-]".to_string());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn subscription_parses_billing_camel_case() {
        let json = r#"{
            "id": "sub_netflix", "name": "Netflix Premium", "category": "streaming",
            "amountCents": 2299, "currency": "USD", "cadence": "monthly",
            "status": "active", "lastChargedAt": null, "usageScore": 0.82
        }"#;
        let s: Subscription = serde_json::from_str(json).expect("parse");
        assert_eq!(s.amount_cents, 2299);
        assert_eq!(s.last_charged_at, None);
        assert!((s.usage_score - 0.82).abs() < 1e-9);
    }

    #[test]
    fn audit_request_rejects_unknown_fields() {
        let r: Result<AuditRequest, _> = serde_json::from_str(r#"{"budget": 1}"#);
        assert!(r.is_err(), "unknown field must be rejected, not ignored");
    }

    #[test]
    fn subscription_id_validation() {
        assert!(validate_subscription_id("sub_netflix").is_ok());
        assert!(validate_subscription_id("").is_err());
        assert!(validate_subscription_id("a/b").is_err());
        assert!(validate_subscription_id("a b").is_err());
        assert!(validate_subscription_id(&"x".repeat(129)).is_err());
    }

    #[test]
    fn idempotency_key_validation() {
        assert!(validate_idempotency_key("retry-1234_abc").is_ok());
        assert!(validate_idempotency_key("").is_err());
        assert!(validate_idempotency_key("has space").is_err());
        assert!(validate_idempotency_key(&"k".repeat(65)).is_err());
    }
}
