// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors
//
// The landing page: an ordinary scrolling website over a fixed field of points.
// As each section reaches the middle of the screen the field morphs: a sphere
// (what you leave), a cube (sealed), a ring (the clock), three clusters (the
// people you name) and a flat ledger split into what is public and what is not.

import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { Brand, ThemeToggle } from '../components/ui.js';
import { useTheme, type Theme } from '../theme.js';
import '../landing.css';

// ─── Point field ────────────────────────────────────────────────────────────
const VS = `
attribute vec3 aA; attribute vec3 aB; attribute vec3 aC; attribute vec3 aD; attribute vec3 aE; attribute vec3 aR; attribute vec3 aK;
uniform float uT; uniform float uTime; uniform float uAspect; uniform float uPx; uniform float uAlpha; uniform float uIntro;
uniform vec2 uMouse; uniform vec3 uView; uniform vec3 uInk; uniform vec3 uSig; uniform vec3 uPriv; uniform vec3 uPub;
varying vec3 vCol; varying float vA;
mat2 rot(float a){ float c = cos(a); float s = sin(a); return mat2(c, -s, s, c); }
void main(){
  float t = uT + (aR.x - 0.5) * 0.35;
  float b = smoothstep(0.15, 0.95, t); float c = smoothstep(2.25, 2.95, t); float d = smoothstep(3.25, 3.95, t);
  float e = smoothstep(4.35, 4.95, t); float f = smoothstep(7.3, 7.95, t);
  vec3 p = aA; p = mix(p, aB, b); p = mix(p, aC, c); p = mix(p, aD, d); p = mix(p, aE, e); p = mix(p, aA, f);
  float turb = 4.0 * (b * (1.0 - b) + c * (1.0 - c) + d * (1.0 - d) + e * (1.0 - e) + f * (1.0 - f));
  p += normalize(aR - 0.5 + 0.0001) * (turb * 0.38 + (1.0 - uIntro) * 3.2);
  p += 0.022 * vec3(sin(uTime * 0.7 + aR.x * 40.0), sin(uTime * 0.6 + aR.y * 40.0), sin(uTime * 0.8 + aR.z * 40.0));
  float hb = fract(uTime * 0.9);
  float beat = exp(-hb * 14.0) + 0.6 * exp(-abs(hb - 0.22) * 14.0);
  float pulseOn = smoothstep(1.4, 1.8, uT) * (1.0 - smoothstep(2.3, 2.7, uT));
  p *= 1.0 + 0.045 * beat * pulseOn;
  float flt = e * (1.0 - f);
  p.xz = rot((uTime * 0.09 + uT * 0.8) * (1.0 - flt) + uMouse.x * 0.35) * p.xz;
  p.yz = rot(mix(0.2, -0.55, flt) + uMouse.y * 0.22) * p.yz;
  float persp = 3.4 / (5.2 - p.z);
  vec2 sp = p.xy * persp * uView.z; sp.x /= uAspect;
  gl_Position = vec4(sp + uView.xy, 0.0, 1.0);
  float big = step(0.972, aR.y) * (1.0 - flt);
  gl_PointSize = uPx * (0.55 + aR.z * 0.9 + aK.x * 0.45) * persp * (1.0 + 0.5 * beat * pulseOn) * mix(1.0, 5.0, big);
  vec3 col = uInk;
  col = mix(col, uSig, step(0.94, aR.y) * (1.0 - flt));
  col = mix(col, uPriv, aK.y * d * (1.0 - e));
  col = mix(col, aE.x < 0.0 ? uPub : uPriv, flt);
  vCol = col;
  vA = (0.3 + 0.7 * aR.z) * clamp(persp * 1.1 - 0.2, 0.15, 1.0) * uAlpha * uIntro * (0.85 + 0.35 * beat * pulseOn) * mix(1.0, 0.16, big);
}`;
const FS = 'precision mediump float; varying vec3 vCol; varying float vA; void main(){ float d = length(gl_PointCoord - 0.5); float a = smoothstep(0.5, 0.1, d) * vA; if (a < 0.01) discard; gl_FragColor = vec4(vCol * a, a); }';

const UNIFORMS = ['uT', 'uTime', 'uAspect', 'uPx', 'uAlpha', 'uIntro', 'uMouse', 'uView', 'uInk', 'uSig', 'uPriv', 'uPub'] as const;

