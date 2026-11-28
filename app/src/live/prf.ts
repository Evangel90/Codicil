// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors
//
// Opening a keyring with a passkey (docs/DECISIONS.md D22). The WebAuthn PRF
// extension asks the passkey for 32 bytes that depend only on the passkey and
// an input the app chooses. The same synced passkey gives the same bytes on
// every device, so Face ID unlocks the person's records anywhere their
// passkey is.
//
// Not every browser or passkey provider supports it. When one does not, the
// passkey still signs check-ins, and the printed recovery code is the way in.
//
// The owner's passkey is one credential for both: it signs check-ins
// (demo/passkey.ts) and opens the keyring here.

import { newPrfInput, p256PointFromBytes } from '@codicil/sdk';
import type { OwnerPasskey } from '../demo/passkey.js';
import { fromHex, toBase64Url, toHex } from './codec.js';

/** What a passkey slot needs: the passkey's answer, and what to ask it next time. */
export interface PrfSlot {
  secret: Uint8Array;
  prfInput: Uint8Array;
  /** The credential id, as hex (the keyring's form). */
  credentialId: string;
}

/** How to ask for a passkey slot again. */
export interface PrfRequest {
  credentialId: string;
  prfInput: Uint8Array;
}

const buf = (b: Uint8Array): ArrayBuffer => b.slice().buffer as ArrayBuffer;

interface PrfOutput {
  enabled?: boolean;
  results?: { first?: ArrayBuffer | Uint8Array };
}

const prfOf = (cred: PublicKeyCredential): PrfOutput | undefined =>
  (cred.getClientExtensionResults() as { prf?: PrfOutput }).prf;

const bytesOf = (v: ArrayBuffer | Uint8Array | undefined): Uint8Array | undefined =>
  v === undefined ? undefined : v instanceof Uint8Array ? v : new Uint8Array(v);

/** Whether this browser can make passkeys at all. Whether it can unlock with one is only known once it has tried. */
export function passkeysHere(): boolean {
  return typeof window !== 'undefined' && !!window.PublicKeyCredential && !!navigator.credentials;
}

/**
 * Make a passkey on this device, asking it for the keyring secret at the same
 * time. Some providers answer only when the passkey is used, not when it is
 * made; then the app asks once more straight away. `prf` is absent when the
 * browser or provider does not support it.
 */
export async function createPasskeyWithPrf(user = 'codicil'): Promise<{ passkey: OwnerPasskey; prf?: PrfSlot }> {
  const prfInput = newPrfInput();
  const cred = (await navigator.credentials.create({
    publicKey: {
      rp: { name: 'Codicil', id: window.location.hostname },
      user: { id: buf(crypto.getRandomValues(new Uint8Array(16))), name: user, displayName: 'Codicil' },
      challenge: buf(crypto.getRandomValues(new Uint8Array(32))),
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }],   // ES256 = P-256, what the vault verifies
      authenticatorSelection: { userVerification: 'required', residentKey: 'preferred' },
      attestation: 'none',
      timeout: 60_000,
      extensions: { prf: { eval: { first: buf(prfInput) } } } as AuthenticationExtensionsClientInputs,
    },
  })) as PublicKeyCredential | null;
  if (!cred) throw new Error('Passkey creation was cancelled.');
  const response = cred.response as AuthenticatorAttestationResponse;
  const spki = response.getPublicKey?.();
  if (!spki) throw new Error('This browser did not return the passkey public key.');
  const raw = new Uint8Array(spki).slice(-65);   // SPKI ends with the 0x04‖x‖y point
  const credentialId = new Uint8Array(cred.rawId);
  const passkey: OwnerPasskey = { kind: 'device', pk: p256PointFromBytes(raw), credentialId };
  const out = prfOf(cred);
  let secret = bytesOf(out?.results?.first);
  if (!secret && out?.enabled) {
    try {
      secret = await askPrf([{ credentialId: toHex(credentialId), prfInput }]);
    } catch {
      secret = undefined;
    }
  }
  return { passkey, ...(secret && secret.length >= 32 ? { prf: { secret: secret.slice(0, 32), prfInput, credentialId: toHex(credentialId) } } : {}) };
}

/**
 * Ask one of these passkeys for its keyring secret: Face ID, Touch ID or the
 * device PIN. Throws when none answers with one, which also covers a browser
 * without PRF.
 */
export async function askPrf(slots: readonly PrfRequest[]): Promise<Uint8Array> {
  if (slots.length === 0) throw new Error('there is no passkey to ask');
  const evalByCredential: Record<string, { first: ArrayBuffer }> = {};
  for (const s of slots) evalByCredential[toBase64Url(fromHex(s.credentialId))] = { first: buf(s.prfInput) };
  const cred = (await navigator.credentials.get({
    publicKey: {
      challenge: buf(crypto.getRandomValues(new Uint8Array(32))),
      rpId: window.location.hostname,
      allowCredentials: slots.map((s) => ({ type: 'public-key' as const, id: buf(fromHex(s.credentialId)) })),
      userVerification: 'required',
      timeout: 60_000,
      extensions: { prf: { evalByCredential } } as AuthenticationExtensionsClientInputs,
    },
  })) as PublicKeyCredential | null;
  if (!cred) throw new Error('The passkey request was cancelled.');
  const secret = bytesOf(prfOf(cred)?.results?.first);
  if (!secret || secret.length < 32) throw new NoPrf();
  return secret.slice(0, 32);
}

/** The passkey answered, but without the secret: this browser or provider cannot unlock with it. */
export class NoPrf extends Error {
  override name = 'NoPrf';
  constructor() { super('this passkey cannot unlock Codicil in this browser'); }
}
