// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors
//
// The wallet boundary. The live chain needs five things from a wallet: which
// services to talk to, the person's addresses, their balances, a balanced and
// signed transaction, and a submission. Two wallets provide them:
//
//   lace.ts                       the Lace browser extension, through the
//                                 Midnight DApp connector (window.midnight)
//   scripts/headless-wallet.ts    a wallet built on the wallet SDK from a seed,
//                                 for the end-to-end run that needs no clicks
//
// Transactions cross this boundary as bytes, because each wallet runs its own
// copy of the ledger.

import { bech32m } from '@scure/base';
import { toHex } from './codec.js';

/** Where the wallet says the network's services are. */
export interface WalletServices {
  /** "preprod", "preview", "mainnet", or "undeployed" for a local network. */
  networkId: string;
  indexerUri: string;
  indexerWsUri: string;
  nodeUri: string;
  proofServerUri: string;
}

export interface WalletBalances {
  /** tNIGHT in STAR: 1,000,000 per tNIGHT. */
  night: bigint;
  /** DUST in SPECK: 10^15 per DUST. It pays fees and regenerates over time. */
  dust: bigint;
}

export interface WalletAddress {
  /** As the person sees it: mn_addr_preprod1… */
  bech32: string;
  /** The same address as 32 bytes of hex: what a contract pays to. */
  hex: string;
}

export interface WalletAdapter {
  /** Shown to the person: "Lace". */
  readonly name: string;
  services(): Promise<WalletServices>;
  address(): Promise<WalletAddress>;
  /** The two shielded public keys Midnight.js asks every wallet for, hex. */
  shieldedKeys(): Promise<{ coinPublicKey: string; encryptionPublicKey: string }>;
  balances(): Promise<WalletBalances>;
  /**
   * Pay the fee for a proven transaction, add what it needs to balance, and
   * sign it. This is where the person approves. Rejects if they decline.
   */
  balanceTransaction(tx: Uint8Array, ttl?: Date): Promise<Uint8Array>;
  /** Send a finished transaction to the network. */
  submitTransaction(tx: Uint8Array): Promise<void>;
}

/**
 * The Midnight test networks live mode runs on. Which one is the wallet's
 * choice: the app reads it from the wallet and never asks.
 */
export const TEST_NETWORKS = ['preview', 'preprod'] as const;

/** "Preview", "Preprod": a network's name as people write it. */
export const networkName = (id: string): string => id.charAt(0).toUpperCase() + id.slice(1);

/** The faucets that give test tokens, by network. */
export const FAUCETS: Record<string, string> = {
  preprod: 'https://midnight-tmnight-preprod.nethermind.dev/',
  preview: 'https://faucet.preview.midnight.network/',
};

/** The proof server every Midnight wallet expects on the person's own machine. */
export const LOCAL_PROOF_SERVER = 'http://localhost:6300';

export const STAR_PER_NIGHT = 1_000_000n;
export const SPECK_PER_DUST = 1_000_000_000_000_000n;

/** A deployment is eight transactions; measured at about 30 DUST on Preprod and Preview (docs/VALIDATION.md V14). */
export const DUST_FOR_DEPLOYMENT = 30n * SPECK_PER_DUST;
/** An ordinary call cost 0.24 to 0.58 DUST in the same runs. */
export const DUST_FOR_CALL = 1n * SPECK_PER_DUST;

/** "12.5" for 12,500,000 STAR. At most `places` decimals, no trailing zeros. */
export function formatUnits(amount: bigint, perUnit: bigint, places = 2): string {
  const negative = amount < 0n;
  const abs = negative ? -amount : amount;
  const scale = 10n ** BigInt(places);
  const scaled = (abs * scale) / perUnit;
  const whole = (scaled / scale).toLocaleString('en-GB');
  const frac = (scaled % scale).toString().padStart(places, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
}

export const formatNight = (star: bigint, places = 2): string => formatUnits(star, STAR_PER_NIGHT, places);
export const formatDust = (speck: bigint, places = 1): string => formatUnits(speck, SPECK_PER_DUST, places);

/** "12.5" tNIGHT → 12,500,000 STAR. Undefined if it is not a positive amount with at most 6 decimals. */
export function parseNight(text: string): bigint | undefined {
  const m = /^(\d{1,12})(?:\.(\d{1,6}))?$/.exec(text.trim());
  if (!m) return undefined;
  const star = BigInt(m[1]) * STAR_PER_NIGHT + BigInt((m[2] ?? '').padEnd(6, '0'));
  return star > 0n ? star : undefined;
}

const hrp = (kind: string, networkId: string): string => (networkId === 'mainnet' ? kind : `${kind}_${networkId}`);

function decodeKey(text: string, kind: string, networkId: string, what: string, length?: number): string {
  let prefix: string;
  let bytes: Uint8Array;
  try {
    ({ prefix, bytes } = bech32m.decodeToBytes(text.trim(), false));
  } catch {
    throw new Error(`that is not a Midnight ${what}`);
  }
  if (prefix !== hrp(kind, networkId)) {
    throw new Error(`that ${what} is for another network (it starts with ${prefix}); this vault is on ${networkId}`);
  }
  if (length !== undefined && bytes.length !== length) throw new Error(`that ${what} has the wrong length`);
  return toHex(bytes);
}

/** An unshielded address (mn_addr_preprod1…) as the 32 bytes of hex a contract pays to. */
export const addressToHex = (bech32: string, networkId: string): string => decodeKey(bech32, 'mn_addr', networkId, 'address', 32);

/** The reverse, for showing an address the way the wallet does. */
export function addressFromHex(hex: string, networkId: string): string {
  const bytes = Uint8Array.from(hex.match(/../g) ?? [], (b) => parseInt(b, 16));
  return bech32m.encode(hrp('mn_addr', networkId), bech32m.toWords(bytes), false);
}

/** A shielded coin public key in the wallet's Bech32m form, as hex. Hex passes through. */
export const coinPublicKeyToHex = (key: string, networkId: string): string =>
  (/^[0-9a-f]+$/i.test(key) ? key.toLowerCase() : decodeKey(key, 'mn_shield-cpk', networkId, 'shielded key'));

/** A shielded encryption public key in the wallet's Bech32m form, as hex. Hex passes through. */
export const encryptionPublicKeyToHex = (key: string, networkId: string): string =>
  (/^[0-9a-f]+$/i.test(key) ? key.toLowerCase() : decodeKey(key, 'mn_shield-epk', networkId, 'shielded key'));
