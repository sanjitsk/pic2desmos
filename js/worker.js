/*
 * worker.js — image → strokes → Fourier coefficients, off the main thread.
 *
 * Classic worker (not a module worker) because OpenCV.js has to be loaded
 * with importScripts().
 *
 * Messages in:
 *   { type: 'init', opencvUrl, forceFallback }
 *   { type: 'image', width, height, rgba: ArrayBuffer, version }
 *   { type: 'mask',  mask: ArrayBuffer | null, version }      (1 = erased)
 *   { type: 'process', id, settings }
 * Messages out:
 *   { type: 'status', text }
 *   { type: 'ready', engine, error? }
 *   { type: 'result', id, layers, counts, debug?, width, height, ms }
 *   { type: 'error', id, message }
 */
/* global cv, P2DFourier, P2DVision */
'use strict';

importScripts('fourier.js', 'cv-fallback.js');

const BORDER = 3;            // px zeroed at the image border (no frame tracing)
const CAND_MAX = 3000;       // max candidate strokes sent back per layer
const SAMPLES = 512;         // resample points per stroke

let engine = 'fallback';
let CV = null;
let img = null;              // { width, height, rgba: Uint8ClampedArray, version }
let mask = null;             // Uint8Array | null
let maskVersion = 0;
let stage1 = { key: null, data: null };

function post(msg, transfer) { self.postMessage(msg, transfer || []); }

/* ---------- OpenCV loading ---------- */

function waitForCv(timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('OpenCV runtime timed out')), timeoutMs);
    const done = (m) => { clearTimeout(timer); resolve({ m }); }; // wrapped: the emscripten Module is a thenable
    const c = self.cv;
    if (!c) { clearTimeout(timer); reject(new Error('cv is undefined')); return; }
    if (c.Mat && c.findContours) { done(c); return; }
    if (typeof c.then === 'function') { c.then((m) => done(m)); return; }
    const prev = c.onRuntimeInitialized;
    c.onRuntimeInitialized = () => { if (prev) try { prev(); } catch (_) {} done(c); };
  });
}

async function init(msg) {
  if (!msg.forceFallback && msg.opencvUrl) {
    try {
      post({ type: 'status', text: 'Downloading OpenCV.js (~10 MB)…' });
      importScripts(msg.opencvUrl);
      post({ type: 'status', text: 'Starting OpenCV…' });
      const { m } = await waitForCv(60000);
      CV = m;
      self.cv = m;
      engine = 'opencv';
      post({ type: 'ready', engine });
      return;
    } catch (err) {
      post({ type: 'ready', engine: 'fallback', error: String(err && err.message || err) });
      return;
    }
  }
  post({ type: 'ready', engine: 'fallback' });
}

/* ---------- helpers ---------- */

function zeroBorderAndMask(bin, w, h) {
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x < BORDER || y < BORDER || x >= w - BORDER || y >= h - BORDER) bin[y * w + x] = 0;
    }
  }
  if (mask && mask.length === w * h) for (let i = 0; i < bin.length; i++) if (mask[i]) bin[i] = 0;
  return bin;
}

function grayToRGBA(g) {
  const out = new Uint8ClampedArray(g.length * 4);
  for (let i = 0; i < g.length; i++) {
    const v = 255 - g[i]; // black lines on white
    out[4 * i] = out[4 * i + 1] = out[4 * i + 2] = v;
    out[4 * i + 3] = 255;
  }
  return out;
}

function contoursCV(bin, w, h) {
  const m = new CV.Mat(h, w, CV.CV_8UC1);
  m.data.set(bin);
  const cs = new CV.MatVector(), hier = new CV.Mat();
  CV.findContours(m, cs, hier, CV.RETR_LIST, CV.CHAIN_APPROX_NONE);
  const out = [];
  for (let i = 0; i < cs.size(); i++) {
    const c = cs.get(i);
    out.push(Int32Array.from(c.data32S));
    c.delete();
  }
  m.delete(); cs.delete(); hier.delete();
  return out;
}
const contours = (bin, w, h) => (engine === 'opencv' ? contoursCV(bin, w, h) : P2DVision.findContours(bin, w, h));

