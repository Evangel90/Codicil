// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors
//
// The will's rules in plain words, each with what it means in practice,
// and warnings for risky combinations.

import { planSummary } from '../demo/guide.js';
import type { VaultSetup } from '../demo/store.js';

export function PlanSummary({ setup, now, title = 'In plain words' }: { setup: VaultSetup; now: number; title?: string }) {
  const { rules, warnings } = planSummary(setup, now);
  return (
    <section className="summary stack-16" aria-labelledby="sum-h">
      <h2 id="sum-h" className="disp h-sec">{title}</h2>
      {warnings.length > 0 && (
        <ul className="warnings" aria-label="Things to consider">
          {warnings.map((w) => (
            <li key={w.text} className={`warn-${w.tone}`}>
              <span className="mono warn-tag">{w.tone === 'warn' ? 'CHECK' : 'NOTE'}</span>
              <span><strong>{w.topic}.</strong> {w.text}</span>
            </li>
          ))}
        </ul>
      )}
      <dl className="rules">
        {rules.map((r) => (
          <div key={r.topic}>
            <dt className="eyebrow">{r.topic}</dt>
            <dd><span>{r.rule}</span><span className="small muted">{r.meaning}</span></dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