/** The five shapes every point travels through, plus per-point noise and flags. */
function shapes(N: number) {
  const R = Math.random;
  const mk = () => new Float32Array(N * 3);
  const A = mk(), B = mk(), C = mk(), D = mk(), E = mk(), RR = mk(), K = mk();
  const set = (arr: Float32Array, i: number, x: number, y: number, z: number) => { arr[i * 3] = x; arr[i * 3 + 1] = y; arr[i * 3 + 2] = z; };
  const g = () => (R() + R() + R() - 1.5) / 1.5;
  const tri = [[0, 1.2], [-1.04, -0.6], [1.04, -0.6]];
  const rows = 13, cols = Math.ceil(N / rows);
  for (let i = 0; i < N; i++) {
    // A · sphere (fibonacci)
    const y = 1 - (2 * (i + 0.5)) / N, r = Math.sqrt(1 - y * y), ph = i * 2.399963, rad = 1.3 + g() * 0.03;
    set(A, i, rad * r * Math.cos(ph), rad * y, rad * r * Math.sin(ph));
    // B · cube: faces and emphasised edges
    const hh = 0.95; let edge = 0;
    if (R() < 0.42) {
      edge = 1;
      const ax = Math.floor(R() * 3), s1 = R() < 0.5 ? -hh : hh, s2 = R() < 0.5 ? -hh : hh, u = (R() * 2 - 1) * hh;
      const v = ax === 0 ? [u, s1, s2] : ax === 1 ? [s1, u, s2] : [s1, s2, u];
      set(B, i, v[0], v[1], v[2]);
    } else {
      const f = Math.floor(R() * 6), a = (R() * 2 - 1) * hh, b = (R() * 2 - 1) * hh, s = f % 2 ? hh : -hh, ax = f >> 1;
      const v = ax === 0 ? [s, a, b] : ax === 1 ? [a, s, b] : [a, b, s];
      set(B, i, v[0], v[1], v[2]);
    }
    // C · ring (the clock), tilted
    const ta = R() * Math.PI * 2, tb = R() * Math.PI * 2, tr = 0.2 * Math.sqrt(R()), R0 = 1.5;
    const cx = (R0 + tr * Math.cos(tb)) * Math.cos(ta), cy = tr * Math.sin(tb), cz = (R0 + tr * Math.cos(tb)) * Math.sin(ta);
    set(C, i, cx, cy * Math.cos(1.15) - cz * Math.sin(1.15), cy * Math.sin(1.15) + cz * Math.cos(1.15));
    // D · three heirs, with branches to the root
    let cl = 0;
    const p = tri[i % 3];
    if (R() < 0.74) { cl = 1; set(D, i, p[0] + g() * 0.32, p[1] + g() * 0.32, g() * 0.32); }
    else { const s = R(); set(D, i, p[0] * s + g() * 0.02, p[1] * s + g() * 0.02, g() * 0.02); }
    // E · ledger plane (rows of points)
    const row = i % rows, col = Math.floor(i / rows);
    set(E, i, -2.3 + (col / cols) * 4.6, -1.2 + (row / (rows - 1)) * 2.4 + g() * 0.004, 0);
    set(RR, i, R(), R(), R());
    set(K, i, edge, cl, 0);
  }
  return { aA: A, aB: B, aC: C, aD: D, aE: E, aR: RR, aK: K };
}

interface Field {
  draw: (p: { t: number; time: number; intro: number; light: boolean; narrow: boolean; dpr: number; mouse: [number, number]; view: number[]; dim: number }) => void;
  dispose: () => void;
}

