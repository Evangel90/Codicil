// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors
//
// What can go wrong between a person and a network, in words they can act on.
// Everything here is pure: it takes an error or a set of balances and returns
// a title, a sentence or two, and what to do next. The screens only display it.

import { contractErrorCode, explainError } from '@codicil/sdk';
import {
  DUST_FOR_CALL, DUST_FOR_DEPLOYMENT, FAUCETS, formatDust, LOCAL_PROOF_SERVER, type WalletBalances,
} from './wallet.js';

export const PROOF_SERVER_COMMAND =
  'docker run -d --name proof-server -p 127.0.0.1:6300:6300 midnightntwrk/proof-server:9.0.2';

export type ProblemKind =
  | 'input'
  | 'no-wallet'
  | 'old-wallet'
  | 'wrong-network'
  | 'connection-declined'
  | 'no-night'
  | 'no-dust'
  | 'low-dust'
  | 'proof-server'
  | 'keys-missing'
  | 'rejected'
  | 'refused'
  | 'disconnected'
  | 'network'
  | 'contract'
  | 'unknown';

export interface Problem {
  kind: ProblemKind;
  title: string;
  /** What happened and what to do, in one or two sentences. */
  body: string;
  /** A link that helps: a faucet, an install page. */
  link?: { label: string; href: string };
  /** Something to copy and run. */
  command?: string;
  /** The network's or the contract's own words, shown small for support. */
  detail?: string;
  /** True when trying the same thing again can work without changing anything else first. */
  retry: boolean;
}

// ─── Errors the live layer raises itself ────────────────────────────────────

export class NoWallet extends Error {
  override name = 'NoWallet';
  constructor() { super('no Midnight wallet was found in this browser'); }
}

export class OldWallet extends Error {
  override name = 'OldWallet';
  constructor(readonly found: string) { super(`the wallet's connector is version ${found}`); }
}

export class WrongNetwork extends Error {
  override name = 'WrongNetwork';
  /** @param actual the network the wallet is on, or "" if it would not say */
  constructor(readonly actual: string, readonly expected: readonly string[]) { super(`the wallet is on ${actual || 'another network'}, not ${expected.join(' or ')}`); }
}

export class ProofServerDown extends Error {
  override name = 'ProofServerDown';
  constructor(readonly url: string) { super(`no proof server answered at ${url}`); }
}

/** A problem with what the person typed or pasted; its message is shown as is. */
export class InputProblem extends Error {
  override name = 'InputProblem';
}

// ─── Reading an error ───────────────────────────────────────────────────────

