// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors
//
// Dark by default, as the design intends; the choice is remembered per browser.

import { useSyncExternalStore } from 'react';

export type Theme = 'dark' | 'light';

const KEY = 'codicil.theme';
const listeners = new Set<() => void>();

function read(): Theme {
  try {
    return localStorage.getItem(KEY) === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

let theme: Theme = read();
const apply = () => {
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'light' ? '#F5F3EE' : '#080807');
};
apply();

export function toggleTheme() {
  theme = theme === 'dark' ? 'light' : 'dark';
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    // Private mode: the choice lasts for this visit only.
  }
  apply();
  listeners.forEach((fn) => fn());
}

export const useTheme = (): Theme =>
  useSyncExternalStore((fn) => { listeners.add(fn); return () => listeners.delete(fn); }, () => theme);
