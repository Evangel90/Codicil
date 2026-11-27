// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors

import { lazy, Suspense, useEffect, useState } from 'react';
import { Landing } from './views/Landing.js';
import { useTheme } from './theme.js';

// The demo pulls in the contract runtime (WASM); load it only when opened.
const Demo = lazy(() => import('./views/Demo.js').then((m) => ({ default: m.Demo })));
// The live app adds Midnight.js and the ledger on top of that.
const LiveApp = lazy(() => import('./views/live/LiveApp.js').then((m) => ({ default: m.LiveApp })));
// Reading a vault from the network needs the indexer client, and nothing else of the live app.
const Reader = lazy(() => import('./views/Reader.js').then((m) => ({ default: m.Reader })));

const route = () => {
  const hash = window.location.hash;
  return hash.startsWith('#/demo') ? 'demo' : /^#\/app(\/|$)/.test(hash) ? 'app' : /^#\/read(\/|$)/.test(hash) ? 'read' : 'home';
};

function Loading() {
  return (
    <div className="boot" aria-busy="true">
      <span className="eyebrow">Loading the vault contract</span>
      <span className="boot-bar" aria-hidden="true"><span /></span>
    </div>
  );
}

export function App() {
  const theme = useTheme();
  const [page, setPage] = useState(route);
  useEffect(() => {
    const onHash = () => { setPage(route()); window.scrollTo(0, 0); };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  return (
    <div className="ox app-root" data-theme={theme}>
      {page === 'demo' ? (
        <Suspense fallback={<Loading />}>
          <Demo />
        </Suspense>
      ) : page === 'app' ? (
        <Suspense fallback={<Loading />}>
          <LiveApp />
        </Suspense>
      ) : page === 'read' ? (
        <Suspense fallback={<Loading />}>
          <Reader />
        </Suspense>
      ) : <Landing />}
    </div>
  );
}
