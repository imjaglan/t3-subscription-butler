//! Billing API client — wasm-only. Reads the billing credential, card token
//! and base URL from the enclave KV map `z:<tid>:butler-secrets`, then talks
//! to the billing API via the host `http` / `http-with-placeholders` imports.
//!
//! Secrets never leave this module except inside outbound request bytes the
//! host dispatches from enclave memory; they are never logged and never
//! returned across the WIT boundary.

use crate::types::{ErrorBody, Subscription, SubscriptionList};

/// KV map tail holding the three secrets. Canonical name is built at runtime
/// from the tenant DID: `z:<tid>:butler-secrets`.
pub const SECRETS_MAP_TAIL: &str = "butler-secrets";

pub const KEY_BASE_URL: &str = "billing_base_url";
pub const KEY_API_SECRET: &str = "billing_api_secret";
pub const KEY_CARD_TOKEN: &str = "card_token";

/// Hard caps so a misbehaving upstream can't OOM the guest.
const MAX_LIST_RESPONSE_BYTES: usize = 262_144;
const MAX_MUTATION_RESPONSE_BYTES: usize = 65_536;
const MAX_SECRET_BYTES: usize = 4_096;

#[derive(Debug)]
pub struct BillingConfig {
    pub base_url: String,
    api_secret: String,
    card_token: String,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ChargeBody<'a> {
    card_token: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    receipt_email: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    cardholder_name: Option<&'a str>,
}

#[cfg(target_arch = "wasm32")]
use crate::host::{
    interfaces::{http, http_with_placeholders as hwp, kv_store, logging},
    tenant::tenant_context,
};

#[cfg(target_arch = "wasm32")]
fn secrets_map_name() -> String {
    let tid = tenant_context::tenant_did();
    format!("z:{}:{SECRETS_MAP_TAIL}", hex::encode(tid))
}

#[cfg(target_arch = "wasm32")]
fn read_secret(map: &str, key: &str) -> Result<String, String> {
    let bytes = kv_store::get(map, key.as_bytes())
        .map_err(|e| format!("kv: reading {key}: {e}"))?
        .ok_or_else(|| {
            format!("config: {key} missing from z:<tid>:{SECRETS_MAP_TAIL} — seed it via the tenant SDK (npm run seed)")
        })?;
    if bytes.len() > MAX_SECRET_BYTES {
        return Err(format!("config: {key} exceeds {MAX_SECRET_BYTES} bytes"));
    }
    let value = String::from_utf8(bytes).map_err(|_| format!("config: {key} is not valid UTF-8"))?;
    let value = value.trim().to_string();
    if value.is_empty() {
        return Err(format!("config: {key} is empty"));
    }
    Ok(value)
}

#[cfg(target_arch = "wasm32")]
pub fn load_config() -> Result<BillingConfig, String> {
    let map = secrets_map_name();
    let base_url = read_secret(&map, KEY_BASE_URL)?;
    validate_base_url(&base_url)?;
    Ok(BillingConfig {
        base_url: base_url.trim_end_matches('/').to_string(),
        api_secret: read_secret(&map, KEY_API_SECRET)?,
        card_token: read_secret(&map, KEY_CARD_TOKEN)?,
    })
}

/// The base URL comes from the tenant-controlled secrets map (never from
/// caller input) — validated anyway as defence in depth, and because the
/// egress allowlist is the real gate.
fn validate_base_url(url: &str) -> Result<(), String> {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("config: billing_base_url must start with http(s)://".to_string());
    }
    if url.len() > 2_048 || url.bytes().any(|b| b.is_ascii_whitespace()) || url.contains('{') {
        return Err("config: billing_base_url contains invalid characters".to_string());
    }
    Ok(())
}

#[cfg(target_arch = "wasm32")]
impl BillingConfig {
    fn auth_headers(&self) -> Vec<(String, String)> {
        // Content-Type is set by the host HTTP function; sending it explicitly
        // would duplicate the header (same caveat as the z-tenant-flight sample).
        vec![
            ("Authorization".to_string(), format!("Bearer {}", self.api_secret)),
            ("Accept".to_string(), "application/json".to_string()),
        ]
    }
}

