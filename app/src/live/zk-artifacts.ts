// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors
//
// The circuit artifacts, fetched over HTTP. To prove a call, the proof server
// needs that circuit's proving key, verifier key and ZKIR, and Midnight.js
// sends them along with each request. They are the compiler's output
// (`contracts/managed/codicil_vault/{keys,zkir,compiler}`), served next to the
// app at `/zk/codicil_vault/`.
//
// The keys are large: 448 MB for a passkey check-in, 108 MB for a claim. So
// every download reports progress, and finished downloads are kept (in the
// browser's Cache Storage) and reused until the file on the server changes.

import {
  createProverKey,
  createVerifierKey,
  createZKIR,
  ZKConfigProvider,
  type ProverKey,
  type VerifierKey,
  type ZKIR,
} from '@midnight-ntwrk/midnight-js/types';

/** Progress of one download. `total` is 0 when the server did not say. */
export interface ArtifactProgress {
  /** "checkInPasskey" */
  circuit: string;
  kind: 'prover' | 'verifier' | 'zkir';
  loaded: number;
  total: number;
  /** True when the bytes came from this device's cache instead of the network. */
  cached: boolean;
}

/** Somewhere to keep downloaded artifacts between visits. */
export interface ArtifactCache {
  /** The stored bytes, if a copy with this exact tag is held. */
  get(url: string, tag: string): Promise<Uint8Array | undefined>;
  put(url: string, tag: string, bytes: Uint8Array): Promise<void>;
}

/** The app could not get an artifact. `status` 404 means the keys were never built or served. */
export class ArtifactError extends Error {
  override name = 'ArtifactError';
  constructor(message: string, readonly url: string, readonly status?: number) {
    super(message);
  }
}

export interface HttpZkConfigOptions {
  fetch?: typeof fetch;
  cache?: ArtifactCache;
  onProgress?: (p: ArtifactProgress) => void;
}

const TAG_HEADER = 'x-codicil-tag';

/** Cache Storage, where the browser has it. Kept per origin; survives reloads. */
export function browserArtifactCache(name = 'codicil-zk-v1'): ArtifactCache | undefined {
  if (typeof caches === 'undefined') return undefined;
  return {
    async get(url, tag) {
      try {
        const hit = await (await caches.open(name)).match(url);
        if (!hit || hit.headers.get(TAG_HEADER) !== tag) return undefined;
        return new Uint8Array(await hit.arrayBuffer());
      } catch {
        return undefined;
      }
    },
    async put(url, tag, bytes) {
      try {
        const body = new Blob([bytes.slice().buffer as ArrayBuffer]);
        await (await caches.open(name)).put(url, new Response(body, { headers: { [TAG_HEADER]: tag, 'content-length': String(bytes.length) } }));
      } catch {
        // Out of space, or a private window: the download still worked, it is just not kept.
      }
    },
  };
}

export class HttpZkConfigProvider<K extends string> extends ZKConfigProvider<K> {
  private readonly base: string;
  private readonly fetchFn: typeof fetch;
  private readonly cache?: ArtifactCache;
  private readonly onProgress?: (p: ArtifactProgress) => void;
  private readonly inFlight = new Map<string, Promise<Uint8Array>>();
  private readonly small = new Map<string, Uint8Array>();
  private runtimeVersion?: Promise<string>;

  /** @param baseUrl where the compiler's output directory is served, e.g. `http://localhost:5173/zk/codicil_vault` */
  constructor(baseUrl: string, options: HttpZkConfigOptions = {}) {
    super();
    this.base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
    this.fetchFn = options.fetch ?? ((...args) => fetch(...args));
    this.cache = options.cache;
    this.onProgress = options.onProgress;
  }

  async getProverKey(circuitId: K): Promise<ProverKey> {
    return createProverKey(await this.load(`keys/${circuitId}.prover`, circuitId, 'prover'));
  }

  async getVerifierKey(circuitId: K): Promise<VerifierKey> {
    return createVerifierKey(await this.load(`keys/${circuitId}.verifier`, circuitId, 'verifier'));
  }

  async getZKIR(circuitId: K): Promise<ZKIR> {
    return createZKIR(await this.load(`zkir/${circuitId}.bzkir`, circuitId, 'zkir'));
  }