/** Never show a provider token: Preprod's service URLs can carry one. */
export function redact(text: string): string {
  return text.replace(/(project_id=)[^&\s"'`)<>:,;]+/gi, '$1<hidden>');
}

/** Every message in an error's chain of causes, outermost first. */
export function errorChain(e: unknown): string[] {
  const out: string[] = [];
  for (let x: unknown = e, depth = 0; x !== undefined && x !== null && depth < 8; depth++) {
    const o = x as { name?: unknown; message?: unknown; reason?: unknown; code?: unknown; _tag?: unknown; cause?: unknown };
    const parts = [o._tag, o.code, o.message, o.reason].filter((p): p is string => typeof p === 'string' && p.length > 0);
    if (parts.length > 0) out.push(redact([...new Set(parts)].join(': ')));
    else if (typeof x === 'string') out.push(redact(x));
    if (o.cause === undefined || o.cause === x) break;
    x = o.cause;
  }
  return out;
}

/**
 * The node's own reason for refusing a transaction, if the error holds one.
 * Midnight.js and the wallets wrap it several layers deep; the innermost
 * message that names a rule is the useful one ("1010: Invalid Transaction:
 * Transaction would exhaust the block limits", "Custom error: 110").
 */
export function nodeReason(e: unknown): string | undefined {
  const chain = errorChain(e);
  const telling = /invalid transaction|custom error|\b10\d\d:|exhaust|block limits|verifier ?key|double ?spend|stale|bad ?proof|ttl|expired/i;
  for (let i = chain.length - 1; i >= 0; i--) if (telling.test(chain[i])) return chain[i];
  return undefined;
}

const has = (chain: string[], pattern: RegExp): boolean => chain.some((m) => pattern.test(m));
const named = (e: unknown, name: string): boolean => {
  for (let x: unknown = e, depth = 0; x && depth < 8; x = (x as { cause?: unknown }).cause, depth++) {
    if ((x as { name?: unknown }).name === name) return true;
  }
  return false;
};
const connectorCode = (e: unknown): string | undefined => {
  for (let x: unknown = e, depth = 0; x && depth < 8; x = (x as { cause?: unknown }).cause, depth++) {
    const o = x as { type?: unknown; code?: unknown };
    if (o.type === 'DAppConnectorAPIError' && typeof o.code === 'string') return o.code;
  }
  return undefined;
};

export interface ProblemContext {
  /** "preview" or "preprod": chooses the faucet and names the network. */
  network?: string;
  /** "Lace" */
  wallet?: string;
  /** Where the proof server is expected. */
  proofServer?: string;
}

/** Turn anything a live action can throw into something a person can act on. */
export function describeProblem(e: unknown, ctx: ProblemContext = {}): Problem {
  const wallet = ctx.wallet ?? 'your wallet';
  const network = ctx.network ?? 'the test network';
  const chain = errorChain(e);
  const detail = chain.join(' · ') || undefined;
  const code = connectorCode(e);

  if (e instanceof Error && e.name === 'InputProblem') {
    const m = e.message;
    return { kind: 'input', title: 'Check what you entered', body: m.charAt(0).toUpperCase() + m.slice(1) + (/[.!?]$/.test(m) ? '' : '.'), retry: false };
  }
  if (named(e, 'NotAllowedError')) {
    return { kind: 'rejected', title: 'The passkey was not used', body: 'Face ID, Touch ID or your device PIN was cancelled or timed out. Nothing was sent and nothing changed. Try again when you are ready.', retry: true };
  }
  if (named(e, 'NoWallet')) {
    return {
      kind: 'no-wallet', title: 'Install the Lace wallet',
      body: 'Codicil uses the Lace wallet to pay network fees and sign transactions, and this browser does not have it. Install Lace in Chrome, create a wallet, switch it to a Midnight test network (Preview or Preprod), then come back and reload this page.',
      link: { label: 'Get Lace', href: 'https://www.lace.io/' }, retry: true,
    };
  }
  if (e instanceof OldWallet) {
    return {
      kind: 'old-wallet', title: 'Update the Lace wallet',
      body: `This version of Lace speaks an older version of Midnight's wallet connector (${e.found}). Update the Lace extension to the latest version and reload this page.`,
      link: { label: 'Get Lace', href: 'https://www.lace.io/' }, retry: true,
    };
  }
  if (e instanceof WrongNetwork) {
    const names = e.expected.map(cap).join(' or ');
    return {
      kind: 'wrong-network', title: `Switch ${wallet} to a Midnight test network`,
      body: `${e.actual ? `Your wallet is on ${cap(e.actual)}. ` : ''}This version of Codicil runs on Midnight's test networks only: ${names}. In Lace, open Settings, then Network, choose one of them, and connect again. Preview is the quicker one to start on: a new wallet is ready there in minutes.`,
      retry: true,
    };
  }
  if (e instanceof ProofServerDown) {
    return {
      kind: 'proof-server', title: 'Start your proof server',
      body: `Every transaction needs a zero-knowledge proof, and the proof is made on your own computer so your secrets never leave it. Nothing answered at ${e.url}. Start Docker, run the command below once, wait a few seconds, and try again.`,
      command: PROOF_SERVER_COMMAND, detail, retry: true,
    };
  }
  if (named(e, 'ArtifactError')) {
    const status = (e as { status?: number }).status;
    return status === 404
      ? {
        kind: 'keys-missing', title: 'This copy of the app has no proving keys',
        body: 'The files a proof is made from were not built or are not being served. If you run Codicil from the source code, run `npm run compile:full` (about 4 minutes) and start the app again.',
        command: 'npm run compile:full', detail, retry: false,
      }
      : { kind: 'network', title: 'A proving key could not be downloaded', body: 'The download of the files a proof is made from was interrupted. Check your connection and try again; what was already downloaded is kept.', detail, retry: true };
  }
  if (code === 'Rejected' || code === 'PermissionRejected' || has(chain, /user (rejected|denied|declined|cancell?ed)|rejected by (the )?user|request (was )?rejected/i)) {
    return { kind: 'rejected', title: 'You declined in your wallet', body: `Nothing was sent and nothing changed. If that was a mistake, try again and approve the request in ${wallet}.`, retry: true };
  }
  if (code === 'Disconnected' || has(chain, /\bdisconnected\b|connection (to the wallet )?(was )?lost/i)) {
    return { kind: 'disconnected', title: `${cap(wallet)} disconnected`, body: `The connection to ${wallet} was lost. Unlock the wallet and connect again. Nothing was sent.`, detail, retry: true };
  }
  if (code === 'InsufficientFunds' || has(chain, /could not balance dust|insufficient ?funds|not enough dust|insufficient dust/i)) {
    return {
      kind: 'no-dust', title: 'Not enough DUST for the fee yet',
      body: `Fees on Midnight are paid in DUST, which your tNIGHT generates over time. Your wallet does not hold enough for this transaction yet. Nothing was sent. In Lace, check that "Generate tDUST" is on, wait a few minutes, and try again.`,
      detail, retry: true,
    };
  }
  // A circuit's own refusal can sit a few causes deep once Midnight.js has wrapped it.
  const whole = new Error(chain.join(' | '));
  const contract = contractErrorCode(e) ?? contractErrorCode(whole);
  if (contract) return { kind: 'contract', title: 'The vault refused this', body: explainError(whole), detail: contract, retry: false };

  const reason = nodeReason(e);
  if (reason) {
    return {
      kind: 'refused', title: 'The network refused the transaction',
      body: `It was sent, and a ${cap(network)} node turned it down, so nothing changed. The node's reason is below. If it mentions time or expiry, try again; otherwise please report it with that reason.`,
      detail: reason, retry: true,
    };
  }
  if (named(e, 'ProofServerError') || has(chain, /proof server|prove-tx|failed to prove/i)) {
    return {
      kind: 'proof-server', title: 'The proof could not be made',
      body: `The proof server at ${ctx.proofServer ?? LOCAL_PROOF_SERVER} stopped or refused the request. The largest proof needs about 5 GB of memory: in Docker Desktop, give Docker at least 8 GB, start the proof server again, and try again. Nothing was sent.`,
      command: PROOF_SERVER_COMMAND, detail, retry: true,
    };
  }
  if (named(e, 'WatchTimeoutError') || has(chain, /timed? ?out|timeout/i)) {
    return {
      kind: 'network', title: 'Still waiting for the network',
      body: 'The transaction was sent but no confirmation arrived in time. It may still go through: wait a minute and reload this page before trying again, so you do not do it twice.',
      detail, retry: true,
    };
  }
  if (has(chain, /failed to fetch|networkerror|fetch failed|econnrefused|socket|websocket|ENOTFOUND/i)) {
    return {
      kind: 'network', title: `Could not reach ${cap(network)}`,
      body: 'The app could not reach the network services your wallet points to. Check your internet connection and that your wallet is unlocked, then try again. Nothing was sent.',
      detail, retry: true,
    };
  }
  return { kind: 'unknown', title: 'Something went wrong', body: explainError(e), detail, retry: true };
}

const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

// ─── Is the wallet ready? ───────────────────────────────────────────────────

export type Need = 'deployment' | 'call';

/**
 * What stands between this wallet and a transaction, if anything. A person
 * new to Midnight meets these in order: no tokens, then tokens that have not
 * generated any DUST yet, then not quite enough DUST for eight transactions.
 */
export function walletReadiness(balances: WalletBalances, need: Need, ctx: ProblemContext & { address?: string } = {}): Problem | undefined {
  const network = ctx.network ?? 'the test network';
  const faucet = FAUCETS[network];
  if (balances.night === 0n && balances.dust === 0n) {
    return {
      kind: 'no-night', title: 'Your wallet has no tNIGHT yet',
      body: `tNIGHT is the test token of Midnight ${cap(network)}. It is free and has no value. Ask the faucet for some${ctx.address ? ', sending it to your address below' : ''}, wait for it to arrive in ${ctx.wallet ?? 'your wallet'}, then turn on "Generate tDUST" so it can pay fees.`,
      link: faucet ? { label: `Open the ${cap(network)} faucet`, href: faucet } : undefined,
      detail: ctx.address, retry: true,
    };
  }
  const needed = need === 'deployment' ? DUST_FOR_DEPLOYMENT : DUST_FOR_CALL;
  if (balances.dust === 0n) {
    return {
      kind: 'no-dust', title: 'Your wallet has no DUST yet',
      body: `Fees on Midnight are paid in DUST. You cannot buy it: your tNIGHT generates it over time, once you turn on "Generate tDUST" in Lace. ${need === 'deployment' ? `Creating a vault takes about ${formatDust(needed, 0)} DUST in all, which 5,000 tNIGHT generates in about 12 minutes.` : 'This takes less than 1 DUST, which arrives within a minute or two.'}`,
      retry: true,
    };
  }
  if (balances.dust < needed) {
    return {
      kind: 'low-dust', title: 'Not quite enough DUST yet',
      body: `Your wallet holds ${formatDust(balances.dust)} DUST. ${need === 'deployment' ? `Creating a vault is eight transactions and takes about ${formatDust(needed, 0)} DUST in all.` : 'This takes up to 1 DUST.'} It keeps generating while you wait; this page checks again by itself.`,
      retry: true,
    };
  }
  return undefined;
}