/// Translate a billing API non-2xx into a stable, prefixed contract error.
/// Never echoes request contents — only the upstream envelope.
fn upstream_error(status: u16, payload: &[u8]) -> String {
    if status == 401 {
        return "config: billing credential rejected (HTTP 401) — re-seed billing_api_secret".to_string();
    }
    let detail = serde_json::from_slice::<ErrorBody>(payload)
        .map(|b| format!("{}: {}", b.error.code, b.error.message))
        .unwrap_or_else(|_| "unparseable error body".to_string());
    let prefix = match status {
        404 => "not-found",
        409 => "conflict",
        400 => "bad-input",
        _ => "upstream",
    };
    format!("{prefix}: billing API HTTP {status} — {detail}")
}

fn guard_size(payload: &[u8], cap: usize, what: &str) -> Result<(), String> {
    if payload.len() > cap {
        return Err(format!(
            "upstream: {what} response too large ({} bytes > {cap} cap)",
            payload.len()
        ));
    }
    Ok(())
}

#[cfg(target_arch = "wasm32")]
pub fn list_subscriptions(cfg: &BillingConfig) -> Result<Vec<Subscription>, String> {
    let resp = http::call(&http::Request {
        method: http::Verb::Get,
        url: format!("{}/subscriptions", cfg.base_url),
        headers: Some(cfg.auth_headers()),
        payload: None,
    })
    .map_err(|e| format!("upstream: GET /subscriptions transport failure: {e}"))?;

    if resp.code != 200 {
        return Err(upstream_error(resp.code, &resp.payload));
    }
    guard_size(&resp.payload, MAX_LIST_RESPONSE_BYTES, "subscription list")?;

    let list: SubscriptionList = serde_json::from_slice(&resp.payload)
        .map_err(|e| format!("upstream: subscription list parse failure: {e}"))?;
    let _ = logging::info(&format!(
        "billing: listed {} subscriptions",
        list.subscriptions.len()
    ));
    Ok(list.subscriptions)
}

#[cfg(target_arch = "wasm32")]
pub fn cancel_subscription(cfg: &BillingConfig, id: &str) -> Result<serde_json::Value, String> {
    let resp = http::call(&http::Request {
        method: http::Verb::Post,
        url: format!("{}/subscriptions/{id}/cancel", cfg.base_url),
        headers: Some(cfg.auth_headers()),
        payload: None,
    })
    .map_err(|e| format!("upstream: POST cancel transport failure: {e}"))?;

    if resp.code != 200 {
        return Err(upstream_error(resp.code, &resp.payload));
    }
    guard_size(&resp.payload, MAX_MUTATION_RESPONSE_BYTES, "cancel")?;
    let result: serde_json::Value = serde_json::from_slice(&resp.payload)
        .map_err(|e| format!("upstream: cancel response parse failure: {e}"))?;
    let _ = logging::info(&format!("billing: cancelled subscription {id}"));
    Ok(result)
}

