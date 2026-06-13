//! Tamper-evident, enclave-signed audit trail in the `z:<tid>:butler-audit`
//! KV map.
//!
//! Every mutating action writes one entry keyed by the store sequence number
//! (zero-padded so lexicographic scan order == chronological order). Entries
//! are sanitized at the call site: never secrets, never profile data.
//!
//! # Signing (contract >= 0.2.0)
//! Each entry is serialized once to a canonical JSON `payload` string and
//! signed inside the enclave via the `host:interfaces/signing` import
//! (Keccak-256 over the payload bytes, cluster secp256k1 key). The stored
//! record is:
//!
//! ```json
//! { "v": 2, "payload": "<exact signed JSON>", "sig": { ... }, "sign_error": null }
//! ```
//!
//! The exact signed string is stored — display fields are re-parsed from it
//! on read — so offline verification (`npm run verify-audit`) hashes the very
//! bytes the enclave signed; there is no second serialization to drift.
//!
//! Signing is fail-open WITH a marker: if the host cannot sign (e.g. no
//! cluster key on this testnet), the entry is stored unsigned with an
//! explicit `sign_error`. Rationale: on the mutating path the upstream HTTP
//! action has already happened and is not transactional — losing the trail
//! would be strictly worse than losing the signature. The degradation is
//! visible in `get-audit-log` output and flagged by the verifier, never
//! silent.
//!
//! Transactional caveat: KV writes commit with the invocation's tx. If the
//! contract returns Err, the entry rolls back — so failed attempts leave no
//! trail, and an entry's existence proves the action committed.

#[cfg(target_arch = "wasm32")]
use crate::host::{
    interfaces::{kv_store, logging},
    tenant::tenant_context,
};
#[cfg(all(target_arch = "wasm32", feature = "enclave-signing"))]
use crate::host::interfaces::signing;

pub const AUDIT_MAP_TAIL: &str = "butler-audit";

/// Stored-record schema version for signed entries.
pub const ENTRY_SCHEMA_VERSION: u32 = 2;

/// Scan window for reads. The demo writes a handful of entries; a real
/// deployment would page with repeated bounded scans.
const SCAN_LIMIT: u32 = 1_000;
pub const DEFAULT_READ_LIMIT: u32 = 20;
pub const MAX_READ_LIMIT: u32 = 100;

/// The signed fact: what happened, when, in which tx. This struct's JSON
/// serialization (field order = declaration order) is the byte-exact message
/// the enclave signs.
#[derive(Debug, serde::Serialize, serde::Deserialize)]
pub struct AuditEntry {
    pub seq: u64,
    pub ts_secs: u64,
    pub action: String,
    pub detail: serde_json::Value,
}

/// What actually lands in the KV map for v2 entries.
#[derive(Debug, serde::Serialize, serde::Deserialize)]
pub struct StoredEntry {
    pub v: u32,
    /// Exact JSON string of [`AuditEntry`] that was hashed and signed.
    pub payload: String,
    /// Host `sign` output passed through verbatim (`{ signature, pubKey: {x, y} }`).
    /// `None` when signing failed — see `sign_error`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sig: Option<serde_json::Value>,
    /// Why `sig` is absent. Mutually exclusive with `sig` in practice.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sign_error: Option<String>,
}

/// What `get-audit-log` returns per entry: the parsed facts plus everything a
/// verifier needs (`payload` + `sig`), plus an honest signing status.
#[derive(Debug, serde::Serialize, serde::Deserialize)]
pub struct AuditEntryView {
    pub seq: u64,
    pub ts_secs: u64,
    pub action: String,
    pub detail: serde_json::Value,
    pub signed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub payload: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sig: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sign_error: Option<String>,
}