function createField(canvas: HTMLCanvasElement, narrow: boolean): Field | null {
  const gl = canvas.getContext('webgl', { alpha: true, premultipliedAlpha: true, antialias: true });
  if (!gl) return null;
  const N = narrow ? 14_000 : 26_000;
  const sh = (type: number, src: string) => {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) { console.warn('[codicil] shader', gl.getShaderInfoLog(s)); return null; }
    return s;
  };
  const v = sh(gl.VERTEX_SHADER, VS), f = sh(gl.FRAGMENT_SHADER, FS);
  if (!v || !f) return null;
  const prog = gl.createProgram()!;
  gl.attachShader(prog, v);
  gl.attachShader(prog, f);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) { console.warn('[codicil] link', gl.getProgramInfoLog(prog)); return null; }
  gl.useProgram(prog);
  const buffers: WebGLBuffer[] = [];
  Object.entries(shapes(N)).forEach(([name, data]) => {
    const buf = gl.createBuffer()!;
    buffers.push(buf);
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, name);
    if (loc < 0) return;
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 3, gl.FLOAT, false, 0, 0);
  });
  const U = Object.fromEntries(UNIFORMS.map((n) => [n, gl.getUniformLocation(prog, n)])) as Record<(typeof UNIFORMS)[number], WebGLUniformLocation | null>;
  gl.enable(gl.BLEND);
  gl.disable(gl.DEPTH_TEST);

  return {
    draw({ t, time, intro, light, narrow: nw, dpr, mouse, view, dim }) {
      const W = canvas.width, H = canvas.height;
      if (!W || !H || gl.isContextLost()) return;
      gl.viewport(0, 0, W, H);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      // Additive light on dark; ordinary ink on paper.
      if (light) gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA); else gl.blendFunc(gl.ONE, gl.ONE);
      gl.useProgram(prog);
      gl.uniform1f(U.uT, t);
      gl.uniform1f(U.uTime, time);
      gl.uniform1f(U.uAspect, W / H);
      gl.uniform1f(U.uIntro, intro);
      gl.uniform1f(U.uPx, (nw ? 2.2 : 2.6) * dpr);
      gl.uniform1f(U.uAlpha, dim * (light ? 0.75 : 0.62) * (1 - 0.6 * ss(4.5, 5.0, t) * (1 - ss(7.2, 7.8, t))));
      gl.uniform2f(U.uMouse, mouse[0], mouse[1]);
      gl.uniform3f(U.uView, view[0], view[1], view[2]);
      if (light) {
        gl.uniform3f(U.uInk, 0.055, 0.05, 0.045); gl.uniform3f(U.uSig, 0.49, 0.36, 0.11);
        gl.uniform3f(U.uPriv, 0.49, 0.36, 0.11); gl.uniform3f(U.uPub, 0.17, 0.35, 0.58);
      } else {
        gl.uniform3f(U.uInk, 0.95, 0.94, 0.92); gl.uniform3f(U.uSig, 0.9, 0.82, 0.66);
        gl.uniform3f(U.uPriv, 0.9, 0.82, 0.66); gl.uniform3f(U.uPub, 0.64, 0.74, 0.87);
      }
      gl.drawArrays(gl.POINTS, 0, N);
    },
    dispose() {
      buffers.forEach((b) => gl.deleteBuffer(b));
      gl.deleteProgram(prog);
      gl.deleteShader(v);
      gl.deleteShader(f);
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    },
  };
}

// ─── Story maths ────────────────────────────────────────────────────────────
function ss(a: number, b: number, x: number) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
const clamp = (x: number) => Math.min(1, Math.max(0, x));


/** Camera keyframes: [t, x offset, y offset, scale]. The field sits to the right of the text, and spreads out behind the ledger. */
function view(t: number, narrow: boolean): number[] {
  const K = narrow
    ? [[0, 0, -0.86, 0.27], [0.8, 0, 0, 0.62], [4.2, 0, 0, 0.62], [5, 0, 0, 0.7], [7.2, 0, 0, 0.7], [8, 0, 0, 0.6]]
    : [[0, 0.42, 0.02, 0.72], [0.6, 0.44, 0, 0.64], [4.2, 0.44, 0, 0.64], [5, 0, -0.02, 0.98], [7.2, 0, -0.02, 0.98], [8, 0.54, 0, 0.52]];
  let i = 0;
  while (i < K.length - 2 && t > K[i + 1][0]) i++;
  const a = K[i], b = K[i + 1], k = ss(a[0], b[0], t);
  return [a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k, a[3] + (b[3] - a[3]) * k];
}

/**
 * Where the story is: each section carries the shape it shows (`data-t`),
 * and t is interpolated by which section is crossing the middle of the screen.
 */
function storyTime(anchors: HTMLElement[]): number {
  const mid = window.innerHeight / 2;
  const pts = anchors.map((el) => {
    const r = el.getBoundingClientRect();
    return [r.top + r.height / 2, Number(el.dataset.t)] as const;
  });
  if (!pts.length) return 0;
  if (mid <= pts[0][0]) return pts[0][1];
  for (let i = 0; i < pts.length - 1; i++) {
    const [y0, t0] = pts[i], [y1, t1] = pts[i + 1];
    if (mid <= y1) return t0 + (t1 - t0) * clamp((mid - y0) / Math.max(1, y1 - y0));
  }
  return pts[pts.length - 1][1];
}

// ─── Content ────────────────────────────────────────────────────────────────
// Written for the person deciding whether to use it, not for someone studying
// how it is built. The technical account lives in the docs the footer links to.

/** Where "Create your will" goes. */
const APP = '#/app';
const DEMO = '#/demo';
const REPO = 'https://github.com/Evangel90/Codicil';

/** What people do today, and how each goes wrong. */
const TODAY: [string, string][] = [
  ['Keep it to yourself', 'If only you hold the keys, the letter or the files, they are gone the day you are. Nobody can recover them for the people who needed them.'],
  ['Hand it over early', 'A seed phrase in a drawer, or documents left with a friend, can be used or leaked long before you meant them to be.'],
  ['Use a public contract', 'Switches like this exist on other blockchains. They work, and they publish everything: who is named, what each person gets, and how recently you were active.'],
];