/* ---------- stage 1: picture → contours (cached) ---------- */

function edgesStage(s, w, h) {
  let edges;
  const blur = s.blur | 0;
  if (engine === 'opencv') {
    const src = CV.matFromImageData(new ImageData(img.rgba, w, h));
    const gray = new CV.Mat(), bil = new CV.Mat(), bl = new CV.Mat(), ed = new CV.Mat();
    CV.cvtColor(src, gray, CV.COLOR_RGBA2GRAY);
    CV.bilateralFilter(gray, bil, 9, 60, 60, CV.BORDER_DEFAULT);
    if (blur >= 3) CV.GaussianBlur(bil, bl, new CV.Size(blur, blur), 0, 0, CV.BORDER_DEFAULT); else bil.copyTo(bl);
    CV.Canny(bl, ed, s.cannyLow, s.cannyHigh, 3, false);
    edges = Uint8Array.from(ed.data);
    [src, gray, bil, bl, ed].forEach((m) => m.delete());
  } else {
    let g = P2DVision.toGray(img.rgba, w, h);
    g = P2DVision.bilateral(g, w, h, 9, 60, 60);
    g = P2DVision.gaussian(g, w, h, blur);
    edges = P2DVision.canny(g, w, h, s.cannyLow, s.cannyHigh);
  }
  zeroBorderAndMask(edges, w, h);
  return { layers: [{ color: '#000000', contours: contours(edges, w, h) }], debug: grayToRGBA(edges) };
}

function silhouetteStage(s, w, h) {
  let g = P2DVision.toGray(img.rgba, w, h);
  g = P2DVision.gaussian(g, w, h, Math.max(3, s.blur | 0));
  const t = P2DVision.otsu(g);
  const bin = new Uint8Array(w * h);
  // default: dark = foreground (logos on light paper); "invert" flips it
  for (let i = 0; i < g.length; i++) bin[i] = (s.invertSilhouette ? g[i] > t : g[i] <= t) ? 255 : 0;
  zeroBorderAndMask(bin, w, h);
  return { layers: [{ color: '#000000', contours: contours(bin, w, h) }], debug: grayToRGBA(bin) };
}

function colorStage(s, w, h) {
  let rgba = img.rgba;
  if (engine === 'opencv') {
    const src = CV.matFromImageData(new ImageData(img.rgba, w, h));
    const rgb = new CV.Mat(), bil = new CV.Mat(), back = new CV.Mat();
    CV.cvtColor(src, rgb, CV.COLOR_RGBA2RGB);
    CV.bilateralFilter(rgb, bil, 9, 60, 60, CV.BORDER_DEFAULT);
    CV.cvtColor(bil, back, CV.COLOR_RGB2RGBA);
    rgba = Uint8ClampedArray.from(back.data);
    [src, rgb, bil, back].forEach((m) => m.delete());
  }
  rgba = P2DVision.blurRGBA(rgba, w, h, Math.max(3, s.blur | 0));
  const { labels, centers } = P2DVision.kmeans(rgba, w, h, s.colorK, mask && mask.length === w * h ? mask : null);

  // background cluster = the one that owns most of the border pixels
  const border = new Float64Array(centers.length);
  for (let x = 0; x < w; x++) { border[labels[x]]++; border[labels[(h - 1) * w + x]]++; }
  for (let y = 0; y < h; y++) { border[labels[y * w]]++; border[labels[y * w + w - 1]]++; }
  let bg = -1, bgMax = -1;
  for (let c = 0; c < centers.length; c++) if (border[c] > bgMax) { bgMax = border[c]; bg = c; }

  const debug = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const l = labels[i];
    const c = l === 255 ? [255, 255, 255] : centers[l];
    debug[4 * i] = c[0]; debug[4 * i + 1] = c[1]; debug[4 * i + 2] = c[2]; debug[4 * i + 3] = 255;
  }
  const hex = (c) => '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('');
  const layers = [];
  for (let c = 0; c < centers.length; c++) {
    if (s.skipBackground && c === bg) continue;
    let bin = new Uint8Array(w * h), area = 0;
    for (let i = 0; i < bin.length; i++) if (labels[i] === c) { bin[i] = 255; area++; }
    if (area < w * h * 0.003) continue;
    bin = P2DVision.close(P2DVision.open(bin, w, h), w, h);
    for (let i = 0; i < bin.length; i++) bin[i] = bin[i] ? 255 : 0;
    zeroBorderAndMask(bin, w, h);
    layers.push({ color: hex(centers[c]), area, contours: contours(bin, w, h) });
  }
  layers.sort((a, b) => b.area - a.area);
  return { layers, debug };
}

