// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors
//
// Where the demo starts: four things one vault can do. The will is set up by
// hand, step by step. The others start with a vault already made, so the
// story begins at the part that is new.

import { useState } from 'react';
import type { Tab } from '../demo/commands.js';
import { createDemoPasskey } from '../demo/passkey.js';
import { defaultSetup, demo } from '../demo/store.js';

export type Story = 'will' | 'disclosure' | 'canary' | 'build';

const STORIES: { id: Story; who: string; title: string; text: string; start: string; tab?: Tab }[] = [
  {
    id: 'will', who: 'A parent with savings', title: 'Leave a will',
    text: 'Amara divides her savings between her children and a grandchild. If she stops checking in, they can claim. You set it up yourself, one step at a time.',
    start: 'Set up the vault',
  },
  {
    id: 'disclosure', who: 'A reporter', title: 'Seal a disclosure',
    text: 'Documents that must come out if she is stopped. She seals them today. Nobody can open them until her vault releases, and then anybody can.',
    start: 'Start with a vault ready', tab: 'messages',
  },
  {
    id: 'canary', who: 'An organisation', title: 'Publish a canary',
    text: 'A public page that says the owner is still checking in, next to a statement she stands behind. When the check-ins stop, everyone sees it.',
    start: 'Start with a vault ready', tab: 'messages',
  },
  {
    id: 'build', who: 'A developer', title: 'Make a contract wait for the release',
    text: 'A savings contract written by someone else pays out only once the vault says it has released. It takes one line of Compact.',
    start: 'Start with a vault ready', tab: 'savings',
  },
];

export function Stories({ onPick }: { onPick: (story: Story, tab?: Tab) => void }) {
  const [busy, setBusy] = useState<Story>();
  const [error, setError] = useState<string>();
  const pick = async (story: Story, tab?: Tab) => {
    if (story === 'will') return onPick(story);
    setBusy(story);
    setError(undefined);
    try {
      // The same vault the wizard makes with its defaults, signed with a key kept in this tab.
      await demo.setUp(createDemoPasskey(), defaultSetup());
      onPick(story, tab);
    } catch (e) {
      setError(`The vault could not be created: ${e instanceof Error ? e.message : String(e)}`);
      setBusy(undefined);
    }
  };
  return (
    <main className="wrap stories" id="main">
      <div className="wiz-head">
        <h1 className="disp">What do you want to see?</h1>
        <p className="lede">
          The idea is always the same: you check in, and if you stop, your vault releases what you chose. Until then
          nobody can tell what that is, or who it is for. One vault can do all four of these.
        </p>
      </div>
      <ul className="story-list">
        {STORIES.map((x) => (
          <li key={x.id}>
            <button type="button" className="card story" disabled={busy !== undefined} onClick={() => void pick(x.id, x.tab)}>
              <span className="small muted">{x.who}</span>
              <span className="disp story-title">{x.title}</span>
              <span className="story-text">{x.text}</span>
              <span className="story-start">{busy === x.id ? 'Creating the vault…' : x.start} <span className="arw" aria-hidden="true">→</span></span>
            </button>
          </li>
        ))}
      </ul>
      {error && <p className="err-inline" role="alert">{error}</p>}
      <p className="small muted">
        Everything runs in this browser tab, on a simulated chain with a clock you control. The contracts are the real,
        compiled ones.
      </p>
    </main>
  );
}
