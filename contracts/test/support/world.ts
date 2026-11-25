// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors
//
// A deployed vault with an owner, a three-heir will and an outsider, plus
// helpers that drive it exactly as the app does: compute the digest with the
// contract's pure circuits, sign it with the passkey / wallet format, attach
// the approval to the private state, call the circuit.

import {
  encodeRawTokenType,
  encodeUserAddress,
  sampleRawTokenType,
  sampleUserAddress,
} from '@midnight-ntwrk/compact-runtime';
import { Contract, ledger, pureCircuits as pure, type VaultConfig } from '@codicil/contracts/vault';
import {
  attestationDigest,
  buildGuardianSet,
  buildWill,
  guardianLeaf,
  guardianSecrets,
  newGuardianSecret,
  signAttestation,
  checkInDigest,
  claimPackage,
  createWitnesses,
  newEdKey,
  newHeirKey,
  newP256Key,
  newSalt,
  rpIdHash,
  softwareSigners,
  VAULT_OPTIONS_OFF,
  willUpdateDigest,
  withPasskeyApproval,
  withWalletApproval,
  type ClaimantSecrets,
  type GuardianSet,
  type CodicilPrivateState,
  type EdKey,
  type HeirEntry,
  type HeirKey,
  type P256Key,
  type Will,
} from '@codicil/sdk';
import { Simulator } from './harness.js';

export const CONTRACT_DIR = new URL('../../managed/codicil_vault', import.meta.url).pathname;
export const DAY = 86_400;
export const T0 = 1_800_000_000;
export const FIRST_DEADLINE = T0 + 10 * DAY;
export const MAX_PERIOD = 30 * DAY;
export const CHALLENGE = 7 * DAY;
export const CLAIM_WINDOW = 90 * DAY;
export const RELEASED_AT = FIRST_DEADLINE + CHALLENGE;
export const LOCKED_UNTIL = T0 + 400 * DAY;

export type Sim = Simulator<CodicilPrivateState>;
export type Via = 'passkey' | 'wallet';

export interface Owner {
  passkey: P256Key;
  wallet: EdKey;
  state: CodicilPrivateState;
}

export interface Person { key: HeirKey; keySalt: Uint8Array }

export interface World {
  sim: Sim;
  owner: Owner;
  will: Will;
  /** heirs[i] owns will leaf i; heirs[0] has a backup. */
  heirs: Person[];
  backup: Person;
  /** A well-formed claimant whose leaf was never in the will. */
  outsider: ClaimantSecrets;
  color: Uint8Array;
  /** Three guardian secrets; any two can start the countdown. */
  guardians: Uint8Array[];
  guardianSet: GuardianSet;
  attestor: { key: P256Key; salt: Uint8Array };
}

export const nobody: CodicilPrivateState = {};
export const L = (sim: Sim) => ledger(sim.ledgerState);

export function newOwner(): Owner {
  const passkey = newP256Key();
  const wallet = newEdKey();
  return {
    passkey,
    wallet,
    state: { passkey: { pk: passkey.pk, salt: newSalt() }, wallet: { pk: wallet.pk, salt: newSalt() } },
  };
}

export const newPerson = (): Person => ({ key: newHeirKey(), keySalt: newSalt() });
const opening = (p: Person) => ({ pk: p.key.pk, salt: p.keySalt });

export function asClaimant(will: Will, index: number, who: Person): CodicilPrivateState {
  return { claimant: { ...claimPackage(will, index), key: who.key, keySalt: who.keySalt } };
}

export function newRecipient() {
  const hex = sampleUserAddress();
  return { hex, address: { bytes: encodeUserAddress(hex) } };
}

export interface DeployOptions {
  entries?: (people: { heirs: Person[]; backup: Person }) => HeirEntry[];
  /** A hand-built will (bypasses buildWill's checks, as a buggy client might). */
  will?: (people: { heirs: Person[]; backup: Person }) => Will;
  config?: Partial<VaultConfig>;
  strictWitnesses?: boolean;
  owner?: Owner;
}

