import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { verifyAuditEntry, type VerifiableEntry } from "./verify.js";

/**
 * The verifier is exercised against REAL secp256k1 signatures produced the
 * way the enclave host documents it: keccak256 over the exact payload bytes.
 * No mocks — if noble's API or our decoding drifts, these tests catch it.
 */

const PRIV = secp256k1.utils.randomSecretKey();
const PUB = secp256k1.getPublicKey(PRIV, false); // 0x04 || x || y

const toHex = (b: Uint8Array) => Buffer.from(b).toString("hex");

function pubKeyXY(): { x: string; y: string } {
  return { x: `0x${toHex(PUB.slice(1, 33))}`, y: `0x${toHex(PUB.slice(33))}` };
}

function signPayload(payload: string): Uint8Array {
  return secp256k1.sign(keccak_256(new TextEncoder().encode(payload)), PRIV);
}

function signedEntry(overrides: Partial<VerifiableEntry> = {}): VerifiableEntry {
  const payload = JSON.stringify({
    seq: 7,
    ts_secs: 1_760_000_000,
    action: "cancel",
    detail: { subscription_id: "sub_gym_app", changed: true },
  });
  return {
    seq: 7,
    action: "cancel",
    signed: true,
    payload,
    sig: { signature: `0x${toHex(signPayload(payload))}`, pubKey: pubKeyXY() },
    ...overrides,
  };
}

describe("verifyAuditEntry", () => {
  it("verifies a compact-64 hex signature with {x,y} pubkey", () => {
    assert.deepEqual(verifyAuditEntry(signedEntry()), { status: "verified" });
  });

  it("verifies bare hex (no 0x prefix) signature and coordinates", () => {
    const payload = JSON.stringify({ seq: 1, ts_secs: 1, action: "audit", detail: {} });
    const entry: VerifiableEntry = {
      seq: 1,
      action: "audit",
      payload,
      sig: {
        signature: toHex(signPayload(payload)),
        pubKey: { x: toHex(PUB.slice(1, 33)), y: toHex(PUB.slice(33)) },
      },
    };
    assert.equal(verifyAuditEntry(entry).status, "verified");
  });

  it("verifies a 65-byte r||s||v signature (Ethereum order, v last)", () => {
    const payload = JSON.stringify({ seq: 2, ts_secs: 2, action: "charge", detail: {} });
    const compact = signPayload(payload);
    const withV = new Uint8Array(65);
    withV.set(compact, 0);
    withV[64] = 27;
    const entry = signedEntry({
      seq: 2,
      action: "charge",
      payload,
      sig: { signature: `0x${toHex(withV)}`, pubKey: pubKeyXY() },
    });
    assert.equal(verifyAuditEntry(entry).status, "verified");
  });

  it("verifies a 65-byte v||r||s signature (recovery byte first)", () => {
    const payload = JSON.stringify({ seq: 3, ts_secs: 3, action: "audit", detail: {} });
    const compact = signPayload(payload);
    const withV = new Uint8Array(65);
    withV[0] = 1;
    withV.set(compact, 1);
    const entry = signedEntry({
      seq: 3,
      action: "audit",
      payload,
      sig: { signature: toHex(withV), pubKey: pubKeyXY() },
    });
    assert.equal(verifyAuditEntry(entry).status, "verified");
  });

  it("verifies a DER-encoded signature", () => {
    const payload = JSON.stringify({ seq: 4, ts_secs: 4, action: "cancel", detail: {} });
    const der = secp256k1.Signature.fromBytes(signPayload(payload)).toBytes("der");
    const entry = signedEntry({
      seq: 4,
      action: "cancel",
      payload,
      sig: { signature: `0x${toHex(der)}`, pubKey: pubKeyXY() },
    });
    assert.equal(verifyAuditEntry(entry).status, "verified");
  });

  it("verifies a single-string uncompressed pubKey", () => {
    const payload = JSON.stringify({ seq: 5, ts_secs: 5, action: "audit", detail: {} });
    const entry = signedEntry({
      seq: 5,
      action: "audit",
      payload,
      sig: { signature: `0x${toHex(signPayload(payload))}`, pubKey: `0x${toHex(PUB)}` },
    });
    assert.equal(verifyAuditEntry(entry).status, "verified");
  });

  it("fails on a tampered payload — the core tamper-evidence guarantee", () => {
    const entry = signedEntry();
    const tampered = entry.payload!.replace("sub_gym_app", "sub_netflix");
    const result = verifyAuditEntry({ ...entry, payload: tampered });
    assert.equal(result.status, "failed");
    assert.match(result.reason!, /does not match/);
  });

  it("fails when display fields contradict the signed payload", () => {
    const result = verifyAuditEntry(signedEntry({ action: "charge" }));
    assert.equal(result.status, "failed");
    assert.match(result.reason!, /claims action "charge"/);
  });

  it("fails when the signature is from a different key", () => {
    const otherPriv = secp256k1.utils.randomSecretKey();
    const entry = signedEntry();
    const digest = keccak_256(new TextEncoder().encode(entry.payload!));
    const forged = secp256k1.sign(digest, otherPriv);
    const result = verifyAuditEntry({
      ...entry,
      sig: { signature: `0x${toHex(forged)}`, pubKey: pubKeyXY() },
    });
    assert.equal(result.status, "failed");
  });

  it("reports unsigned (not failed) when there is no signature material", () => {
    const result = verifyAuditEntry({
      seq: 9,
      action: "cancel",
      signed: false,
      payload: null,
      sig: null,
      sign_error: "legacy-unsigned: written by a pre-signing contract version",
    });
    assert.equal(result.status, "unsigned");
    assert.match(result.reason!, /legacy-unsigned/);
  });

  it("reports unsigned with the contract's sign_error when signing degraded", () => {
    const result = verifyAuditEntry({
      payload: "{}",
      sig: null,
      sign_error: "host sign failed: NoSigningKey",
    });
    assert.equal(result.status, "unsigned");
    assert.match(result.reason!, /NoSigningKey/);
  });

  it("never throws on adversarial sig blobs", () => {
    const payload = JSON.stringify({ seq: 6, ts_secs: 6, action: "audit", detail: {} });
    const cases: unknown[] = [
      "not-an-object",
      {},
      { signature: "zz-not-hex", pubKey: pubKeyXY() },
      { signature: `0x${toHex(signPayload(payload))}` }, // no pubKey
      { signature: `0x${toHex(signPayload(payload))}`, pubKey: { x: "0x00" } }, // missing y
      { signature: "0x0102", pubKey: pubKeyXY() }, // absurd length
      { signature: `0x${toHex(signPayload(payload))}`, pubKey: { x: `0x${"ff".repeat(40)}`, y: "0x01" } },
    ];
    for (const sig of cases) {
      const result = verifyAuditEntry({ seq: 6, action: "audit", payload, sig });
      assert.equal(result.status, "failed", `expected failed for ${JSON.stringify(sig)}`);
      assert.ok(result.reason, "failed verdicts must carry a reason");
    }
  });

  it("fails (not verified) on non-JSON payload", () => {
    const result = verifyAuditEntry({ payload: "not json", sig: { signature: "0x00" } });
    assert.equal(result.status, "failed");
    assert.match(result.reason!, /not valid JSON/);
  });
});