/** The four things a vault can release, each as the person who would use it. */
const USES: { who: string; kind: string; body: string; where: string }[] = [
  {
    who: 'A parent with savings',
    kind: 'A will',
    body: 'Amara keeps her savings in crypto. She names three heirs and the share each one gets. If she stops checking in, each of them claims their part with a letter she gave them. No heir sees what another one gets.',
    where: 'In the live app on Midnight’s test networks, and in the guided demo.',
  },
  {
    who: 'Someone with a letter to leave',
    kind: 'A sealed message',
    body: 'Some things are words: a letter to a daughter, or the recovery phrase of a wallet that is not in the vault. The message is locked on your device. The person it is for keeps the locked text and half of the key. Your guardians keep the other half, cut into pieces, and hand them over only after the vault releases.',
    where: 'In the guided demo.',
  },
  {
    who: 'A reporter who might be stopped',
    kind: 'A public disclosure',
    body: 'She seals her documents for everyone. A fingerprint of the sealed text goes on the chain that day, which later proves it existed before she went silent. A contract refuses every piece of the key until her vault has released. Once enough pieces are published, anyone can open the text.',
    where: 'In the guided demo.',
  },
  {
    who: 'An organisation with a canary',
    kind: 'A signal',
    body: 'Some organisations promise to say so if they are ever served a secret order, and go quiet when they no longer can. A vault makes that silence visible. Its public status reads still checking in, gone silent or released, and other Midnight contracts can act on it.',
    where: 'Every vault has a public status. The guided demo shows it, and a contract that acts on it.',
  },
];

const STEPS: { t: number; title: string; body: string; rows: [string, string, 'pub' | 'priv' | 'txt'][] }[] = [
  {
    t: 1,
    title: 'Put what matters in a vault',
    body: 'A vault can hold a will, a sealed message, a disclosure, or all three. You choose who receives each one. Everything is written and locked on your own device. The network is given fingerprints, never the contents.',
    rows: [['Takes', 'about ten minutes', 'txt'], ['You need', 'Face ID or Touch ID, and a Midnight wallet', 'txt'], ['Change your mind', 'any time before it releases', 'txt']],
  },
  {
    t: 2,
    title: 'Check in now and then',
    body: 'Pick a rhythm you will keep, say once a month. One touch of Face ID tells your vault you are still here and moves your deadline forward. Codicil can put reminders in your calendar, and they say only “Check in”.',
    rows: [['Each check-in', 'one touch', 'txt'], ['How often', 'you decide', 'txt'], ['If you are a few days late', 'an optional grace period covers it', 'txt']],
  },
  {
    t: 3,
    title: 'If you stop, nothing happens fast',
    body: 'A missed deadline starts a waiting period, two weeks unless you choose otherwise. One check-in during it cancels everything, so a month without signal or a false alarm costs you nothing. Guardians, a few people you trust, can start the same waiting period sooner if they know something has happened to you.',
    rows: [['A missed deadline starts', 'a waiting period, not a release', 'txt'], ['To cancel it', 'one check-in', 'txt'], ['Guardians can', 'start the wait early', 'txt']],
  },
  {
    t: 4,
    title: 'Then the vault releases',
    body: 'Your heirs claim their shares with the letters you gave them. Your guardians hand over their pieces, and a sealed message opens for the one person it was written for, or a disclosure opens for everyone. No lawyer or company has to approve anything.',
    rows: [['An heir needs', 'their letter and their key', 'txt'], ['A message opens with', 'pieces from enough guardians', 'txt'], ['If an heir cannot claim', 'their backup can, after a wait', 'txt']],
  },
];

const LEDGER: [string, string, string][] = [
  ['Heirs', 'root 0x7c3a…e91f', 'Ada 50%, Ben 30%, Cleo 20%'],
  ['Owner', 'commitment 0xa04d…22b8', 'Amara, Face ID on her phone'],
  ['Activity', 'counter 7', 'Checked in 12 February at 09:14'],
  ['Guardians', 'root 0x51e0…9a3c, 2 must agree', 'Dr. Mensah, Sarah Lin, Tomás'],
  ['Claims', '1 one-time stamp', 'Ben claimed on 2 April'],
  ['Balance', '25,000 tokens', 'Ada 12,500, Ben 7,500, Cleo 5,000'],
  ['Letter by hand', 'nothing', 'For Ada, 412 characters'],
  ['Disclosure', 'fingerprint 0x9be2…41d7, 2 of 3', 'What the documents say'],
];

