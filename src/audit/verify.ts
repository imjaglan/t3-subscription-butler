import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";

/**
 * Offline verification of enclave-signed audit entries.
 *
 * The contract (>= 0.2.0) signs the EXACT JSON `payload` string of each audit
 * entry inside the enclave: the host Keccak-256-hashes the payload bytes and
 * signs the hash with the cluster secp256k1 key, returning a JSON blob
 * `{ signature, pubKey: { x, y } }`. We re-hash the stored payload and check
 * the signature against the embedded public key — no network, no trust in
 * the transport that delivered the log.
 *
 * The host blob's exact encodings are not documented, so decoding is
 * deliberately tolerant (0x-hex / bare hex / base64 / byte arrays;
 * compact-64 / 65-with-recovery-byte / DER signatures; {x,y} or single-string
 * public keys). Every mismatch is a "failed" verdict with a precise reason —
 * never a throw, never a silent pass.
 */

export type VerificationStatus = "verified" | "unsigned" | "failed";

export interface VerificationResult {
  readonly status: VerificationStatus;
  /** Present for "unsigned" and "failed": why, in one human-readable line. */
  readonly reason?: string;
}

/** The slice of a `get-audit-log` entry the verifier needs. */
export interface VerifiableEntry {
  readonly seq?: number;
  readonly action?: string;
  readonly signed?: boolean;
  readonly payload?: string | null;
  readonly sig?: unknown;
  readonly sign_error?: string | null;
}

const HEX_PATTERN = /^[0-9a-fA-F]+$/;
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

/** Decode a value that may be hex (0x or bare), base64, or a number array. */
function decodeBytes(value: unknown, what: string): Uint8Array {
  if (Array.isArray(value) && value.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
    return Uint8Array.from(value as number[]);
  }
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${what}: expected a hex/base64 string or byte array`);
  }
  const hex = value.startsWith("0x") || value.startsWith("0X") ? value.slice(2) : value;
  if (hex.length % 2 === 0 && HEX_PATTERN.test(hex)) {
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) {
      out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }
    return out;
  }
  if (BASE64_PATTERN.test(value)) {
    return Uint8Array.from(Buffer.from(value, "base64"));
  }
  throw new Error(`${what}: not decodable as hex or base64`);
}

/** Left-pad a coordinate to exactly 32 bytes (hosts may strip leading zeros). */
function padTo32(bytes: Uint8Array, what: string): Uint8Array {
  if (bytes.length === 32) return bytes;
  if (bytes.length > 32) {
    throw new Error(`${what}: ${bytes.length} bytes, expected <= 32`);
  }
  const out = new Uint8Array(32);
  out.set(bytes, 32 - bytes.length);
  return out;
}

/**
 * Extract an uncompressed secp256k1 public key (0x04 || x || y) from the host
 * sign blob. Accepts `pubKey`/`pub_key`/`public_key` as `{x, y}` coordinates
 * or as a single encoded key string (33/65 bytes, with or without the prefix).
 */
function extractPublicKey(sig: Record<string, unknown>): Uint8Array {
  const raw = sig.pubKey ?? sig.pub_key ?? sig.public_key;
  if (raw === undefined || raw === null) {
    throw new Error("sig blob has no pubKey field");
  }
  if (typeof raw === "object" && !Array.isArray(raw)) {
    const coords = raw as Record<string, unknown>;
    const x = padTo32(decodeBytes(coords.x, "pubKey.x"), "pubKey.x");
    const y = padTo32(decodeBytes(coords.y, "pubKey.y"), "pubKey.y");
    const out = new Uint8Array(65);
    out[0] = 0x04;
    out.set(x, 1);
    out.set(y, 33);
    return out;
  }
  const bytes = decodeBytes(raw, "pubKey");
  if (bytes.length === 33 || bytes.length === 65) return bytes;
  if (bytes.length === 64) {
    // Bare x||y without the uncompressed prefix.
    const out = new Uint8Array(65);
    out[0] = 0x04;
    out.set(bytes, 1);
    return out;
  }
  throw new Error(`pubKey: unexpected length ${bytes.length} (want 33/64/65)`);
}

/**
 * Normalize a signature into candidate compact-64 forms to try, in order of
 * likelihood. 65-byte signatures carry a recovery byte whose position is
 * convention-dependent: the host docs say r||s||v (Ethereum, v last), noble's
 * own "recovered" format puts it first — we try both rather than guess.
 */
function signatureCandidates(sig: Record<string, unknown>): Uint8Array[] {
  const raw = sig.signature ?? sig.sig;
  if (raw === undefined || raw === null) {
    throw new Error("sig blob has no signature field");
  }
  const bytes = decodeBytes(raw, "signature");
  if (bytes.length === 64) return [bytes];
  if (bytes.length === 65) return [bytes.slice(0, 64), bytes.slice(1)];
  if (bytes[0] === 0x30) {
    // DER-encoded; normalize through noble's parser.
    return [secp256k1.Signature.fromBytes(bytes, "der").toBytes("compact")];
  }
  throw new Error(`signature: unexpected length ${bytes.length} (want 64/65/DER)`);
}

/**
 * Verify one audit entry. Pure and total: always returns a verdict, never
 * throws — a verifier that crashes on adversarial input is itself a bug.
 */
export function verifyAuditEntry(entry: VerifiableEntry): VerificationResult {
  if (!entry.payload || entry.sig === undefined || entry.sig === null) {
    return {
      status: "unsigned",
      reason: entry.sign_error ?? "entry carries no signature material",
    };
  }

  // The payload is the trust root: what we display must be what was signed.
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(entry.payload) as Record<string, unknown>;
  } catch (err) {
    return {
      status: "failed",
      reason: `payload is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (entry.seq !== undefined && parsed.seq !== entry.seq) {
    return {
      status: "failed",
      reason: `entry claims seq ${entry.seq} but the signed payload says ${String(parsed.seq)}`,
    };
  }
  if (entry.action !== undefined && parsed.action !== entry.action) {
    return {
      status: "failed",
      reason: `entry claims action "${entry.action}" but the signed payload says "${String(parsed.action)}"`,
    };
  }

  if (typeof entry.sig !== "object" || Array.isArray(entry.sig)) {
    return { status: "failed", reason: "sig blob is not a JSON object" };
  }
  const sigBlob = entry.sig as Record<string, unknown>;

  try {
    const publicKey = extractPublicKey(sigBlob);
    const candidates = signatureCandidates(sigBlob);
    const digest = keccak_256(new TextEncoder().encode(entry.payload));

    for (const candidate of candidates) {
      // lowS intentionally relaxed: the cluster signer's malleability policy
      // is unknown, and we are authenticating a log, not preventing replay.
      if (secp256k1.verify(candidate, digest, publicKey, { lowS: false })) {
        return { status: "verified" };
      }
    }
    return {
      status: "failed",
      reason: "signature does not match keccak256(payload) under the embedded public key",
    };
  } catch (err) {
    return {
      status: "failed",
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Convenience for UI/CLI: verify a whole `get-audit-log` response. */
export function verifyAuditEntries(
  entries: readonly VerifiableEntry[],
): Array<{ entry: VerifiableEntry; result: VerificationResult }> {
  return entries.map((entry) => ({ entry, result: verifyAuditEntry(entry) }));
}