  /** The compact-runtime version the artifacts were compiled against, from the compiler's own record. */
  override getArtifactRuntimeVersion(): Promise<string> {
    this.runtimeVersion ??= this.load('compiler/contract-info.json', 'contract-info', 'zkir').then((bytes) => {
      const info = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
      const version = info['runtime-version'] ?? info.runtimeVersion;
      if (typeof version !== 'string') throw new ArtifactError('contract-info.json does not say which runtime the contract was compiled for', this.base);
      return version;
    });
    this.runtimeVersion.catch(() => { this.runtimeVersion = undefined; });
    return this.runtimeVersion;
  }

  /** True if the server has this circuit's proving key. A build made with `--skip-zk` has none. */
  async hasProverKey(circuitId: K): Promise<boolean> {
    try {
      const res = await this.fetchFn(new URL(`keys/${circuitId}.prover`, this.base), { method: 'HEAD' });
      return res.ok && !(res.headers.get('content-type') ?? '').includes('text/html');
    } catch {
      return false;
    }
  }

  private load(path: string, circuit: string, kind: ArtifactProgress['kind']): Promise<Uint8Array> {
    const small = this.small.get(path);
    if (small) return Promise.resolve(small);
    let pending = this.inFlight.get(path);
    if (!pending) {
      pending = this.download(path, circuit, kind).finally(() => this.inFlight.delete(path));
      this.inFlight.set(path, pending);
    }
    return pending;
  }

  private async download(path: string, circuit: string, kind: ArtifactProgress['kind']): Promise<Uint8Array> {
    const url = new URL(path, this.base).toString();
    const report = (loaded: number, total: number, cached: boolean) => this.onProgress?.({ circuit, kind, loaded, total, cached });

    // Only proving keys are worth a round trip to ask whether the kept copy is current.
    if (kind === 'prover' && this.cache) {
      const tag = await this.tagOf(url);
      if (tag) {
        const kept = await this.cache.get(url, tag);
        if (kept) {
          report(kept.length, kept.length, true);
          return kept;
        }
        const fresh = await this.fetchBytes(url, report);
        await this.cache.put(url, tag, fresh);
        return fresh;
      }
    }
    const bytes = await this.fetchBytes(url, report);
    if (kind !== 'prover') this.small.set(path, bytes);
    return bytes;
  }

  /** What identifies this version of the file on the server: its ETag, or failing that its size. */
  private async tagOf(url: string): Promise<string | undefined> {
    try {
      const head = await this.fetchFn(url, { method: 'HEAD' });
      if (!head.ok) return undefined;
      return head.headers.get('etag') ?? head.headers.get('content-length') ?? undefined;
    } catch {
      return undefined;
    }
  }

  private async fetchBytes(url: string, report: (loaded: number, total: number, cached: boolean) => void): Promise<Uint8Array> {
    let res: Response;
    try {
      res = await this.fetchFn(url);
    } catch (cause) {
      throw Object.assign(new ArtifactError(`could not reach ${url}`, url), { cause });
    }
    if (!res.ok) throw new ArtifactError(`${url} answered ${res.status}`, url, res.status);
    // A single-page app's server answers a missing file with its index page.
    if ((res.headers.get('content-type') ?? '').includes('text/html')) throw new ArtifactError(`${url} is not being served`, url, 404);
    const total = Number(res.headers.get('content-length') ?? 0);
    if (!res.body) {
      const all = new Uint8Array(await res.arrayBuffer());
      report(all.length, all.length, false);
      return all;
    }
    const reader = res.body.getReader();
    // With a known length, write straight into one buffer: a 448 MB key should not exist twice in memory.
    let out = total > 0 ? new Uint8Array(total) : new Uint8Array(1 << 16);
    let loaded = 0;
    let lastReport = 0;
    report(0, total, false);
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (loaded + value.length > out.length) {
        const bigger = new Uint8Array(Math.max(out.length * 2, loaded + value.length));
        bigger.set(out.subarray(0, loaded));
        out = bigger;
      }
      out.set(value, loaded);
      loaded += value.length;
      if (loaded - lastReport >= 1 << 20) {
        lastReport = loaded;
        report(loaded, total, false);
      }
    }
    report(loaded, total || loaded, false);
    return loaded === out.length ? out : out.slice(0, loaded);
  }
}
