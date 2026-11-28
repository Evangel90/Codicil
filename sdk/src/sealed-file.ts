// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors
//
// Sealed files (docs/DECISIONS.md D22). A file is sealed as a sealed message
// (sealed.ts) whose body is the file's name, type and bytes, padded so the
// stored size says little about the real one. The encrypted body is too large
// to carry in a letter, so it goes to a blob store (blobs.ts), and what people
// hold is a pointer: the sealed text without its body, plus where the body is
// stored and its hash.
//
// The register's fingerprint is the fingerprint of the whole sealed text, as
// for any sealed message, so the seal register works for files unchanged.

import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { fetchBody, storeBody, type BlobStore, type StoredBody } from './blobs.js';
import { openMessage, sealedFingerprint, sealMessage, type KeyPiece, type SealedMessage } from './sealed.js';

/** The largest file this version seals, in bytes. */
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAGIC = utf8ToBytes('CDF1');

export interface PlainFile {
  name: string;
  /** A media type such as "application/pdf". */
  type: string;
  bytes: Uint8Array;
}

/** What a recipient holds for a sealed file: everything but the body, and where the body is. */
export interface SealedFilePointer {
  version: 1;
  kind: 'file';
  vault: string;
  needed: number;
  recipientHalf: Uint8Array;
  nonce: Uint8Array;
  pieceChecks: Uint8Array[];
  body: StoredBody;
  /** The fingerprint of the whole sealed text, as a seal register records it. */
  fingerprint: Uint8Array;
}

/**
 * Padmé padding: the padded length keeps only the top bits of the real one, so
 * a stored size leaks O(log log n) bits and wastes at most about 12%.
 */
export function padmeLength(length: number): number {
  if (length < 2) return length;
  const e = Math.floor(Math.log2(length));
  const s = Math.floor(Math.log2(e)) + 1;
  const lastBits = e - s;
  const mask = 2 ** lastBits - 1;
  return Math.ceil(length / (mask + 1)) * (mask + 1);
}

const u16 = (n: number) => Uint8Array.of(n >>> 8, n & 0xff);
const u32 = (n: number) => Uint8Array.of(n >>> 24, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);

/** The file as one padded body: magic ‖ name ‖ type ‖ length ‖ bytes ‖ zeros. */
export function packFile(file: PlainFile): Uint8Array {
  if (file.bytes.length > MAX_FILE_BYTES) throw new Error(`a sealed file can be at most ${MAX_FILE_BYTES / 1024 / 1024} MB`);
  const name = utf8ToBytes(file.name.slice(0, 200));
  const type = utf8ToBytes(file.type.slice(0, 100) || 'application/octet-stream');
  const head = concatBytes(MAGIC, u16(name.length), name, u16(type.length), type, u32(file.bytes.length));
  const out = new Uint8Array(padmeLength(head.length + file.bytes.length));
  out.set(head);
  out.set(file.bytes, head.length);
  return out;
}

export function unpackFile(body: Uint8Array): PlainFile {
  const bad = () => new Error('this is not a sealed file');
  if (body.length < 12 || bytesToHex(body.subarray(0, 4)) !== bytesToHex(MAGIC)) throw bad();
  let at = 4;
  const read16 = () => { const n = (body[at] << 8) | body[at + 1]; at += 2; return n; };
  const nameLen = read16();
  const name = new TextDecoder().decode(body.subarray(at, at + nameLen)); at += nameLen;
  const typeLen = read16();
  const type = new TextDecoder().decode(body.subarray(at, at + typeLen)); at += typeLen;
  if (at + 4 > body.length) throw bad();
  const size = ((body[at] << 24) | (body[at + 1] << 16) | (body[at + 2] << 8) | body[at + 3]) >>> 0; at += 4;
  if (at + size > body.length) throw bad();
  return { name, type, bytes: body.slice(at, at + size) };
}

/**
 * Seal a file and store its encrypted body. Returns the pointer the recipient
 * keeps, one piece per guardian, and the whole sealed text (for a register's
 * `seal` arguments; it need not be kept).
 */
