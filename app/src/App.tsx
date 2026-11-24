// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors

import { lazy, Suspense, useEffect, useState } from 'react';
import { Landing } from './views/Landing.js';

// The demo pulls in the contract runtime (WASM); load it only when opened.
const Demo = lazy(() => import('./views/Demo.js').then((m) => ({ default: m.Demo })));

const route = () => (window.location.hash.startsWith('#/demo') ? 'demo' : 'home');

export function App() {
  const [page, setPage] = useState(route);
  useEffect(() => {
    const onHash = () => { setPage(route()); window.scrollTo(0, 0); };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  return page === 'demo' ? (
    <Suspense fallback={<p className="wrap loading">Loading the vault contract…</p>}>
      <Demo />
    </Suspense>
  ) : <Landing />;
}