export async function deployVault(opts: DeployOptions = {}): Promise<World> {
  const owner = opts.owner ?? newOwner();
  const heirs = [newPerson(), newPerson(), newPerson()];
  const backup = newPerson();
  const entries = opts.entries?.({ heirs, backup }) ?? [
    { heir: opening(heirs[0]), backup: opening(backup), shareBps: 5000n },
    { heir: opening(heirs[1]), shareBps: 3333n },
    { heir: opening(heirs[2]), shareBps: 1667n, unlockAt: BigInt(LOCKED_UNTIL) },
  ];
  const will = opts.will?.({ heirs, backup }) ?? buildWill(entries);

  const stranger = newPerson();
  const strayWill = buildWill([{ heir: opening(stranger), shareBps: 10_000n }]);
  const outsider = { ...claimPackage(strayWill, 0), key: stranger.key, keySalt: stranger.keySalt };

  const color = encodeRawTokenType(sampleRawTokenType());
  const guardians = [newGuardianSecret(), newGuardianSecret(), newGuardianSecret()];
  const guardianSet = buildGuardianSet(guardians.map(guardianLeaf), 2);
  const attestor = { key: newP256Key(), salt: newSalt() };
  const config: VaultConfig = {
    ownerPasskeyCommit: pure.passkeyCommitment(owner.passkey.pk, owner.state.passkey!.salt),
    ownerEdCommit: pure.edKeyCommitment(owner.wallet.pk, owner.state.wallet!.salt),
    passkeyRpIdHash: rpIdHash(),
    willRoot: will.root,
    firstDeadline: BigInt(FIRST_DEADLINE),
    maxPeriod: BigInt(MAX_PERIOD),
    challengeWindow: BigInt(CHALLENGE),
    claimWindow: BigInt(CLAIM_WINDOW),
    tokenColor: color,
    guardianRoot: guardianSet.root,
    guardianThreshold: guardianSet.threshold,
    attestorKeyCommit: pure.attestorCommitment(attestor.key.pk, attestor.salt),
    ...VAULT_OPTIONS_OFF,
    ...opts.config,
  };
  // Tests run "lax" witnesses by default so they can hand the circuit
  // approvals for the wrong digest and show the *circuit* rejects them.
  const witnesses = createWitnesses({ strict: opts.strictWitnesses ?? false });
  const sim = (await Simulator.deploy<CodicilPrivateState>(new Contract(witnesses), {}, config))
    .withProofChecks(CONTRACT_DIR);
  return { sim, owner, will, heirs, backup, outsider, color, guardians, guardianSet, attestor };
}

export interface SignOptions {
  /** Sign this digest instead of the right one (replay / tamper tests). */
  digest?: Uint8Array;
  /** Sign with someone else's keys. */
  signer?: Owner;
  passkey?: Parameters<typeof softwareSigners.passkey>[2];
}

/** Private state carrying an owner approval of `digest`. */
export function approve(w: World, via: Via, digest: Uint8Array, opts: SignOptions = {}): CodicilPrivateState {
  const signer = opts.signer ?? w.owner;
  const signed = opts.digest ?? digest;
  return via === 'passkey'
    ? withPasskeyApproval(signer.state, digest, softwareSigners.passkey(signer.passkey, signed, opts.passkey))
    : withWalletApproval(signer.state, digest, softwareSigners.wallet(signer.wallet, signed));
}

export async function checkIn(w: World, via: Via, next: number | bigint, time: number, opts: SignOptions = {}) {
  const nextDeadline = BigInt(next);
  const digest = checkInDigest(w.sim.address, nextDeadline, L(w.sim).nonce);
  const circuit = via === 'passkey' ? 'checkInPasskey' : 'checkInEd25519';
  return w.sim.call(circuit, { time, as: approve(w, via, digest, opts) }, nextDeadline);
}

export async function updateWill(w: World, via: Via, root: bigint, time: number, opts: SignOptions = {}) {
  const digest = willUpdateDigest(w.sim.address, root, L(w.sim).nonce);
  const circuit = via === 'passkey' ? 'updateWillPasskey' : 'updateWillEd25519';
  return w.sim.call(circuit, { time, as: approve(w, via, digest, opts) }, root);
}

/** Drive the vault to `released` via the timeout path. */
export async function release(w: World): Promise<void> {
  await w.sim.call('triggerTimeout', { time: FIRST_DEADLINE, as: nobody });
  await w.sim.call('finalizeRelease', { time: RELEASED_AT, as: nobody });
}

/** Private state of guardian `i`. */
export const asGuardian = (w: World, i: number): CodicilPrivateState =>
  ({ guardian: guardianSecrets(w.guardianSet, w.guardians[i]) });

export const vote = (w: World, i: number, time: number, asOf = time) =>
  w.sim.call('guardianAttest', { time, as: asGuardian(w, i) }, BigInt(asOf));

/** Private state carrying an attestation for `round` (default: the current round). */
export function attestation(w: World, opts: { round?: bigint; signer?: P256Key; digest?: Uint8Array } = {}): CodicilPrivateState {
  const digest = attestationDigest(w.sim.address, opts.round ?? L(w.sim).guardianRound);
  const signed = opts.digest ?? digest;
  return {
    attestor: {
      pk: w.attestor.key.pk,
      salt: w.attestor.salt,
      approval: { digest, proof: signAttestation((opts.signer ?? w.attestor.key).sk, signed) },
    },
  };
}
