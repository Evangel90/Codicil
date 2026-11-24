// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors

import { fmtDate, type Activity } from '../demo/store.js';

export function Timeline({ items, title }: { items: Activity[]; title: string }) {
  return (
    <section className="timeline" aria-labelledby="timeline-title">
      <h2 id="timeline-title">{title}</h2>
      <ol>
        {items.map((a, i) => (
          <li key={i}>
            <div className="tl-head">
              <strong>{a.what}</strong>
              <span className="muted small">{a.who}, {fmtDate(a.at)}</span>
            </div>
            <div className="tl-split">
              <div>
                <span className="tl-label tl-public">Published</span>
                <ul>{a.published.map((p) => <li key={p}>{p}</li>)}</ul>
              </div>
              {a.keptPrivate.length > 0 && (
                <div>
                  <span className="tl-label tl-private">Stayed private</span>
                  <ul>{a.keptPrivate.map((p) => <li key={p}>{p}</li>)}</ul>
                </div>
              )}
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