/* ---------- stage 2: contours → Fourier strokes ---------- */

function strokesStage(st1, s, w, h) {
  const counts = { found: 0, short: 0, tiny: 0, capped: 0 };
  const opts = {
    width: w, height: h, Kmin: s.Kmin, Kmax: s.Kmax, divisor: s.harmonicDivisor,
    scale: s.scale, smoothing: s.smoothing, samples: SAMPLES, centerY: !!s.centerY,
  };
  const transfer = [];
  const layers = st1.layers.map((layer) => {
    const cands = [];
    for (const c of layer.contours) {
      counts.found++;
      const len = P2DFourier.arcLength(c);
      if (len < s.minLength) { counts.short++; continue; }
      const bb = P2DFourier.bbox(c);
      if (s.simplify > 0 && Math.max(bb.w, bb.h) < s.simplify) { counts.tiny++; continue; }
      cands.push({ c, len, bb });
    }
    cands.sort((a, b) => b.len - a.len);
    if (cands.length > CAND_MAX) { counts.capped += cands.length - CAND_MAX; cands.length = CAND_MAX; }
    const strokes = cands.map(({ c, len, bb }) => {
      const r = P2DFourier.strokeCoefficients(c, opts);
      transfer.push(r.X.buffer, r.Y.buffer);
      return { K: r.K, X: r.X, Y: r.Y, len, cx: (bb.minX + bb.maxX) / 2, cy: (bb.minY + bb.maxY) / 2, bw: bb.w, bh: bb.h };
    });
    return { color: layer.color, strokes };
  });
  return { layers, counts, transfer };
}

/* ---------- message loop ---------- */

function process(msg) {
  const t0 = performance.now();
  const s = msg.settings;
  if (!img) throw new Error('No image loaded');
  const w = img.width, h = img.height;
  const key = JSON.stringify([img.version, maskVersion, s.mode, s.blur, s.cannyLow, s.cannyHigh,
    s.invertSilhouette, s.mode === 'color' ? [s.colorK, s.skipBackground] : 0]);
  let fresh = false;
  if (stage1.key !== key) {
    post({ type: 'status', text: 'Finding edges…' });
    stage1.data = s.mode === 'silhouette' ? silhouetteStage(s, w, h)
      : s.mode === 'color' ? colorStage(s, w, h) : edgesStage(s, w, h);
    stage1.key = key;
    fresh = true;
  }
  post({ type: 'status', text: 'Computing Fourier coefficients…' });
  const { layers, counts, transfer } = strokesStage(stage1.data, s, w, h);
  const out = { type: 'result', id: msg.id, layers, counts, width: w, height: h, engine, ms: Math.round(performance.now() - t0) };
  if (fresh) {
    const dbg = stage1.data.debug.slice();
    out.debug = dbg;
    transfer.push(dbg.buffer);
  }
  post(out, transfer);
}

self.onmessage = async (e) => {
  const msg = e.data;
  try {
    if (msg.type === 'init') await init(msg);
    else if (msg.type === 'image') {
      img = { width: msg.width, height: msg.height, rgba: new Uint8ClampedArray(msg.rgba), version: msg.version };
      stage1.key = null;
    } else if (msg.type === 'mask') {
      mask = msg.mask ? new Uint8Array(msg.mask) : null;
      maskVersion = msg.version;
    } else if (msg.type === 'process') process(msg);
  } catch (err) {
    post({ type: 'error', id: msg.id, message: String(err && err.message || err) });
  }
};
