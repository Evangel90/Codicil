// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors
//
// Small pieces the live screens share.

import { useState, type ReactNode } from 'react';
import { Phase } from '@codicil/contracts/vault';
import { Icon, ICONS } from '../../components/ui.js';
import type { Problem } from '../../live/problems.js';
import type { VaultFacts } from '../../live/store.js';
import { session } from '../../live/session.js';
import { networkName } from '../../live/wallet.js';

/** Something went wrong, or something is missing: what, and what to do. */
export function ProblemCard({ problem, onRetry, retryLabel = 'Try again', children }: {
  problem: Problem; onRetry?: () => void; retryLabel?: string; children?: ReactNode;
}) {
  return (
    <section className="notice-card is-warn" role="alert">
      <span className="warn-ring" aria-hidden="true"><Icon d={ICONS.shield} size={18} stroke={1.6} /></span>
      <div className="alert-body">
        <h2>{problem.title}</h2>
        <p>{problem.body}</p>
        {problem.command && <CopyLine text={problem.command} label="Copy the command" />}
        {problem.detail && !problem.command && <p className="mono small muted live-detail">{problem.detail}</p>}
        <div className="btn-row">
          {problem.link && <a className="btn btn-secondary btn-sm" href={problem.link.href} target="_blank" rel="noreferrer">{problem.link.label}</a>}
          {onRetry && problem.retry && <button type="button" className="btn btn-primary btn-sm" onClick={onRetry}>{retryLabel}</button>}
          {children}
        </div>
      </div>
    </section>
  );
}

/** A line of text to copy: a command, an address, an invitation. */
export function CopyLine({ text, label = 'Copy', shown }: { text: string; label?: string; shown?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="live-copy">
      <code className="mono">{shown ?? text}</code>
      <button
        type="button"
        className="btn btn-secondary btn-sm"
        onClick={() => {
          void navigator.clipboard?.writeText(text).catch(() => undefined);
          setCopied(true);
          setTimeout(() => setCopied(false), 1600);
        }}
      >
        {copied ? 'Copied' : label}
      </button>
    </div>
  );
}

/** Save text as a file from the browser. */
export function downloadText(filename: string, text: string, type = 'text/plain'): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const shortAddress = (a: string): string => (a.length > 24 ? `${a.slice(0, 16)}…${a.slice(-6)}` : a);

/** Where the vault lives, said plainly every time it matters. */
export function NetworkLine({ network }: { network?: string }) {
  return (
    <span className="net">
      <span className="dot tone-pending" aria-hidden="true" />
      {network ? `Midnight ${networkName(network)} · a test network` : 'Midnight test networks'}
    </span>
  );
}

const PHASE_WORDS = {
  [Phase.armed]: ['armed', 'Sealed. The owner is checking in.'],
  [Phase.pending]: ['pending', 'The switch has started. The owner can still cancel.'],
  [Phase.released]: ['released', 'Released. Heirs can claim.'],
} as const;

export function PhaseLine({ vault }: { vault: VaultFacts }) {
  const [tone, words] = PHASE_WORDS[vault.phase];
  return (
    <span className={`state-line tone-${tone}`}>
      <Icon d={ICONS.clock} size={14} stroke={2} />{words}
    </span>
  );
}

/**
 * The step anyone may take when it is time: start the switch after a missed
 * deadline, or release the will after the challenge window. Whoever presses
 * it pays the network fee from their own wallet.
 */
export function AnyoneCan({ vault, busy, onStart, onRelease, who }: {
  vault: VaultFacts; busy: boolean; onStart: () => void; onRelease: () => void; who: string;
}) {
  if (!vault.canStartSwitch && !vault.canRelease) return null;
  return (
    <section className="card pad-24 stack-12">
      <h2 className="disp h-card">{vault.canRelease ? 'The will can be released now' : 'The check-in deadline has passed'}</h2>
      <p className="muted">
        {vault.canRelease
          ? `The time ${who === 'you' ? 'you' : who} had to cancel is over. Releasing is one transaction that anyone may send. It moves no money by itself: it lets each heir claim their own share.`
          : `${who} has not checked in. Anyone may now start the switch. That does not release anything: it starts the waiting period in which the owner can still cancel.`}
      </p>
      <div className="btn-row">
        {vault.canRelease
          ? <button type="button" className="btn btn-primary" disabled={busy} onClick={onRelease}>Release the will</button>
          : <button type="button" className="btn btn-primary" disabled={busy} onClick={onStart}>Start the switch</button>}
        <span className="small muted">Your wallet pays the network fee, less than 1 DUST.</span>
      </div>
    </section>
  );
}

/** What a transaction needs besides tokens, when one of them is missing. */
export function ProofServerNote({ up, keys }: { up?: boolean; keys?: boolean }) {
  if (keys === false) {
    return (
      <ProblemCard problem={{
        kind: 'keys-missing', title: 'This copy of the app has no proving keys', retry: false,
        body: 'You can look at your vaults, but nothing can be sent: the files a proof is made from were not built. If you run Codicil from the source code, build them with the command below (about 4 minutes) and start the app again.',
        command: 'npm run compile:full',
      }} />
    );
  }
  if (up === false) {
    return (
      <ProblemCard
        onRetry={() => void session.refresh()}
        retryLabel="Check again"
        problem={{
          kind: 'proof-server', title: 'Your proof server is not running', retry: true,
          body: 'You can look at your vaults, but every transaction needs a proof, and proofs are made on your own computer so your secrets never leave it. Start Docker, then run this. If you have run it before, run `docker start proof-server` instead.',
          command: 'docker run -d --name proof-server -p 127.0.0.1:6300:6300 midnightntwrk/proof-server:9.0.2',
        }}
      />
    );
  }
  return null;
}