const PEOPLE: [string, string, string][] = [
  ['You', 'Set up the vault and check in. You can change your heirs, their shares, your guardians or a sealed message at any time before a release, and nobody is told that you did.', 'You need your phone or laptop.'],
  ['The people you name', 'An heir keeps the letter you give them and can check it is still valid whenever they like. The person a sealed message is for keeps the locked text and their half of its key. Neither can do anything with it until the vault releases.', 'They need what you gave them, and their own key.'],
  ['Your guardians', 'A doctor, a lawyer, a sibling: people who would know if something had happened to you. If enough of them say so, the waiting period starts without waiting for your deadline. They cannot see the will, move money or stop you cancelling. If you seal a message, each of them also holds one piece of its key.', 'They need a secret you give them.'],
];

/** What another contract writes to build on a vault. Copied from contracts/src. */
const BUILD: { title: string; body: string; code: string; file: string; link: string }[] = [
  {
    title: 'Ask a vault whether it has released',
    body: 'One line lets any Midnight contract act on a release: a savings position that pays a beneficiary, a membership that passes on, an account that changes hands. The vault answers yes or no and reveals nothing else.',
    code: 'contract CodicilVault {\n  circuit isReleasedForContract(): Boolean;\n}\n\nassert(vault.isReleasedForContract(), "vault not released");',
    file: 'inheritable_escrow.compact',
    link: 'The savings example, 52 lines',
  },
  {
    title: 'Hand a key over only after a release',
    body: 'The seal register sits beside a vault. It records a fingerprint of each sealed text and a commitment to every piece of its key. It refuses a piece until the vault has released, checks that the piece is genuine, then publishes it. Use it for anything that should unlock on a release: files, credentials, a decryption key.',
    code: 'assert(vault.isReleasedForContract(), "vault not released");\nassert(pieceChecks.member(check), "not a genuine piece");',
    file: 'codicil_seals.compact',
    link: 'The seal register',
  },
];

/** Said plainly, on the page, not only in the docs. */
const LIMITS: [string, string][] = [
  ['Guardians keep a promise', 'The seal register controls the public route, not the people. Guardians could share their pieces somewhere else. The number of guardians you require, acting together, could open a disclosure early. For a private message they would also need the person it is for. A message you replace or take back can still be opened by anyone who kept the old copies.'],
  ['Silence is all it can see', 'A vault cannot tell why you stopped checking in. And someone who can force you to keep checking in can keep it shut.'],
  ['Messages are in the guided demo', 'The live app creates wills. Sealed messages and public disclosures work in the guided demo and are not in the live app yet.'],
  ['Test networks, not audited', 'Codicil runs on Midnight’s test networks, where tokens are free and worth nothing. Nobody has audited it. Treat it as a rehearsal.'],
];

const FAQ: [string, React.ReactNode][] = [
  ['What if I am reported dead while I am alive?', 'Nothing is released. A report, like a missed deadline, only starts the waiting period. One check-in cancels it and wipes the report. A vault releases only after the waiting period has ended without a word from you.'],
  ['What if I lose my phone?', 'Save the backup file when you create your vault. Your will and the keys that go with it live in your browser, and the backup is how you move them to another device. The passkey itself normally follows you through iCloud Keychain or Google Password Manager. The guided demo also has a recovery key on paper, which installs a new passkey after a public delay; the live app does not have it yet. With no device and no backup you can no longer check in, and the vault does what it would do if you had died: it releases to your heirs, provided they already have their letters.'],
  ['Can Codicil take my money or read my will?', <>No. Your will never leaves your device, and the funds sit in a contract that pays only by its rules: to an heir who proves their claim, after the waiting period. One thing to know while this is on a test network: the device that creates a vault keeps a maintenance key that could change the contract. Removing that key after set-up is planned. <a href={`${REPO}/blob/main/docs/THREAT_MODEL.md`}>What we protect against, and what we don’t yet</a>.</>],
  ['Is anything about my message on the chain?', 'That depends on how you send it. A message delivered by hand leaves nothing on the chain, not even that it exists. A message sent through the seal register, and every public disclosure, records a fingerprint of the sealed text and how many pieces its key needs. That shows a sealed text exists and when it was sealed. It never shows what it says or who a private message is for.'],
  ['Can my guardians read my message?', 'Not a private one. Its key has two halves and the person it is for holds one of them, so guardians alone cannot open it. A public disclosure has no single recipient, so the guardians’ pieces are the whole lock. Choose how many of them it takes with that in mind.'],
  ['What does it cost?', 'Network fees only. On Midnight they are paid in DUST, which your wallet generates by itself from the NIGHT it holds. Creating a vault takes eight small transactions; a check-in is one. Codicil takes nothing.'],
  ['What happens to my heirs if Codicil disappears?', <>Nothing changes for them. The vault is a contract on Midnight, not an account with us, and <a href={REPO}>the app is open source</a>. An heir needs their letter, their key and a copy of the app, which anyone can run.</>],
  ['Is this a legal will?', 'No. Codicil moves crypto you hold, by rules you set. Use it next to a legal will, not in place of one. Nothing here is legal advice.'],
  ['Can I use it for real money today?', 'Not yet. Codicil runs on Midnight’s test networks, where tokens are free and worth nothing. A will has been run there from start to finish, from creating the vault to an heir’s claim. It is not on mainnet and has not had a security audit, so treat it as a rehearsal.'],
];

