// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors
//
// What has happened, in the owner's words. Each row opens to show what the
// transaction published and what stayed on the device.

import { useState } from 'react';
import { fmtShort, type Snapshot } from '../demo/store.js';

export function Activity({ s }: { s: Snapshot }) {
  const [open, setOpen] = useState<number>();
  return (
    <section className="activity" aria-labelledby="act-h">
      <div className="activity-head">
        <h2 id="act-h" className="disp">Activity</h2>
        <span className="small muted">Only you can read these labels. On-chain they are anonymous counters.</span>
      </div>
      <ol>
        {s.activity.map((a, i) => {
          const id = s.activity.length - i;
          const isOpen = open === id;
          return (
            <li key={id}>
              <button type="button" className="act-row" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? undefined : id)}>
                <span className="mono act-date">{fmtShort(a.at)}</span>
                <span className="act-text"><span className={`act-dot tone-${a.tone}`} aria-hidden="true" />{a.what}</span>
                <span className="mono act-more">{isOpen ? 'Hide' : 'What the chain saw'}</span>
              </button>
              {isOpen && (
                <div className="act-split fade-in">
                  <div className="tone-public">
                    <span className="eyebrow">Published</span>
                    <ul>{a.published.map((p) => <li key={p}>{p}</li>)}</ul>
                  </div>
                  <div className="tone-private">
                    <span className="eyebrow">Stayed on the device</span>
                    {a.keptPrivate.length ? <ul>{a.keptPrivate.map((p) => <li key={p}>{p}</li>)}</ul> : <p className="small muted">Nothing private was involved.</p>}
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
