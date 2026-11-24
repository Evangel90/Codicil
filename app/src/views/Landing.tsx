// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors

import { useEffect, useState } from 'react';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { Mark } from '../components/ui.js';

// The hero: a line of a will, written in ink, then sealed. Its letters give
// way to the commitment that is all the blockchain will ever hold.
const WILL_LINE = 'To my daughter Ada, half of everything, from the day I am gone.';
// A real SHA-256 of the line (the vault uses salted commitments of the same kind).
const SEALED = bytesToHex(sha256(utf8ToBytes(WILL_LINE)));

function SealedLine() {
  const [progress, setProgress] = useState(0);   // 0 = ink, 1 = sealed
  const [sealed, setSealed] = useState(false);
  const reduced = typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  useEffect(() => {
    const target = sealed ? 1 : 0;
    if (reduced) { setProgress(target); return; }
    let raf = 0;
    const start = performance.now();
    const from = progress;
    const step = (t: number) => {
      const k = Math.min(1, (t - start) / 1400);
      setProgress(from + (target - from) * (1 - Math.pow(1 - k, 3)));
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sealed]);

  useEffect(() => {
    const id = setTimeout(() => setSealed(true), 1600);
    return () => clearTimeout(id);
  }, []);

  // Characters turn into hex from left to right as the seal presses down.
  const n = Math.round(progress * WILL_LINE.length);
  const chars = WILL_LINE.split('').map((c, i) =>
    i < n ? SEALED[i % SEALED.length] : c);

  return (
    <figure className="seal-figure">
      <blockquote className={`will-line${progress > 0.98 ? ' is-sealed' : ''}`} aria-live="polite">
        {chars.map((c, i) => (
          <span key={i} className={i < n ? 'ch-hex' : 'ch-ink'}>{c}</span>
        ))}
      </blockquote>
      <figcaption>
        <span className="muted">{sealed ? 'What the blockchain stores: a commitment that reveals nothing.' : 'What you write: private, on your device.'}</span>
        <button type="button" className="btn btn-quiet" onClick={() => setSealed((s) => !s)} aria-pressed={sealed}>
          {sealed ? 'Show what I wrote' : 'Seal it'}
        </button>
      </figcaption>
    </figure>
  );
}

export function Landing() {
  return (
    <div className="landing">
      <header className="wrap topline">
        <a href="#/" className="brand"><Mark /> <span>Codicil</span></a>
        <a href="#/demo" className="btn btn-quiet">Open the demo</a>
      </header>

      <main className="wrap">
        <section className="hero">
          <h1>Your will stays yours.</h1>
          <p className="lede">
            Codicil passes your crypto to the people you choose if you stop checking in, without
            ever publishing who they are, what they get, or when you were last active.
          </p>
          <SealedLine />
          <div className="hero-actions">
            <a href="#/demo" className="btn btn-seal">Try the demo</a>
            <span className="muted">Runs in your browser. Uses Face ID or Touch ID if you have it.</span>
          </div>
        </section>

        <section className="how" aria-labelledby="how-title">
          <h2 id="how-title">How it works</h2>
          <ol className="how-steps">
            <li>
              <h3>Write a private will</h3>
              <p className="muted">Heirs, shares, unlock dates and backups stay on your device. The chain stores one number that seals them.</p>
            </li>
            <li>
              <h3>Check in now and then</h3>
              <p className="muted">One Face ID glance proves you are alive. The proof checks your passkey without revealing it.</p>
            </li>
            <li>
              <h3>If you stop, your heirs claim</h3>
              <p className="muted">After a missed deadline, or a report from guardians you chose, you get a week to cancel. Then each heir claims their share privately.</p>
            </li>
          </ol>
        </section>

        <section className="compare" aria-labelledby="compare-title">
          <h2 id="compare-title">Other blockchains publish your will</h2>
          <div className="compare-grid">
            <div>
              <h3 className="muted">On a public chain</h3>
              <ul>
                <li>Every heir's address, visible to anyone</li>
                <li>How much each heir gets</li>
                <li>Every check-in, linked to your wallet</li>
              </ul>
            </div>
            <div>
              <h3>With Codicil on Midnight</h3>
              <ul>
                <li>A single commitment to the whole will</li>
                <li>Shares are proven, not shown</li>
                <li>Check-ins prove a passkey without naming it</li>
              </ul>
            </div>
          </div>
        </section>
      </main>

      <footer className="wrap footer muted">
        <p>Built on <a href="https://midnight.network">Midnight</a> with zero-knowledge proofs.</p>
        <p><a href="https://github.com/Evangel90/Codicil">Source code on GitHub</a>, Apache-2.0.</p>
      </footer>
    </div>
  );
}
