// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors
//
// Witness implementations: the only place private data enters the contract.
// Each actor (owner, heir, attacker) is just a different private state.

import type { WitnessContext } from '@midnight-ntwrk/compact-runtime';
import type { HeirLeaf, Witnesses } from '../contracts/managed/codicil_spike/contract/index.js';
import { signEd25519, signP256, type EdKey, type HeirKey, type MerklePath, type P256Key } from './crypto.js';

export interface OwnerSecrets {
  passkey: P256Key;
  passkeySalt: Uint8Array;
  ed: EdKey;
  edSalt: Uint8Array;
  /** Test hook: corrupt the digest before signing (simulates a replayed / wrong signature). */
  tamperSignature?: boolean;
}

export interface HeirSecrets {
  leaf: HeirLeaf;
  path: MerklePath;
  key: HeirKey;
  keySalt: Uint8Array;
  /** Test hook: lie about the payout quotient to prove the circuit catches it. */
  inflatePayout?: bigint;
}

export interface SpikePrivateState {
  owner?: OwnerSecrets;
  heir?: HeirSecrets;
}

type Ctx = WitnessContext<unknown, SpikePrivateState>;

function owner(ctx: Ctx): OwnerSecrets {
  if (!ctx.privateState.owner) throw new Error('no owner secrets in private state');
  return ctx.privateState.owner;
}

function heir(ctx: Ctx): HeirSecrets {
  if (!ctx.privateState.heir) throw new Error('no heir secrets in private state');
  return ctx.privateState.heir;
}

function maybeTamper(o: OwnerSecrets, digest: Uint8Array): Uint8Array {
  if (!o.tamperSignature) return digest;
  const d = Uint8Array.from(digest);
  d[0] ^= 0xff;
  return d;
}

export const witnesses: Witnesses<SpikePrivateState> = {
  ownerPasskey: (ctx) => [ctx.privateState, owner(ctx).passkey.pk],
  ownerPasskeySalt: (ctx) => [ctx.privateState, owner(ctx).passkeySalt],
  ownerPasskeySign: (ctx, digest) => {
    const o = owner(ctx);
    return [ctx.privateState, signP256(o.passkey.sk, maybeTamper(o, digest))];
  },
  ownerEdKey: (ctx) => [ctx.privateState, owner(ctx).ed.pk],
  ownerEdSalt: (ctx) => [ctx.privateState, owner(ctx).edSalt],
  ownerEdSign: (ctx, digest) => {
    const o = owner(ctx);
    return [ctx.privateState, signEd25519(o.ed.sk, maybeTamper(o, digest))];
  },
  heirLeaf: (ctx) => [ctx.privateState, heir(ctx).leaf],
  heirLeafPath: (ctx, _leafHash) => [ctx.privateState, heir(ctx).path],
  heirSecretKey: (ctx) => [ctx.privateState, heir(ctx).key.sk],
  heirKeySalt: (ctx) => [ctx.privateState, heir(ctx).keySalt],
  payoutDivision: (ctx, snapshot, bps) => {
    const product = snapshot * bps;
    const q = product / 10_000n + (heir(ctx).inflatePayout ?? 0n);
    const r = product % 10_000n;
    return [ctx.privateState, [q, r]];
  },
};
