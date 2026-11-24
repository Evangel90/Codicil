// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors
//
// The owner's passkey. Uses the device's real platform authenticator (Face ID,
// Touch ID, Windows Hello) when this page's origin matches the one the vault
// was compiled for; otherwise falls back to a software key that produces the
// identical format, and the UI says so.

import type { Secp256r1Point } from '@midnight-ntwrk/compact-runtime';
import {
  clientDataLengths,
  COMPILED_CLIENT_DATA_LENGTHS,
  newP256Key,
  p256PointFromBytes,
  signLikePasskey,
  toWebAuthnAssertion,
  type P256Key,
  type WebAuthnAssertion,
} from '@codicil/sdk';

export type PasskeyKind = 'device' | 'demo';

export interface OwnerPasskey {
  kind: PasskeyKind;
  pk: Secp256r1Point;
  /** Device passkeys: the credential id. Demo keys: the software key. */
  credentialId?: Uint8Array;
  software?: P256Key;
}

export interface PasskeySupport {
  available: boolean;
  /** Plain-language reason when a device passkey cannot be used here. */
  reason?: string;
}

const buf = (b: Uint8Array): ArrayBuffer => b.slice().buffer as ArrayBuffer;

export async function passkeySupport(): Promise<PasskeySupport> {
  const lengths = clientDataLengths(window.location.origin);
  if (lengths.short !== COMPILED_CLIENT_DATA_LENGTHS.short) {
    return {
      available: false,
      reason: `This demo vault was compiled for http://localhost:5173, so Face ID / Touch ID only works there. A demo key is used instead.`,
    };
  }
  if (!window.PublicKeyCredential || !navigator.credentials) {
    return { available: false, reason: 'This browser does not support passkeys. A demo key is used instead.' };
  }
  try {
    const ok = await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
    return ok
      ? { available: true }
      : { available: false, reason: 'No Face ID, Touch ID or Windows Hello on this device. A demo key is used instead.' };
  } catch {
    return { available: false, reason: 'Passkeys are unavailable here. A demo key is used instead.' };
  }
}

/** Create a passkey on this device (asks for Face ID / Touch ID). */
export async function createDevicePasskey(): Promise<OwnerPasskey> {
  const cred = (await navigator.credentials.create({
    publicKey: {
      rp: { name: 'Codicil demo', id: window.location.hostname },
      user: {
        id: buf(crypto.getRandomValues(new Uint8Array(16))),
        name: 'codicil-demo-owner',
        displayName: 'Codicil demo owner',
      },
      challenge: buf(crypto.getRandomValues(new Uint8Array(32))),
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }],   // ES256 = P-256
      authenticatorSelection: { userVerification: 'required', residentKey: 'preferred' },
      attestation: 'none',
      timeout: 60_000,
    },
  })) as PublicKeyCredential | null;
  if (!cred) throw new Error('Passkey creation was cancelled.');
  const response = cred.response as AuthenticatorAttestationResponse;
  const spki = response.getPublicKey?.();
  if (!spki) throw new Error('This browser did not return the passkey public key.');
  const raw = new Uint8Array(spki).slice(-65);   // SPKI ends with the 0x04‖x‖y point
  return { kind: 'device', pk: p256PointFromBytes(raw), credentialId: new Uint8Array(cred.rawId) };
}

export function createDemoPasskey(): OwnerPasskey {
  const software = newP256Key();
  return { kind: 'demo', pk: software.pk, software };
}

/** Ask the passkey to approve `digest`. */
export async function approveWithPasskey(passkey: OwnerPasskey, digest: Uint8Array): Promise<WebAuthnAssertion> {
  if (passkey.kind === 'demo') return signLikePasskey(passkey.software!.sk, digest);
  const cred = (await navigator.credentials.get({
    publicKey: {
      challenge: buf(digest),
      rpId: window.location.hostname,
      allowCredentials: [{ type: 'public-key', id: buf(passkey.credentialId!) }],
      userVerification: 'required',
      timeout: 60_000,
    },
  })) as PublicKeyCredential | null;
  if (!cred) throw new Error('The passkey request was cancelled.');
  const r = cred.response as AuthenticatorAssertionResponse;
  return toWebAuthnAssertion({
    authenticatorData: new Uint8Array(r.authenticatorData),
    clientDataJSON: new Uint8Array(r.clientDataJSON),
    signature: new Uint8Array(r.signature),
  });
}
