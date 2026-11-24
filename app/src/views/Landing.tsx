// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors
//
// The landing page: a scroll story over a field of points that morphs from a
// sphere (the will) to a cube (sealed), a ring (the clock), three clusters
// (the heirs) and a flat ledger, split into what is public and what is not.

import { useEffect, useRef, useState, type CSSProperties, type MouseEvent, type TouchEvent } from 'react';
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
  draw: (p: { t: number; time: number; intro: number; light: boolean; narrow: boolean; dpr: number; mouse: [number, number]; view: number[] }) => void;
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
    draw({ t, time, intro, light, narrow: nw, dpr, mouse, view }) {
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
      gl.uniform1f(U.uAlpha, (light ? 0.75 : 0.62) * (1 - 0.6 * ss(4.5, 5.0, t) * (1 - ss(7.2, 7.8, t))));
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

/** Camera keyframes: [t, x offset, y offset, scale]. */
function view(t: number, narrow: boolean): number[] {
  const K = narrow
    ? [[0, 0, 0.26, 0.6], [1, 0, 0.5, 0.4], [4.2, 0, 0.5, 0.4], [5, 0, 0, 0.62], [7.2, 0, 0, 0.62], [8, 0, 0.3, 0.5]]
    : [[0, 0.2, 0.14, 0.94], [1, 0.46, 0, 0.8], [4.2, 0.46, 0, 0.8], [5, 0, -0.05, 1.0], [7.2, 0, -0.05, 1.0], [8, 0.25, 0.25, 0.7]];
  let i = 0;
  while (i < K.length - 2 && t > K[i + 1][0]) i++;
  const a = K[i], b = K[i + 1], k = ss(a[0], b[0], t);
  return [a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k, a[3] + (b[3] - a[3]) * k];
}

const GLYPHS = '0123456789abcdef#%&*';
function scramble(text: string, p: number, seed: number) {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (' ·…→/:.'.includes(ch) || i < p * text.length) out += ch;
    else out += GLYPHS[(Math.abs(Math.sin((i + 1) * 12.9898 + seed * 78.233)) * 43758.5453 | 0) % GLYPHS.length];
  }
  return out;
}

/** A line of display type: plain strings, or [text] for an italic accent, [text, 'priv'] for the private colour. */
type Seg = string | [string] | [string, 'priv'];
function Segs({ parts }: { parts: Seg[] }) {
  return (
    <>
      {parts.map((p, i) => (typeof p === 'string'
        ? <span key={i}>{p}</span>
        : <span key={i} className={`lx-acc ${p[1] === 'priv' ? 'lx-priv' : ''}`}>{p[0]}</span>))}
    </>
  );
}

type Tone = 'pub' | 'priv' | 'pend' | 'ok' | 'txt';
const CHAPTERS: { label: string; lines: Seg[][]; body: string; rows: [string, string, Tone][] }[] = [
  {
    label: 'Seal', lines: [['Write it once.'], ['Seal it ', ['privately.', 'priv']]],
    body: 'Name heirs, shares and unlock dates on your phone. Midnight receives one 32-byte commitment. It never sees a name or an amount.',
    rows: [['Heirs root', '0x7c3a91f0…e91f', 'pub'], ['Number of heirs', 'not disclosed', 'txt'], ['Size on-chain', '32 bytes', 'txt']],
  },
  {
    label: 'Check in', lines: [['One touch.'], ['Still ', ['here.']]],
    body: 'Face ID signs each check-in on the device, and your deadline moves forward. Nothing on-chain links that touch to you.',
    rows: [['Next deadline in', '', 'txt'], ['Signed with', 'passkey · p-256', 'pub'], ['Linkable to you', 'no', 'txt']],
  },
  {
    label: 'The switch', lines: [['Silence starts'], ['a ', ['gentle'], ' clock.']],
    body: 'If you miss a deadline, the vault turns pending. A challenge window gives you time to cancel before anything moves.',
    rows: [['Vault state', 'ARMED → PENDING', 'pend'], ['Challenge window', '7d 00h 00m', 'txt'], ['To cancel', 'one touch', 'txt']],
  },
  {
    label: 'Claim', lines: [['Heirs prove'], ['they ', ['belong.']]],
    body: 'Each heir’s phone builds a zero-knowledge proof: they are in the will and their date has come. The chain verifies it and learns nothing else.',
    rows: [['Nullifier', '0x2b90c4d1…41ac', 'pub'], ['Proof', 'verified in 4.2s', 'ok'], ['Identity', 'undisclosed', 'priv']],
  },
];

