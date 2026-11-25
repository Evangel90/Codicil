// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors
//
// Every assert message in the contracts, mapped to what the UI tells people.
// A test (contracts/test/errors.test.ts) fails if a contract message is
// missing here. Human-readable reference: docs/ERRORS.md.

export type Audience = 'owner' | 'heir' | 'anyone' | 'integrator';

export interface ErrorInfo {
  audience: Audience;
  /** Friendly, calm explanation for the UI. */
  message: string;
}

export const CONTRACT_ERRORS = {
  // Vault creation
  'vault needs an owner key': { audience: 'owner', message: 'Add a passkey or a wallet before creating the vault.' },
  'invalid vault settings': { audience: 'owner', message: 'The check-in period and challenge window must both be longer than zero.' },
  'grace period too long': { audience: 'owner', message: 'The grace period cannot be longer than the longest check-in period.' },
  // Owner: check-in and will updates
  'vault already released': { audience: 'owner', message: 'This vault has already been released to the heirs. It can no longer be changed.' },
  'switch already expired': { audience: 'owner', message: 'Your check-in deadline has passed. Start the challenge window, then check in to cancel it.' },
  'deadline must be in the future': { audience: 'owner', message: 'Choose a next check-in date in the future.' },
  'deadline too far': { audience: 'owner', message: 'That next check-in date is further away than this vault allows.' },
  'unknown owner key': { audience: 'owner', message: 'This passkey or wallet is not the one registered as the owner of this vault.' },
  'bad owner signature': { audience: 'owner', message: 'The approval signature could not be verified. Please approve again.' },
  'will locked': { audience: 'owner', message: 'The will can only be changed while the vault is active.' },
  // Passkey (WebAuthn) details
  'bad passkey data': { audience: 'owner', message: 'Your browser returned an approval this vault cannot read. Try again, or use another browser.' },
  'bad passkey challenge': { audience: 'owner', message: 'Your browser returned an approval this vault cannot read. Try again.' },
  'passkey signed something else': { audience: 'owner', message: 'The passkey approved a different action. Please approve again.' },
  'passkey is for another site': { audience: 'owner', message: 'This passkey belongs to a different website.' },
  'passkey user not verified': { audience: 'owner', message: 'Face ID, Touch ID or your device PIN is required to approve.' },
  // Wallet (CIP-30) details
  'not a wallet signature': { audience: 'owner', message: 'The wallet returned a signature in an unexpected format.' },
  'wallet signed something else': { audience: 'owner', message: 'The wallet signed a different message. Please approve again.' },
  // Funding and release
  'vault closed': { audience: 'anyone', message: 'This vault no longer accepts deposits.' },
  'not armed': { audience: 'anyone', message: 'The countdown has already started or the vault was released.' },
  'owner is still alive': { audience: 'anyone', message: 'The owner checked in on time. Nothing to do yet.' },
  'grace period open': { audience: 'anyone', message: 'The owner missed the deadline but is still within the grace period. The countdown can start when it ends.' },
  'not pending': { audience: 'anyone', message: 'The vault is not waiting for release.' },
  'challenge window open': { audience: 'anyone', message: 'The owner can still cancel. Release becomes possible when the challenge window ends.' },
  // Heirs
  'vault not released': { audience: 'heir', message: 'This vault has not been released yet.' },
  'not in will': { audience: 'heir', message: 'This claim package is not part of the current will. The owner may have updated it.' },
  'not the heir': { audience: 'heir', message: 'This key does not match the heir named in this share.' },
  'not the backup heir': { audience: 'heir', message: 'This key does not match the backup heir for this share.' },
  'primary claim window open': { audience: 'heir', message: 'The main heir still has time to claim this share.' },
  'share still locked': { audience: 'heir', message: 'This share unlocks at a later date set by the owner.' },
  'already claimed': { audience: 'heir', message: 'This share has already been claimed.' },
  'bad payout math': { audience: 'heir', message: 'The payout calculation was rejected. Please update the app and try again.' },
  'estate exhausted': { audience: 'heir', message: 'There is not enough left in the estate to pay this share.' },
  // Guardians and attestation
  'no guardians': { audience: 'anyone', message: 'This vault has no guardians.' },
  'stale timestamp': { audience: 'anyone', message: 'Your device clock looks wrong. Check the time and try again.' },
  'not a guardian': { audience: 'anyone', message: 'This guardian key is not registered for this vault.' },
  'already voted': { audience: 'anyone', message: 'You have already reported this vault in the current round.' },
  'unknown attestor': { audience: 'anyone', message: 'This attestation is not from the attestor the owner chose (or the vault has none).' },
  'bad attestation': { audience: 'anyone', message: 'The attestation is invalid or out of date. The owner may have checked in since it was signed.' },
  // Integrators
  'callable by contracts only': { audience: 'integrator', message: 'This check is for other contracts, not for direct calls.' },
  // Example escrow (contracts/src/inheritable_escrow.compact)
  'escrow closed': { audience: 'anyone', message: 'This escrow has already been paid out.' },
  'already withdrawn': { audience: 'heir', message: 'This escrow has already been paid out.' },
  'not the beneficiary': { audience: 'heir', message: 'This secret does not match the escrow beneficiary.' },
} as const satisfies Record<string, ErrorInfo>;

export type ContractErrorCode = keyof typeof CONTRACT_ERRORS;

/** Find the contract error inside a thrown error, if any. Longest match wins. */
export function contractErrorCode(err: unknown): ContractErrorCode | undefined {
  const text = err instanceof Error ? err.message : String(err);
  let best: ContractErrorCode | undefined;
  for (const code of Object.keys(CONTRACT_ERRORS) as ContractErrorCode[]) {
    if (text.includes(code) && (!best || code.length > best.length)) best = code;
  }
  return best;
}

/** A message for the UI: the friendly text for contract errors, or a generic fallback. */
export function explainError(err: unknown): string {
  const code = contractErrorCode(err);
  if (code) return CONTRACT_ERRORS[code].message;
  if (err instanceof Error && (err.name === 'MissingSecretError' || err.name === 'ApprovalMismatchError')) {
    return err.message.charAt(0).toUpperCase() + err.message.slice(1) + '.';
  }
  return 'Something went wrong. Nothing was changed on-chain.';
}