/// Decode one stored KV value into a view. Pure (no host calls) so it is
/// unit-testable on the host target. Handles both formats found in the map:
///   - v2: `StoredEntry` wrapper with signed payload
///   - v1 (legacy, pre-0.2.0): bare `AuditEntry` — surfaced as unsigned with
///     an explicit reason instead of being dropped.
pub fn decode_stored(value: &[u8]) -> Result<AuditEntryView, String> {
    // v2 first: the wrapper is distinguishable by its `v` + `payload` fields.
    if let Ok(stored) = serde_json::from_slice::<StoredEntry>(value) {
        if stored.v == ENTRY_SCHEMA_VERSION {
            let entry: AuditEntry = serde_json::from_str(&stored.payload)
                .map_err(|e| format!("v2 entry has unparseable payload: {e}"))?;
            let signed = stored.sig.is_some();
            return Ok(AuditEntryView {
                seq: entry.seq,
                ts_secs: entry.ts_secs,
                action: entry.action,
                detail: entry.detail,
                signed,
                payload: Some(stored.payload),
                sig: stored.sig,
                sign_error: stored.sign_error,
            });
        }
        return Err(format!("unknown entry schema version {}", stored.v));
    }
    // Legacy v1: bare AuditEntry at the top level.
    let entry: AuditEntry =
        serde_json::from_slice(value).map_err(|e| format!("not a v1 or v2 audit entry: {e}"))?;
    Ok(AuditEntryView {
        seq: entry.seq,
        ts_secs: entry.ts_secs,
        action: entry.action,
        detail: entry.detail,
        signed: false,
        payload: None,
        sig: None,
        sign_error: Some("legacy-unsigned: written by a pre-signing contract version".to_string()),
    })
}

#[cfg(target_arch = "wasm32")]
fn audit_map_name() -> String {
    let tid = tenant_context::tenant_did();
    format!("z:{}:{AUDIT_MAP_TAIL}", hex::encode(tid))
}

/// Sign `payload` inside the enclave. Returns the host's JSON blob on
/// success, or a human-readable reason on failure. Never panics: a signing
/// outage must degrade to an unsigned-but-marked entry, not a trap.
#[cfg(all(target_arch = "wasm32", feature = "enclave-signing"))]
fn sign_payload(payload: &str) -> Result<serde_json::Value, String> {
    let blob = signing::sign(payload.as_bytes()).map_err(|e| format!("host sign failed: {e:?}"))?;
    serde_json::from_slice::<serde_json::Value>(&blob)
        .map_err(|e| format!("host sign returned non-JSON blob ({} bytes): {e}", blob.len()))
}

/// No-signing build: every entry is honestly marked unsigned. The stored
/// format is identical, so the verifier and UI need no special case.
#[cfg(all(target_arch = "wasm32", not(feature = "enclave-signing")))]
fn sign_payload(_payload: &str) -> Result<serde_json::Value, String> {
    Err("signing disabled in this build (enclave-signing feature off — cluster did not admit the signing capability)".to_string())
}

/// Append one audit entry, signed in-enclave. Key = zero-padded seq + action
/// so concurrent actions in distinct txs can never collide on a key.
#[cfg(target_arch = "wasm32")]
pub fn append(action: &str, detail: serde_json::Value) -> Result<u64, String> {
    let seq = tenant_context::seq_no();
    let entry = AuditEntry {
        seq,
        ts_secs: tenant_context::cluster_timestamp_secs(),
        action: action.to_string(),
        detail,
    };
    let payload =
        serde_json::to_string(&entry).map_err(|e| format!("internal: audit entry: {e}"))?;

    // Fail-open with marker (see module docs): an unsigned entry beats a
    // missing one, and the gap is recorded where every reader sees it.
    let (sig, sign_error) = match sign_payload(&payload) {
        Ok(blob) => (Some(blob), None),
        Err(reason) => {
            let _ = logging::error(&format!("audit-log: signing degraded for seq {seq}: {reason}"));
            (None, Some(reason))
        }
    };

    let stored = StoredEntry { v: ENTRY_SCHEMA_VERSION, payload, sig, sign_error };
    let key = format!("{seq:020}:{action}");
    let value = serde_json::to_vec(&stored).map_err(|e| format!("internal: audit entry: {e}"))?;
    kv_store::put(&audit_map_name(), key.as_bytes(), &value)
        .map_err(|e| format!("kv: audit append: {e}"))?;
    Ok(seq)
}