const LEDGER: [string, string, string][] = [
  ['Heirs', 'root 0x7c3a…e91f', 'Ada 50% · Ben 30% · Cleo 20%'],
  ['Owner', 'commit 0xa04d…22b8', 'Amara, passkey on this phone'],
  ['Activity', 'counter 7', 'Checked in 12 Feb, 09:14'],
  ['Guardians', 'root 0x51e0…9a3c · k 2', 'Dr. Mensah, Sarah Lin, Tomás'],
  ['Claims', 'nullifiers 1', 'Ben claimed on 2 Apr'],
  ['Balance', '25,000 tokens', 'Ada 12,500 · Ben 7,500 · Cleo 5,000'],
];

const MARQUEE = ['zero-knowledge', 'self-custody', 'passkeys', 'private by default', 'built on Midnight', 'no seed phrase'];
const STOPS: [number, string][] = [[0, 'Intro'], [1, 'Seal'], [2, 'Check in'], [3, 'The switch'], [4, 'Claim'], [6.05, 'The lens'], [8, 'Begin']];
const STEPS = [0, 1, 2, 3, 4, 5.1, 7, 8];

const vz = (o: number): CSSProperties['visibility'] => (o < 0.01 ? 'hidden' : 'visible');
const pe = (o: number): CSSProperties['pointerEvents'] => (o > 0.5 ? 'auto' : 'none');
const px = (n: number) => `calc(${n}px * var(--o-display-scale))`;

