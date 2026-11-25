// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors
//
// The integration a developer writes to make a contract inheritable, as shown
// on the savings screen. These lines are copied from
// contracts/src/inheritable_escrow.compact; a test fails if they drift from it.

/** The one line: ask the vault, and stop unless it says the will is released. */
export const HOOK_LINE = 'assert(vault.isReleasedForContract(), "vault not released");';

export const INTEGRATION_SOURCE: { text: string; key?: boolean }[] = [
  { text: 'contract CodicilVault {' },
  { text: '  circuit isReleasedForContract(): Boolean;' },
  { text: '}' },
  { text: '' },
  { text: 'export circuit withdrawToBeneficiary(recipient: UserAddress): [] {' },
  { text: '  assert(!withdrawn, "already withdrawn");' },
  { text: '  assert(beneficiaryCommitment(beneficiarySecret()) == beneficiaryCommit, "not the beneficiary");' },
  { text: `  ${HOOK_LINE}`, key: true },
  { text: '  withdrawn = true;' },
  { text: '  sendUnshielded(tokenColor, held, right<ContractAddress, UserAddress>(disclose(recipient)));' },
  { text: '}' },
];