/// Read the most recent entries, newest first. A corrupt entry is skipped
/// (and logged) rather than bricking the whole log read.
#[cfg(target_arch = "wasm32")]
pub fn read_recent(limit: u32) -> Result<Vec<AuditEntryView>, String> {
    let limit = limit.clamp(1, MAX_READ_LIMIT) as usize;
    let rows = kv_store::scan(&audit_map_name(), &[], &[0xff], SCAN_LIMIT)
        .map_err(|e| format!("kv: audit scan: {e}"))?;

    let mut entries: Vec<AuditEntryView> = Vec::with_capacity(rows.len().min(limit));
    for (key, value) in &rows {
        match decode_stored(value) {
            Ok(view) => entries.push(view),
            Err(e) => {
                let _ = logging::error(&format!(
                    "audit-log: skipping corrupt entry at key {:?}: {e}",
                    String::from_utf8_lossy(key)
                ));
            }
        }
    }
    // Scan returns lexicographic order == chronological; serve newest first.
    entries.reverse();
    entries.truncate(limit);
    Ok(entries)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_entry() -> AuditEntry {
        AuditEntry {
            seq: 42,
            ts_secs: 1_750_000_000,
            action: "cancel".to_string(),
            detail: serde_json::json!({ "subscription_id": "sub_gym_app", "changed": true }),
        }
    }

    #[test]
    fn signed_v2_entry_round_trips_with_exact_payload() {
        let payload = serde_json::to_string(&sample_entry()).unwrap();
        let stored = StoredEntry {
            v: ENTRY_SCHEMA_VERSION,
            payload: payload.clone(),
            sig: Some(serde_json::json!({
                "signature": "0xdeadbeef",
                "pubKey": { "x": "0x01", "y": "0x02" }
            })),
            sign_error: None,
        };
        let bytes = serde_json::to_vec(&stored).unwrap();

        let view = decode_stored(&bytes).unwrap();
        assert_eq!(view.seq, 42);
        assert_eq!(view.action, "cancel");
        assert_eq!(view.detail["subscription_id"], "sub_gym_app");
        assert!(view.signed);
        // Verifiers depend on the payload surviving byte-for-byte.
        assert_eq!(view.payload.as_deref(), Some(payload.as_str()));
        assert_eq!(view.sig.unwrap()["signature"], "0xdeadbeef");
        assert!(view.sign_error.is_none());
    }

    #[test]
    fn unsigned_v2_entry_carries_the_sign_error() {
        let payload = serde_json::to_string(&sample_entry()).unwrap();
        let stored = StoredEntry {
            v: ENTRY_SCHEMA_VERSION,
            payload,
            sig: None,
            sign_error: Some("host sign failed: NoSigningKey".to_string()),
        };
        let view = decode_stored(&serde_json::to_vec(&stored).unwrap()).unwrap();
        assert!(!view.signed);
        assert_eq!(view.sign_error.as_deref(), Some("host sign failed: NoSigningKey"));
    }

    #[test]
    fn legacy_v1_entry_decodes_as_explicitly_unsigned() {
        // What pre-0.2.0 contract versions wrote: a bare AuditEntry.
        let bytes = serde_json::to_vec(&sample_entry()).unwrap();
        let view = decode_stored(&bytes).unwrap();
        assert_eq!(view.seq, 42);
        assert_eq!(view.action, "cancel");
        assert!(!view.signed);
        assert!(view.payload.is_none());
        assert!(view.sign_error.unwrap().starts_with("legacy-unsigned"));
    }

    #[test]
    fn v2_entry_with_garbage_payload_is_a_decode_error_not_a_panic() {
        let stored = StoredEntry {
            v: ENTRY_SCHEMA_VERSION,
            payload: "not json".to_string(),
            sig: None,
            sign_error: None,
        };
        let err = decode_stored(&serde_json::to_vec(&stored).unwrap()).unwrap_err();
        assert!(err.contains("unparseable payload"));
    }

    #[test]
    fn unknown_schema_version_is_rejected_loudly() {
        let stored = StoredEntry {
            v: 99,
            payload: serde_json::to_string(&sample_entry()).unwrap(),
            sig: None,
            sign_error: None,
        };
        let err = decode_stored(&serde_json::to_vec(&stored).unwrap()).unwrap_err();
        assert!(err.contains("unknown entry schema version 99"));
    }

    #[test]
    fn pure_garbage_is_a_decode_error() {
        assert!(decode_stored(b"\x00\x01definitely-not-json").is_err());
    }

    #[test]
    fn key_padding_keeps_lexicographic_order_chronological() {
        let k1 = format!("{:020}:cancel", 99u64);
        let k2 = format!("{:020}:cancel", 100u64);
        assert!(k1 < k2, "zero padding must make seq 99 sort before seq 100");
    }
}