// ─── Component ──────────────────────────────────────────────────────────────
export function Landing() {
  const theme = useTheme();
  const themeRef = useRef<Theme>(theme);
  themeRef.current = theme;

  const scRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const live = useRef({
    cur: 0, vel: 0, target: 0, mx: 0, my: 0, tmx: 0, tmy: 0,
    enter: {} as Record<number, number>, act: -1, t0: Date.now(), reduce: false, h: 900, w: 1440,
  });
  const [st, setSt] = useState({ s: 0, h: 900, w: 1440, f: 0, sec: 0 });
  const [noGL, setNoGL] = useState(false);
  const [lensX, setLensX] = useState<number | null>(null);

  useEffect(() => {
    const L = live.current;
    const sc = scRef.current!, host = hostRef.current!;
    L.reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

    // The canvas is made here, not in JSX, so a remount always gets a fresh GL context.
    const canvas = document.createElement('canvas');
    canvas.className = 'lx-canvas';
    canvas.setAttribute('aria-hidden', 'true');
    host.appendChild(canvas);
    let dpr = Math.min(window.devicePixelRatio || 1, 2);

    const measure = () => {
      L.h = sc.clientHeight || 900;
      L.w = sc.clientWidth || 1440;
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(canvas.clientWidth * dpr);
      canvas.height = Math.round(canvas.clientHeight * dpr);
      setSt((p) => (p.h === L.h && p.w === L.w ? p : { ...p, h: L.h, w: L.w }));
    };
    measure();
    const field = createField(canvas, L.w < 820);
    if (!field) setNoGL(true);
    const ro = new ResizeObserver(measure);
    ro.observe(sc);

    let raf = 0, frame = 0, i0: number | undefined, lastS = 0, lastSec = 0;
    const tick = (now: number) => {
      frame++;
      // Critically damped follow: no bounce.
      if (L.reduce) { L.cur = L.target; L.vel = 0; } else { const prev = L.cur; L.cur += (L.target - L.cur) * 0.09; L.vel = L.cur - prev; }
      L.mx += (L.tmx - L.mx) * 0.05;
      L.my += (L.tmy - L.my) * 0.05;
      const t = Math.min(8, Math.max(0, L.cur / L.h));
      let act = -1;
      for (let i = 1; i <= 4; i++) if (Math.abs(t - i) < 0.35) act = i;
      if (act !== L.act) { L.act = act; if (act > 0) L.enter[act] = now; }
      const scrambling = act > 0 && now - (L.enter[act] ?? 0) < 1100;
      const sec = Math.floor(Date.now() / 1000);
      if (Math.abs(L.cur - lastS) > 0.2 || (scrambling && frame % 2 === 0) || sec !== lastSec) {
        lastS = L.cur;
        lastSec = sec;
        setSt((p) => ({ ...p, s: L.cur, f: now, sec }));
      }
      if (field) {
        const time = now / 1000;
        i0 ??= time;
        let intro = L.reduce ? 1 : Math.min(1, (time - i0) / 2.4);
        intro = 1 - Math.pow(1 - intro, 4);
        const narrow = L.w < 820;
        field.draw({
          t, time: L.reduce ? 3 : time, intro, light: themeRef.current === 'light', narrow, dpr,
          mouse: [L.mx, L.my], view: view(t, narrow),
        });
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      field?.dispose();
      canvas.remove();
    };
  }, []);

  // ─── Derived view state ───────────────────────────────────────────────────
  const { h, w } = st;
  const narrow = w < 820;
  const light = theme === 'light';
  const reduce = live.current.reduce;
  const t = Math.min(8, Math.max(0, st.s / h));
  const side = narrow ? 20 : Math.max(48, Math.round((w - 1320) / 2));
  const seed = Math.floor(st.f / 50);
  const go = (tt: number) => () => scRef.current?.scrollTo({ top: tt * h, behavior: reduce ? 'auto' : 'smooth' });

  const heroOut = clamp(t / 0.8);
  const heroO = 1 - ss(0.35, 0.85, t);
  const heroSize = px(narrow ? 50 : Math.min(172, Math.round(w * 0.112)));
  const h2Size = px(narrow ? 40 : 68);

  const left = Math.max(0, 30 * 86400 - (Date.now() - live.current.t0) / 1000);
  const countdown = `${Math.floor(left / 86400)}d ${String(Math.floor((left % 86400) / 3600)).padStart(2, '0')}h ${String(Math.floor((left % 3600) / 60)).padStart(2, '0')}m ${String(Math.floor(left % 60)).padStart(2, '0')}s`;

  const barsO = ss(0.55, 0.85, t) * (1 - ss(4.25, 4.55, t));
  const ci = Math.min(3, Math.max(0, t - 1));
  const roll = Math.floor(ci) + ss(0.35, 0.65, ci - Math.floor(ci));

  const lensO = ss(4.45, 4.95, t) * (1 - ss(7.3, 7.65, t));
  const lp = clamp((t - 5.1) / 1.9);
  const lensL = lensX ?? 100 - ss(0, 1, lp) * 100;

  const ctaO = ss(7.4, 7.9, t);
  let active = 0;
  STOPS.forEach(([s], i) => { if (t >= s - 0.55) active = i; });
  const nextT = STEPS.find((x) => x > t + 0.08) ?? 8;
  const prevT = STEPS.filter((x) => x < t - 0.08).pop() ?? 0;
  const scrolled = clamp(t * 6);
  const v = view(t, narrow);
  const ctrlO = 1 - ss(7.45, 7.75, t);
  // The rail sits over the lens table, so it steps aside while the table is up.
  const railO = clamp(t * 3) * (1 - ss(7.5, 7.9, t)) * (1 - lensO);
  const skew = Math.max(-10, Math.min(10, live.current.vel * 0.12));

  const onMove = (e: MouseEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    live.current.tmx = ((e.clientX - r.left) / r.width) * 2 - 1;
    live.current.tmy = ((e.clientY - r.top) / r.height) * 2 - 1;
  };
  const onLens = (e: MouseEvent<HTMLDivElement> | TouchEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const x = 'touches' in e ? e.touches[0]?.clientX : e.clientX;
    if (typeof x !== 'number' || !r.width) return;
    setLensX(Math.min(100, Math.max(0, ((x - r.left) / r.width) * 100)));
  };

  const mask = (key: string | number, y: number, parts: Seg[], extra?: CSSProperties, className = '') => (
    <span key={key} className="lx-mask">
      <span className={`lx-line ${className}`} style={{ transform: `translateY(${y.toFixed(1)}%)`, ...extra }}><Segs parts={parts} /></span>
    </span>
  );

  return (
    <div className="lx" onMouseMove={onMove}>
      <div
        className="lx-glow"
        aria-hidden="true"
        style={{ left: `${(50 + v[0] * 50).toFixed(1)}%`, top: `${(50 - v[1] * 50).toFixed(1)}%`, width: Math.round(h * v[2] * 1.7), height: Math.round(h * v[2] * 1.7) }}
      />
      <div ref={hostRef} className="lx-canvas-host" aria-hidden="true" />
      {noGL && <div className="lx-nogl" aria-hidden="true" />}
      <div className="lx-vignette" aria-hidden="true" />
      <svg className="lx-grain" aria-hidden="true" style={{ opacity: light ? 0.05 : 0.08 }}>
        <filter id="lx-grain"><feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves={2} stitchTiles="stitch" /></filter>
        <rect width="100%" height="100%" filter="url(#lx-grain)" />
      </svg>

      <div
        ref={scRef}
        className="lx-scroller"
        tabIndex={0}
        aria-label="The Codicil story. Scroll, or use the arrow buttons, to continue."
        onScroll={(e) => { live.current.target = e.currentTarget.scrollTop; }}
      >
        <div className="lx-stage">
          {/* ── Hero ── */}
          <section
            aria-label="Introduction"
            className="lx-hero"
            style={{ padding: narrow ? '0 20px 104px' : `0 ${side}px 104px`, opacity: heroO, visibility: vz(1 - heroOut), pointerEvents: pe(1 - heroOut) }}
          >
            <span className="eyebrow fade-in lx-kicker" style={{ animationDelay: '500ms' }}>
              <span className="pulse lx-kicker-dot" />Private inheritance · Built on Midnight
            </span>
            <h1 className="disp lx-h1" style={{ fontSize: heroSize }}>
              {([['Your will,'], ['proven ', ['private.', 'priv']]] as Seg[][]).map((parts, j) => {
                const o = ss(0.04 + j * 0.1, 0.55 + j * 0.1, t);
                return (
                  <span key={j}>
                    {j > 0 && ' '}
                    {mask(j, -o * 115, parts, { animationDelay: `${150 + j * 130}ms`, filter: `blur(${(o * 6).toFixed(1)}px)` }, 'line-in')}
                  </span>
                );
              })}
            </h1>
            <div className="lx-hero-foot" style={{ transform: `translateY(${(-heroOut * 40).toFixed(1)}px)` }}>
              <p className="fade-in lx-lede" style={{ animationDelay: '800ms' }}>
                Decide who inherits what, and when. Check in with Face ID now and then. If you stop, your heirs can claim, and the blockchain never learns who they are.
              </p>
              <div className="fade-in lx-actions" style={{ animationDelay: '950ms' }}>
                <a href="#/demo" className="btn btn-primary btn-lg">Launch the demo <span className="arw" aria-hidden="true">→</span></a>
                <button type="button" className="btn btn-secondary btn-lg" onClick={go(1)}>How it works</button>
              </div>
            </div>
          </section>

          {/* ── Chapters ── */}
          {CHAPTERS.map((c, k) => {
            const i = k + 1, d = t - i;
            const ent = (j: number) => ss(-0.6 + j * 0.07, -0.18 + j * 0.07, d);
            const ex = ss(0.18, 0.55, d);
            const vis = ent(0) * (1 - ex);
            const sp = clamp((performance.now() - (live.current.enter[i] ?? 0)) / 900);
            const b = ent(2) * (1 - ex);
            return (
              <section
                key={c.label}
                aria-label={c.label}
                className="lx-chapter"
                style={{ justifyContent: narrow ? 'flex-end' : 'center', padding: narrow ? '0 20px 104px' : `0 ${side}px`, visibility: vz(vis), pointerEvents: pe(vis) }}
              >
                <div className="lx-col" style={{ width: narrow ? '100%' : 580 }}>
                  <div className="lx-idx" style={{ opacity: b }}>
                    <span className="eyebrow lx-strong">0{i}</span>
                    <span className="lx-rule" style={{ width: Math.round(ent(1) * (1 - ex) * 56) }} />
                    <span className="eyebrow">{c.label}</span>
                  </div>
                  <h2 className="disp lx-h2" style={{ fontSize: h2Size }}>
                    {c.lines.map((parts, j) => (
                      <span key={j}>{j > 0 && ' '}{mask(j, (1 - ent(j)) * 115 - ex * 115, parts)}</span>
                    ))}
                  </h2>
                  <p
                    className="lx-body"
                    style={{ opacity: b, transform: `translateY(${((1 - ent(2)) * 24 - ex * 24).toFixed(1)}px)`, filter: `blur(${((1 - b) * 6).toFixed(1)}px)` }}
                  >
                    {c.body}
                  </p>
                  <dl className="lx-rows" style={{ opacity: b, transform: `translateY(${((1 - ent(3)) * 32 - ex * 20).toFixed(1)}px)` }}>
                    {c.rows.map(([key, value, tone], r) => {
                      const text = i === 2 && r === 0 ? countdown : value;
                      return (
                        <div key={key}>
                          <dt>{key}</dt>
                          <dd className={`mono tone-${tone}`}>
                            {r === 0 && i === 2 && sp >= 1 ? text : scramble(text, clamp(sp * 1.4 - r * 0.15), seed + r)}
                          </dd>
                        </div>
                      );
                    })}
                  </dl>
                </div>
              </section>
            );
          })}

          {/* Chapter progress: index roller and story bars */}
          <div className="lx-bars" aria-hidden="true" style={{ left: side, width: narrow ? 'calc(100% - 160px)' : 450, opacity: barsO }}>
            <span className="mono lx-roller">
              0
              <span className="lx-roll-win"><span className="lx-roll" style={{ transform: `translateY(${(-roll * 1.3).toFixed(3)}em)` }}><span>1</span><span>2</span><span>3</span><span>4</span></span></span>
              <span className="lx-dim">&#160;/ 04</span>
            </span>
            <div className="lx-bar-list">
              {[1, 2, 3, 4].map((i) => (
                <span key={i} className="lx-bar"><span style={{ width: `${Math.round(clamp(t - i + 0.5) * 100)}%` }} /></span>
              ))}
            </div>
          </div>

          {/* ── The lens ── */}
          <section
            aria-label="The lens"
            className="lx-lens"
            style={{ padding: narrow ? '76px 20px 88px' : `80px ${side}px`, opacity: lensO, visibility: vz(lensO), pointerEvents: pe(lensO) }}
          >
            <div className="lx-lens-head" style={{ transform: `translateY(${((1 - lensO) * 30).toFixed(1)}px)` }}>
              <div className="lx-lens-title">
                <span className="eyebrow"><span className="lx-strong">05</span>&#160;&#160;·&#160;&#160;The lens</span>
                <h2 className="disp lx-h2" style={{ fontSize: h2Size }}>Two ledgers. <span className="it">One</span> will.</h2>
              </div>
              <p className="lx-lens-note">
                Scroll, or move your pointer across the table, to slide the lens. Left of the line is everything Midnight can see. Right of it is what exists only on your phone.
              </p>
            </div>
            <div className="glass lx-table" onMouseMove={onLens} onMouseLeave={() => setLensX(null)} onTouchMove={onLens}>
              <div className="lx-tcol">
                <div className="lx-thead"><span className="eyebrow lx-k">Field</span><span className="eyebrow tone-pub">What Midnight sees</span></div>
                {LEDGER.map(([k, pub]) => (
                  <div key={k} className="lx-trow"><span className="lx-k">{k}</span><span className="mono lx-pub">{pub}</span></div>
                ))}
              </div>
              <div className="lx-tcol lx-private" aria-hidden={lensL > 98} style={{ clipPath: `inset(0 0 0 ${lensL.toFixed(2)}%)` }}>
                <div className="lx-thead"><span className="eyebrow lx-k">Field</span><span className="eyebrow tone-priv lx-ellipsis">What you see · this device only</span></div>
                {LEDGER.map(([k, , priv]) => (
                  <div key={k} className="lx-trow"><span className="lx-k">{k}</span><span className="lx-priv-v">{priv}</span></div>
                ))}
              </div>
              <div className="lx-handle-line" aria-hidden="true" style={{ left: `${lensL.toFixed(2)}%` }}>
                <span className="lx-handle">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m9 7-5 5 5 5M15 7l5 5-5 5" /></svg>
                </span>
              </div>
            </div>
          </section>

          {/* ── Begin ── */}
          <section aria-label="Begin" className="lx-cta" style={{ opacity: ctaO, visibility: vz(ctaO), pointerEvents: pe(ctaO) }}>
            <div className="lx-cta-body" style={{ padding: narrow ? '0 20px 32px' : `0 ${side}px 44px` }}>
              <h2 className="disp lx-h1" style={{ fontSize: heroSize }}>
                {([['Leave nothing'], [['exposed.']]] as Seg[][]).map((parts, j) => (
                  <span key={j}>{j > 0 && ' '}{mask(j, (1 - ss(7.45 + j * 0.08, 7.9 + j * 0.08, t)) * 115, parts)}</span>
                ))}
              </h2>
              <div className="lx-actions" style={{ opacity: ss(7.7, 8, t) }}>
                <a href="#/demo" className="btn btn-primary btn-lg">Launch the demo <span className="arw" aria-hidden="true">→</span></a>
                <a href="#/demo" className="btn btn-secondary btn-lg">Create a vault</a>
              </div>
            </div>
            <div className="lx-marquee-band" aria-hidden="true" style={{ transform: `skewX(${skew.toFixed(2)}deg)` }}>
              <div className="marquee disp lx-marquee">
                {MARQUEE.concat(MARQUEE).map((m, i) => (
                  <span key={i} className={i % 2 ? 'lx-acc lx-dim' : undefined}>{m}<span className="lx-mdot" /></span>
                ))}
              </div>
            </div>
            <footer className="lx-footer" style={{ padding: `20px ${side}px 28px` }}>
              <span>Codicil © 2026</span><span>Built on Midnight</span><span>Not legal advice</span>
            </footer>
          </section>
        </div>
        <div className="lx-spacer" aria-hidden="true" />
      </div>

      {/* ── Chrome ── */}
      <header
        className="lx-header"
        style={{
          padding: `14px ${side}px`,
          borderBottomColor: scrolled > 0.5 ? 'var(--o-line)' : 'transparent',
          background: scrolled > 0.5 ? 'var(--o-glass)' : 'transparent',
          backdropFilter: `blur(${Math.round(scrolled * 24)}px)`,
          WebkitBackdropFilter: `blur(${Math.round(scrolled * 24)}px)`,
        }}
      >
        <Brand />
        <nav aria-label="Sections" className="hide-sm lx-nav">
          {([['How it works', 1], ['The lens', 6.05], ['Begin', 8]] as const).map(([l, tt]) => (
            <button key={l} type="button" className="btn btn-ghost btn-sm" onClick={go(tt)}>{l}</button>
          ))}
        </nav>
        <div className="lx-header-end">
          <ThemeToggle />
          <a href="#/demo" className="btn btn-primary btn-sm">Demo <span className="arw" aria-hidden="true">↗</span></a>
        </div>
      </header>

      <div className="lx-ctrl" style={{ right: side, opacity: ctrlO, visibility: vz(ctrlO) }}>
        <span aria-hidden="true" className="mono hide-sm lx-pct">{String(Math.round((t / 8) * 100)).padStart(3, '0')}%</span>
        <button type="button" className="btn btn-secondary lx-round" onClick={go(prevT)} aria-label="Previous chapter">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 19V5M6 11l6-6 6 6" /></svg>
        </button>
        <button type="button" className="btn btn-secondary lx-round" onClick={go(nextT)} aria-label="Next chapter">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 5v14M6 13l6 6 6-6" /></svg>
        </button>
      </div>
      <div className="hide-sm lx-cue" aria-hidden="true" style={{ opacity: 1 - clamp(t * 4) }}><span className="drop" /></div>
      <nav aria-label="Chapters" className="hide-sm lx-rail" style={{ right: side, opacity: railO, visibility: vz(railO) }}>
        {STOPS.map(([tt, label], i) => (
          <button key={label} type="button" onClick={go(tt)} aria-current={i === active ? 'step' : undefined} className={i === active ? 'is-current' : undefined}>
            {label}<span style={{ width: i === active ? 32 : 10 }} />
          </button>
        ))}
      </nav>
    </div>
  );
}
