// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors
//
// The Midnight docs assign the `ws` package as the global WebSocket before any
// wallet code runs, "which keeps WebSocket behavior consistent across Node
// versions". Import this module first wherever the wallet SDK is used.

import { WebSocket } from 'ws';

(globalThis as { WebSocket?: unknown }).WebSocket = WebSocket;