/// Charge a subscription. The card token is injected from the secrets map
/// inside the enclave. With `receipt_to_profile`, receipt email + cardholder
/// name are sent as `{{profile.*}}` markers the host resolves from the
/// calling user's profile — the plaintext never enters WASM memory.
#[cfg(target_arch = "wasm32")]
pub fn charge_subscription(
    cfg: &BillingConfig,
    id: &str,
    idempotency_key: &str,
    receipt_to_profile: bool,
) -> Result<serde_json::Value, String> {
    let url = format!("{}/subscriptions/{id}/charge", cfg.base_url);
    let mut headers = cfg.auth_headers();
    headers.push(("Idempotency-Key".to_string(), idempotency_key.to_string()));

    let body = ChargeBody {
        card_token: &cfg.card_token,
        receipt_email: receipt_to_profile.then_some("{{profile.verified_contacts.email.value}}"),
        cardholder_name: receipt_to_profile.then_some("{{profile.first_name}} {{profile.last_name}}"),
    };
    let payload = serde_json::to_vec(&body).map_err(|e| format!("internal: charge body: {e}"))?;

    let (code, resp_payload) = if receipt_to_profile {
        let resp = hwp::call(&hwp::Request {
            method: hwp::Verb::Post,
            url,
            headers: Some(headers),
            payload: Some(payload),
        })
        .map_err(|e| format!("upstream: POST charge (placeholders): {}", format_hwp_error(e)))?;
        (resp.code, resp.payload)
    } else {
        let resp = http::call(&http::Request {
            method: http::Verb::Post,
            url,
            headers: Some(headers),
            payload: Some(payload),
        })
        .map_err(|e| format!("upstream: POST charge transport failure: {e}"))?;
        (resp.code, resp.payload)
    };

    if code != 200 && code != 201 {
        return Err(upstream_error(code, &resp_payload));
    }
    guard_size(&resp_payload, MAX_MUTATION_RESPONSE_BYTES, "charge")?;
    let receipt: serde_json::Value = serde_json::from_slice(&resp_payload)
        .map_err(|e| format!("upstream: charge response parse failure: {e}"))?;
    let _ = logging::info(&format!("billing: charged subscription {id} (idempotent)"));
    Ok(receipt)
}

/// Render a typed `http-with-placeholders` error as a contract-facing string.
/// Field names and host reasons only — never resolved values.
#[cfg(target_arch = "wasm32")]
fn format_hwp_error(e: hwp::HttpError) -> String {
    match e {
        hwp::HttpError::EgressDenied(host) => format!("egress denied for host {host}"),
        hwp::HttpError::PlaceholderDenied(marker) => format!("placeholder not permitted: {marker}"),
        hwp::HttpError::PlaceholderUnknown(field) => format!("user profile missing field: {field}"),
        hwp::HttpError::PlaceholderNoUserContext => {
            "no user context bound for placeholder resolution".to_string()
        }
        hwp::HttpError::UpstreamError(reason) => format!("upstream: {reason}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base_url_validation() {
        assert!(validate_base_url("https://billing.example.com").is_ok());
        assert!(validate_base_url("http://localhost:8787").is_ok());
        assert!(validate_base_url("ftp://nope").is_err());
        assert!(validate_base_url("https://has space").is_err());
        assert!(validate_base_url("https://x{{y}}").is_err());
    }

    #[test]
    fn upstream_error_maps_status_to_stable_prefixes() {
        let body = br#"{"error":{"code":"not_found","message":"No subscription"}}"#;
        assert!(upstream_error(404, body).starts_with("not-found:"));
        assert!(upstream_error(409, body).starts_with("conflict:"));
        assert!(upstream_error(400, body).starts_with("bad-input:"));
        assert!(upstream_error(500, body).starts_with("upstream:"));
        assert!(upstream_error(401, body).starts_with("config:"));
    }

    #[test]
    fn upstream_error_survives_unparseable_bodies() {
        let msg = upstream_error(500, b"<html>gateway error</html>");
        assert!(msg.contains("unparseable error body"));
    }

    #[test]
    fn charge_body_omits_receipt_fields_unless_requested() {
        let plain = ChargeBody { card_token: "tok_x", receipt_email: None, cardholder_name: None };
        let json = serde_json::to_string(&plain).unwrap();
        assert_eq!(json, r#"{"cardToken":"tok_x"}"#);

        let with = ChargeBody {
            card_token: "tok_x",
            receipt_email: Some("{{profile.verified_contacts.email.value}}"),
            cardholder_name: Some("{{profile.first_name}} {{profile.last_name}}"),
        };
        let json = serde_json::to_string(&with).unwrap();
        assert!(json.contains("receiptEmail"));
        assert!(json.contains("{{profile.first_name}}"));
    }

    #[test]
    fn size_guard_rejects_oversized_payloads() {
        assert!(guard_size(&vec![0u8; 10], 5, "x").is_err());
        assert!(guard_size(&vec![0u8; 5], 5, "x").is_ok());
    }
}