export async function sealFile(opts: {
  vault: string;
  file: PlainFile;
  pieces: number;
  needed: number;
  store: BlobStore;
}): Promise<{ pointer: SealedFilePointer; pieces: KeyPiece[]; sealed: SealedMessage }> {
  const { sealed, pieces } = await sealMessage({ vault: opts.vault, message: packFile(opts.file), pieces: opts.pieces, needed: opts.needed });
  const body = await storeBody(opts.store, sealed.ciphertext);
  const { ciphertext: _, ...rest } = sealed;
  return { pointer: { ...rest, kind: 'file', body, fingerprint: sealedFingerprint(sealed) }, pieces, sealed };
}

/** The whole sealed text again, from a pointer and its fetched body. */
export function sealedFromPointer(pointer: SealedFilePointer, ciphertext: Uint8Array): SealedMessage {
  const { kind: _k, body: _b, fingerprint, ...rest } = pointer;
  const sealed: SealedMessage = { ...rest, ciphertext };
  if (bytesToHex(sealedFingerprint(sealed)) !== bytesToHex(fingerprint)) {
    throw new Error('the stored file does not belong to this pointer');
  }
  return sealed;
}

/**
 * Open a sealed file: fetch its body, check it, rebuild the key from the
 * recipient's half and the guardians' pieces, decrypt and unpack. Throws a
 * BlobError when the body cannot be fetched and a SealedError when the key
 * cannot be rebuilt.
 */
export async function openSealedFile(pointer: SealedFilePointer, pieces: readonly KeyPiece[], stores: readonly BlobStore[]): Promise<PlainFile> {
  const ciphertext = await fetchBody(stores, pointer.body);
  return unpackFile(await openMessage(sealedFromPointer(pointer, ciphertext), pieces));
}

// ─── As text ────────────────────────────────────────────────────────────────

export function pointerToText(p: SealedFilePointer): string {
  return JSON.stringify({
    codicil: 'sealed-file', version: 1, vault: p.vault, needed: p.needed,
    recipientHalf: bytesToHex(p.recipientHalf), nonce: bytesToHex(p.nonce), pieceChecks: p.pieceChecks.map(bytesToHex),
    body: { store: p.body.store, id: p.body.id, length: p.body.length, sha256: bytesToHex(p.body.sha256) },
    fingerprint: bytesToHex(p.fingerprint),
  });
}

export function pointerFromText(text: string): SealedFilePointer {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error('this is not a sealed file');
  }
  if (raw?.codicil !== 'sealed-file') throw new Error('this is not a sealed file');
  if (raw.version !== 1) throw new Error('this sealed file was made by a newer version');
  const hex = (v: unknown, size?: number): Uint8Array => {
    if (typeof v !== 'string' || !/^([0-9a-f]{2})+$/.test(v)) throw new Error('this sealed file is damaged');
    const b = hexToBytes(v);
    if (size !== undefined && b.length !== size) throw new Error('this sealed file is damaged');
    return b;
  };
  const body = raw.body as Record<string, unknown> | undefined;
  const checks = raw.pieceChecks;
  if (typeof raw.vault !== 'string' || !/^[0-9a-f]{64}$/.test(raw.vault) || !Array.isArray(checks) || checks.length < 1
    || typeof raw.needed !== 'number' || !Number.isInteger(raw.needed) || raw.needed < 1 || raw.needed > checks.length
    || !body || typeof body.store !== 'string' || typeof body.id !== 'string' || typeof body.length !== 'number') {
    throw new Error('this sealed file is incomplete');
  }
  return {
    version: 1, kind: 'file', vault: raw.vault, needed: raw.needed,
    recipientHalf: hex(raw.recipientHalf, 32), nonce: hex(raw.nonce, 12), pieceChecks: checks.map((c) => hex(c, 32)),
    body: { store: body.store, id: body.id, length: body.length, sha256: hex(body.sha256, 32) },
    fingerprint: hex(raw.fingerprint, 32),
  };
}