// ─── Page ───────────────────────────────────────────────────────────────────
export function Landing() {
  const theme = useTheme();
  const themeRef = useRef<Theme>(theme);
  themeRef.current = theme;
  const hostRef = useRef<HTMLDivElement>(null);
  const [noGL, setNoGL] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const [lens, setLens] = useState(56);

  useEffect(() => {
    const host = hostRef.current!;
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    const canvas = document.createElement('canvas');   // made here so a remount gets a fresh GL context
    canvas.className = 'lx-canvas';
    canvas.setAttribute('aria-hidden', 'true');
    host.appendChild(canvas);
    let dpr = Math.min(window.devicePixelRatio || 1, 2);
    const measure = () => {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(canvas.clientWidth * dpr);
      canvas.height = Math.round(canvas.clientHeight * dpr);
    };
    measure();
    const field = createField(canvas, window.innerWidth < 820);
    if (!field) setNoGL(true);
    window.addEventListener('resize', measure);

    const anchors = Array.from(document.querySelectorAll<HTMLElement>('.lx [data-t]'));
    const mouse = { x: 0, y: 0, tx: 0, ty: 0 };
    const onMove = (e: globalThis.PointerEvent) => {
      mouse.tx = (e.clientX / window.innerWidth) * 2 - 1;
      mouse.ty = (e.clientY / window.innerHeight) * 2 - 1;
    };
    window.addEventListener('pointermove', onMove);
    const onScroll = () => setScrolled(window.scrollY > 8);
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();

    let raf = 0, cur = storyTime(anchors), i0: number | undefined;
    const tick = (now: number) => {
      const target = storyTime(anchors);
      cur = reduce ? target : cur + (target - cur) * 0.08;   // critically damped: no bounce
      mouse.x += (mouse.tx - mouse.x) * 0.05;
      mouse.y += (mouse.ty - mouse.y) * 0.05;
      if (field) {
        const time = now / 1000;
        i0 ??= time;
        const intro = reduce ? 1 : 1 - Math.pow(1 - Math.min(1, (time - i0) / 2.4), 4);
        const narrow = window.innerWidth < 820;
        field.draw({
          t: cur, time: reduce ? 3 : time, intro, light: themeRef.current === 'light', narrow, dpr,
          mouse: [mouse.x, mouse.y], view: view(cur, narrow),
          // On phones the field sits behind the text, so it steps back once you scroll.
          dim: narrow ? 1 - 0.7 * ss(0.15, 0.7, cur) : 1,
        });
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', measure);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('scroll', onScroll);
      field?.dispose();
      canvas.remove();
    };
  }, []);

  const jump = (id: string) => () => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' });
  const lensFrom = (e: PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    if (r.width) setLens(Math.min(100, Math.max(0, ((e.clientX - r.left) / r.width) * 100)));
  };
  const lensKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 20 : 5;
    if (e.key === 'ArrowLeft') { e.preventDefault(); setLens((x) => Math.max(0, x - step)); }
    if (e.key === 'ArrowRight') { e.preventDefault(); setLens((x) => Math.min(100, x + step)); }
    if (e.key === 'Home') setLens(0);
    if (e.key === 'End') setLens(100);
  };

  return (
    <div className="lx">
      <div ref={hostRef} className="lx-field" aria-hidden="true" />
      {noGL && <div className="lx-nogl" aria-hidden="true" />}

      <header className={`lx-header ${scrolled ? 'is-scrolled' : ''}`}>
        <div className="lx-wrap lx-header-row">
          <Brand />
          <nav aria-label="On this page" className="lx-nav">
            <button type="button" onClick={jump('uses')}>What it releases</button>
            <button type="button" onClick={jump('how')}>How it works</button>
            <button type="button" onClick={jump('privacy')}>What stays private</button>
            <button type="button" onClick={jump('questions')}>Questions</button>
          </nav>
          <span className="lx-header-end">
            <ThemeToggle />
            <a href={APP} className="btn btn-primary btn-sm">Create your will</a>
          </span>
        </div>
      </header>

      <main>
        <section className="lx-wrap lx-hero" data-t="0" aria-labelledby="lx-title">
          <div className="lx-hero-text">
            <h1 id="lx-title" className="lx-h1 fade-in">Decide what happens if you go silent.</h1>
            <p className="lx-lede fade-in" style={{ animationDelay: '150ms' }}>
              Codicil is a private switch on Midnight. You check in with Face ID now and then. If you ever stop, your
              vault releases what you chose: money to your heirs, a letter to one person, or documents to everyone.
              Until that day, nobody can tell what is inside, who it is for, or that it is yours.
            </p>
            <div className="lx-actions fade-in" style={{ animationDelay: '300ms' }}>
              <a href={DEMO} className="btn btn-primary btn-lg">Try the guided demo</a>
              <a href={APP} className="btn btn-secondary btn-lg">Create your will</a>
            </div>
            <p className="lx-note fade-in" style={{ animationDelay: '450ms' }}>
              The guided demo plays every kind of release in a few minutes. The live app creates wills on Midnight’s
              test networks, with free test tokens and nothing real at risk.
            </p>
          </div>
        </section>

        <section className="lx-wrap lx-why" aria-labelledby="why-h">
          <div className="lx-intro">
            <h2 id="why-h" className="lx-h2">Some things should happen only if you are gone</h2>
            <p>Savings your family could not reach without you. A letter. Documents that must come out if you cannot publish them yourself. There are three ways to plan for that today, and each one costs you something.</p>
          </div>
          <dl className="lx-people-list">
            {TODAY.map(([plan, cost]) => (
              <div key={plan}>
                <dt>{plan}</dt>
                <dd><p>{cost}</p></dd>
              </div>
            ))}
          </dl>
        </section>

        <section id="uses" className="lx-wrap lx-uses" data-t="1" aria-labelledby="uses-h">
          <div className="lx-intro">
            <h2 id="uses-h" className="lx-h2">One switch, four things it can release</h2>
            <p>The rule is always the same: you check in, and if you stop, the vault releases. What it releases is up to you.</p>
          </div>
          <dl className="lx-people-list lx-uses-list">
            {USES.map((u) => (
              <div key={u.kind}>
                <dt>{u.who}<span className="lx-kind">{u.kind}</span></dt>
                <dd><p>{u.body}</p><p className="lx-needs">{u.where}</p></dd>
              </div>
            ))}
          </dl>
        </section>

        <section id="how" className="lx-wrap lx-how" aria-labelledby="how-h">
          <div className="lx-intro">
            <h2 id="how-h" className="lx-h2">How Codicil works</h2>
            <p>You keep your keys and everything you write. The network holds the funds and enforces the rules, without being shown what they are for or who benefits.</p>
          </div>
          <ol className="lx-steps">
            {STEPS.map((s, i) => (
              <li key={s.title} className="lx-step" data-t={s.t}>
                <span className="lx-step-n" aria-hidden="true">{i + 1}</span>
                <h3>{s.title}</h3>
                <p>{s.body}</p>
                <dl className="lx-rows">
                  {s.rows.map(([k, v, tone]) => (
                    <div key={k}><dt>{k}</dt><dd className={`lx-${tone}`}>{v}</dd></div>
                  ))}
                </dl>
              </li>
            ))}
          </ol>
        </section>

        <section id="privacy" className="lx-wrap lx-lens" data-t="5.6" aria-labelledby="privacy-h">
          <div className="lx-intro lx-intro-wide">
            <h2 id="privacy-h" className="lx-h2">What a stranger can see</h2>
            <p>
              A blockchain is public, so what matters is what gets written to it. Drag across this example. On the left
              is everything the network records about a vault. On the right is what exists only on its owner’s phone.
            </p>
          </div>
          <div
            className="glass lx-table"
            onPointerMove={lensFrom}
            onPointerDown={lensFrom}
          >
            <div className="lx-tcol">
              <div className="lx-thead"><span className="lx-k">Field</span><span className="lx-pub">What anyone can read</span></div>
              {LEDGER.map(([k, pub]) => (
                <div key={k} className="lx-trow"><span className="lx-k">{k}</span><span className="mono lx-pub">{pub}</span></div>
              ))}
            </div>
            <div className="lx-tcol lx-private" aria-hidden={lens > 98} style={{ clipPath: `inset(0 0 0 ${lens.toFixed(2)}%)` }}>
              <div className="lx-thead"><span className="lx-k">Field</span><span className="lx-priv lx-right">Only on the owner’s phone</span></div>
              {LEDGER.map(([k, , priv]) => (
                <div key={k} className="lx-trow"><span className="lx-k">{k}</span><span className="lx-priv lx-right">{priv}</span></div>
              ))}
            </div>
            <div className="lx-handle-line" style={{ left: `${lens.toFixed(2)}%` }}>
              <div
                className="lx-handle"
                role="slider"
                tabIndex={0}
                aria-label="Compare what the chain sees with what stays on the phone"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(lens)}
                aria-valuetext={`${Math.round(100 - lens)}% of the table shows the private side`}
                onKeyDown={lensKey}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m9 7-5 5 5 5M15 7l5 5-5 5" /></svg>
              </div>
            </div>
          </div>
          <p className="lx-note">
            Not hidden: how much a vault holds, the size of each share at the moment it is claimed, and the fact that
            a disclosure exists. Codicil uses zero-knowledge proofs, which let the network check a rule was followed
            without being shown the details.{' '}
            <a href={`${REPO}/blob/main/docs/PRIVACY.md`}>Every field, explained</a>.
          </p>
        </section>

        <section className="lx-wrap lx-people" data-t="8" aria-labelledby="people-h">
          <div className="lx-intro">
            <h2 id="people-h" className="lx-h2">Who is involved</h2>
          </div>
          <dl className="lx-people-list">
            {PEOPLE.map(([who, what, needs]) => (
              <div key={who}>
                <dt>{who}</dt>
                <dd><p>{what}</p><p className="lx-needs">{needs}</p></dd>
              </div>
            ))}
          </dl>
        </section>

        <section className="lx-wrap lx-build" aria-labelledby="build-h">
          <div className="lx-intro">
            <h2 id="build-h" className="lx-h2">Build on it</h2>
            <p>A vault’s release is something other Midnight contracts can use. There are two ways in, and both are a few lines.</p>
          </div>
          <div className="lx-build-list">
            {BUILD.map((b) => (
              <article key={b.file}>
                <h3>{b.title}</h3>
                <p>{b.body}</p>
                <pre className="lx-code" tabIndex={0} aria-label={`From ${b.file}`}><code>{b.code}</code></pre>
                <p className="lx-needs"><a href={`${REPO}/blob/main/contracts/src/${b.file}`}>{b.link}</a></p>
              </article>
            ))}
          </div>
        </section>

        <section className="lx-wrap lx-limits" aria-labelledby="limits-h">
          <div className="lx-intro">
            <h2 id="limits-h" className="lx-h2">What it does not do</h2>
          </div>
          <dl className="lx-people-list lx-limits-list">
            {LIMITS.map(([limit, detail]) => (
              <div key={limit}>
                <dt>{limit}</dt>
                <dd><p>{detail}</p></dd>
              </div>
            ))}
          </dl>
        </section>

        <section id="questions" className="lx-wrap lx-faq" aria-labelledby="faq-h">
          <div className="lx-intro">
            <h2 id="faq-h" className="lx-h2">Questions</h2>
          </div>
          <div className="lx-faq-list">
            {FAQ.map(([q, a]) => (
              <details key={q}>
                <summary>{q}</summary>
                <p>{a}</p>
              </details>
            ))}
          </div>
        </section>

        <section className="lx-wrap lx-cta" aria-labelledby="cta-h">
          <h2 id="cta-h" className="lx-h2">Set it up once. After that, it is one touch.</h2>
          <p>Watch it work first: the guided demo plays a will, a sealed letter and a public disclosure from start to release. When you are ready, create your will on a test network in about ten minutes.</p>
          <div className="lx-actions">
            <a href={DEMO} className="btn btn-primary btn-lg">Try the guided demo</a>
            <a href={APP} className="btn btn-secondary btn-lg">Create your will</a>
          </div>
        </section>
      </main>

      <footer className="lx-footer">
        <div className="lx-wrap lx-footer-row">
          <Brand />
          <nav aria-label="Project" className="lx-footer-links">
            <a href={REPO}>Source code</a>
            <a href={`${REPO}#readme`}>Documentation</a>
            <a href={`${REPO}/blob/main/docs/PRIVACY.md`}>Privacy details</a>
            <a href={`${REPO}/blob/main/docs/THREAT_MODEL.md`}>Threat model</a>
            <a href="https://midnight.network">Built on Midnight</a>
          </nav>
          <p className="lx-fine">Open source. Test network, not audited. Not legal advice.</p>
        </div>
      </footer>
    </div>
  );
}
