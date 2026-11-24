// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors
//
// The heir's letter, on the heir's device: paste it, scan its QR code, or
// read it from a photo. It is checked here against the public will
// fingerprint; nothing is sent anywhere.

import { useEffect, useRef, useState } from 'react';
import { Phase } from '@codicil/contracts/vault';
import { Icon, ICONS } from '../components/ui.js';
import { demo, fmtDate, OWNER_FIRST, type HeirView, type Snapshot } from '../demo/store.js';

interface Detector { detect(src: CanvasImageSource | ImageBitmap): Promise<{ rawValue: string }[]> }
const detector = (): Detector | undefined => {
  const BD = (globalThis as { BarcodeDetector?: new (o: { formats: string[] }) => Detector }).BarcodeDetector;
  return BD ? new BD({ formats: ['qr_code'] }) : undefined;
};

function Camera({ onText, onClose }: { onText: (t: string) => void; onClose: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string>();
  useEffect(() => {
    let stream: MediaStream | undefined;
    let timer: ReturnType<typeof setInterval> | undefined;
    const d = detector();
    void (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
        if (!video.current) return;
        video.current.srcObject = stream;
        await video.current.play();
        timer = setInterval(async () => {
          const codes = await d!.detect(video.current!).catch(() => []);
          const hit = codes.find((c) => c.rawValue.startsWith('codicil:'));
          if (hit) onText(hit.rawValue);
        }, 300);
      } catch {
        setError('The camera is not available. Paste the letter text instead.');
      }
    })();
    return () => { if (timer) clearInterval(timer); stream?.getTracks().forEach((t) => t.stop()); };
  }, [onText]);
  return (
    <div className="scan">
      {error ? <p className="err-inline" role="alert">{error}</p> : <video ref={video} muted playsInline aria-label="Camera preview for the letter's QR code" />}
      <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>Stop scanning</button>
    </div>
  );
}

export function LetterBox({ s, me }: { s: Snapshot; me: HeirView }) {
  const id = me.profile.id;
  const [text, setText] = useState('');
  const [problem, setProblem] = useState<string>();
  const [scanning, setScanning] = useState(false);
  const canScan = !!detector();
  const held = me.letter;

  const load = (t?: string) => {
    const p = demo.holdLetter(id, t);
    setProblem(p);
    if (!p) { setText(''); setScanning(false); }
  };
  const fromPhoto = async (file?: File) => {
    if (!file) return;
    try {
      const codes = await detector()!.detect(await createImageBitmap(file));
      const hit = codes.find((c) => c.rawValue.startsWith('codicil:'));
      if (hit) load(hit.rawValue); else setProblem('No Codicil letter QR code was found in that picture.');
    } catch {
      setProblem('That picture could not be read.');
    }
  };

  if (held) {
    const good = held.vaultMatches && held.inCurrentWill && held.role !== 'none';
    const problemText = !held.vaultMatches ? 'This letter is for a different vault.'
      : held.role === 'none' ? 'This letter names a different key than the one on this device. It may be meant for someone else.'
      : !held.inCurrentWill ? `This letter is for an older version of the will. ${OWNER_FIRST} has changed it since, so ask for the new letter.` : undefined;
    return (
      <section className={`card letterbox ${good ? 'is-good' : 'is-bad'}`} aria-labelledby="lb-h">
        <div className="letterbox-head">
          <span className={good ? 'ok-ring' : 'bad-ring'}><Icon d={good ? ICONS.check : ICONS.close} size={18} stroke={1.8} /></span>
          <div className="stack-6">
            <h2 id="lb-h">{good ? 'Your letter checks out.' : 'This letter won’t work.'}</h2>
            <span className="small muted">Checked on this device against the will’s public fingerprint. Nothing was sent anywhere.</span>
          </div>
        </div>
        {problemText && <p className="err-inline" role="alert">{problemText}</p>}
        <dl className="facts">
          <div><dt>In the current will</dt><dd className={held.inCurrentWill ? 'tone-armed' : 'tone-danger'}>{held.inCurrentWill ? 'Yes' : 'No, an older version'}</dd></div>
          <div><dt>Your key opens it as</dt><dd className={held.role === 'none' ? 'tone-danger' : undefined}>{held.role === 'heir' ? 'The heir' : held.role === 'backup' ? 'The backup heir' : 'Neither'}</dd></div>
          <div><dt>Share</dt><dd className="tone-private">{Number(held.shareBps) / 100}%</dd></div>
          <div><dt>Unlocks</dt><dd>{held.role === 'backup' ? '30 days after release, if unclaimed' : held.unlockAt > 0 ? fmtDate(held.unlockAt) : 'When the will is released'}</dd></div>
          <div><dt>Letter</dt><dd className="mono">{held.fingerprint}</dd></div>
        </dl>
        <div className="btn-row">
          {!held.inCurrentWill && held.vaultMatches && (
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => load()}>Get the new letter from {OWNER_FIRST}</button>
          )}
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => demo.forgetLetter(id)}>Remove from this device</button>
        </div>
      </section>
    );
  }

  return (
    <section className="card letterbox" aria-labelledby="lb-h">
      <div className="stack-6">
        <h2 id="lb-h">Your letter from {OWNER_FIRST}</h2>
        <span className="small muted">
          It says which share is yours and proves it is in the will. Load it here to check it; it is read on this device
          only. {s.phase === Phase.armed ? 'You can check it now, years before it is needed.' : ''}
        </span>
      </div>
      <label className="field-label">
        <span className="sr-only">Letter text</span>
        <textarea className="field mono letter-input" rows={3} placeholder="codicil:claim:v1:…" spellCheck={false} value={text} onChange={(e) => setText(e.target.value)} />
      </label>
      {problem && <p className="err-inline" role="alert">{problem}</p>}
      {scanning && <Camera onText={(t) => load(t)} onClose={() => setScanning(false)} />}
      <div className="btn-row">
        <button type="button" className="btn btn-primary btn-sm" disabled={!text.trim()} onClick={() => load(text)}>Check the letter</button>
        {canScan && !scanning && <button type="button" className="btn btn-secondary btn-sm" onClick={() => setScanning(true)}>Scan the QR code</button>}
        {canScan && (
          <label className="btn btn-secondary btn-sm">
            From a photo
            <input type="file" accept="image/*" className="sr-only" onChange={(e) => void fromPhoto(e.target.files?.[0])} />
          </label>
        )}
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => load()}>Use the letter {OWNER_FIRST} gave me (demo)</button>
      </div>
    </section>
  );
}
