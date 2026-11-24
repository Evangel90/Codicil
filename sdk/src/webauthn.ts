// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors
//
// Passkey (WebAuthn) assertions in the shape the vault's WebAuthn module
// verifies: contracts/src/lib/WebAuthn.compact.

import { p256 } from '@noble/curves/nist.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import type { Secp256r1Point } from '@midnight-ntwrk/compact-runtime';
import {
  CHROME_EXTRA_MEMBER,
  COMPILED_CLIENT_DATA_LENGTHS,
  DEFAULT_ORIGIN,
  DEFAULT_RP_ID,
  rpIdHash,
} from './config.js';

/** Witness value for `WebAuthnAssertion`. */
export interface WebAuthnAssertion {
  authenticatorData: Uint8Array;  // 37 bytes
  clientData: Uint8Array;         // clientDataJSON zero-padded to the long length
  longForm: boolean;
  sig: { r: bigint; s: bigint };
}

/** What `navigator.credentials.get()` returns, as raw bytes. */
export interface RawAssertion {
  authenticatorData: Uint8Array;
  clientDataJSON: Uint8Array;
  /** ASN.1 DER ECDSA signature, as WebAuthn returns it. */
  signature: Uint8Array;
}

/** Flags byte: UP (user present, bit 0) and UV (user verified, bit 2). */
export const FLAG_UP = 0x01;
export const FLAG_UV = 0x04;

const base64url = (b: Uint8Array): string =>
  btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** The WebAuthn `challenge` to request so the passkey approves `digest`. */
export function challengeFor(digest: Uint8Array): string {
  if (digest.length !== 32) throw new Error('digest must be 32 bytes');
  return base64url(digest);
}

/** Decode an ASN.1 DER ECDSA signature into (r, s). */
export function parseDerSignature(der: Uint8Array): { r: bigint; s: bigint } {
  const sig = p256.Signature.fromBytes(der, 'der');
  return { r: sig.r, s: sig.s };
}

/**
 * Convert a browser assertion into the vault's witness value. Throws if the
 * clientDataJSON length is not one the vault was compiled for (wrong origin).
 */
export function toWebAuthnAssertion(
  raw: RawAssertion,
  lengths: { short: number; long: number } = COMPILED_CLIENT_DATA_LENGTHS,
): WebAuthnAssertion {
  if (raw.authenticatorData.length !== 37) {
    throw new Error(`unexpected authenticatorData length ${raw.authenticatorData.length} (extensions are not supported)`);
  }
  const len = raw.clientDataJSON.length;
  if (len !== lengths.short && len !== lengths.long) {
    throw new Error(`clientDataJSON is ${len} bytes; this vault accepts ${lengths.short} or ${lengths.long} (wrong origin?)`);
  }
  const clientData = new Uint8Array(lengths.long);
  clientData.set(raw.clientDataJSON);
  return {
    authenticatorData: Uint8Array.from(raw.authenticatorData),
    clientData,
    longForm: len === lengths.long,
    sig: parseDerSignature(raw.signature),
  };
}

/** The clientDataJSON a browser produces for `digest` at `origin`. */
export function clientDataJSONFor(digest: Uint8Array, origin = DEFAULT_ORIGIN, chromeLongForm = false): Uint8Array {
  const json = `{"type":"webauthn.get","challenge":"${challengeFor(digest)}","origin":"${origin}","crossOrigin":false`
    + (chromeLongForm ? CHROME_EXTRA_MEMBER : '') + '}';
  return utf8ToBytes(json);
}

/** The 32-byte message a passkey actually signs. */
export function webauthnMessage(a: WebAuthnAssertion, lengths = COMPILED_CLIENT_DATA_LENGTHS): Uint8Array {
  const cd = a.clientData.subarray(0, a.longForm ? lengths.long : lengths.short);
  return sha256(new Uint8Array([...a.authenticatorData, ...sha256(cd)]));
}

/**
 * Check an assertion off-chain exactly as the circuit will, so the app can
 * show a clear error before spending time on a proof.
 */
export function verifyWebAuthnAssertion(
  a: WebAuthnAssertion,
  digest: Uint8Array,
  pk: Secp256r1Point,
  rpId: string = DEFAULT_RP_ID,
  lengths = COMPILED_CLIENT_DATA_LENGTHS,
): boolean {
  const prefix = utf8ToBytes(`{"type":"webauthn.get","challenge":"${challengeFor(digest)}"`);
  if (bytesToHex(a.clientData.subarray(0, prefix.length)) !== bytesToHex(prefix)) return false;
  if (!a.longForm && a.clientData.subarray(lengths.short).some((b) => b !== 0)) return false;
  if (bytesToHex(a.authenticatorData.subarray(0, 32)) !== bytesToHex(rpIdHash(rpId))) return false;
  const flags = a.authenticatorData[32];
  if ((flags & FLAG_UP) === 0 || (flags & FLAG_UV) === 0) return false;
  const point = p256.Point.fromAffine({ x: pk.x, y: pk.y });
  const sig = new p256.Signature(a.sig.r, a.sig.s).toBytes('compact');
  return p256.verify(sig, webauthnMessage(a, lengths), point.toBytes(), { prehash: false, lowS: false });
}

/**
 * Produce a passkey-format assertion with a software P-256 key. Used by tests
 * and by demo mode on devices without a platform passkey (labelled as such in
 * the UI): the vault cannot tell the difference, by design.
 */
export function signLikePasskey(
  sk: Uint8Array,
  digest: Uint8Array,
  opts: { origin?: string; rpId?: string; flags?: number; chromeLongForm?: boolean; signCount?: number } = {},
): WebAuthnAssertion {
  const authenticatorData = new Uint8Array(37);
  authenticatorData.set(rpIdHash(opts.rpId ?? DEFAULT_RP_ID));
  authenticatorData[32] = opts.flags ?? FLAG_UP | FLAG_UV;
  new DataView(authenticatorData.buffer).setUint32(33, opts.signCount ?? 0);
  const clientDataJSON = clientDataJSONFor(digest, opts.origin ?? DEFAULT_ORIGIN, opts.chromeLongForm ?? false);
  const msg = sha256(new Uint8Array([...authenticatorData, ...sha256(clientDataJSON)]));
  const signature = p256.sign(msg, sk, { prehash: false, format: 'der' });
  return toWebAuthnAssertion({ authenticatorData, clientDataJSON, signature });
}
