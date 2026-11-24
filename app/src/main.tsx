// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './obsidian.css';
import './styles.css';
import './layout.css';
import { App } from './App.js';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
