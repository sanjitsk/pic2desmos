// app.js — UI wiring for Pic2Desmos.
import {
  DESMOS_API_URL, OPENCV_URL, DESMOS_LIST_LIMIT, WARN_CHARS, SOURCE_MAX, PRESETS, DEFAULTS, SAMPLES,
} from './config.js';
import { layerEquation, multiExpression } from './equation.js';
import { SketchPreview, DesmosPreview, pictureBounds } from './preview.js';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));
const fmt = (n) => n.toLocaleString('en-US');

/* ================= settings ================= */

const STORE_KEY = 'p2d-settings-v1';
const store = {
  get(k) { try { return localStorage.getItem(k); } catch (_) { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (_) { /* private mode etc. */ } },
};

let settings = { ...DEFAULTS };
try {
  const saved = JSON.parse(store.get(STORE_KEY) || 'null');
  if (saved && typeof saved === 'object') for (const k of Object.keys(DEFAULTS)) if (k in saved) settings[k] = saved[k];
} catch (_) { /* ignore corrupt settings */ }
const saveSettings = () => store.set(STORE_KEY, JSON.stringify(settings));

// slider definitions: key, label, min, max, step, (select options), modes it applies to
const SLIDERS = [
  { key: 'maxDim', label: 'Max dimension (px)', min: 300, max: 1600, step: 50, reimage: true },
  { key: 'blur', label: 'Blur kernel', options: [[1, 'Off'], [3, '3×3'], [5, '5×5'], [7, '7×7']] },
  { key: 'cannyLow', label: 'Canny low', min: 1, max: 200, step: 1, modes: ['edges'] },
  { key: 'cannyHigh', label: 'Canny high', min: 1, max: 300, step: 1, modes: ['edges'] },
  { key: 'colorK', label: 'Colors (k-means)', min: 2, max: 8, step: 1, modes: ['color'] },
  { key: 'minLength', label: 'Min stroke length (px)', min: 0, max: 300, step: 1 },
  { key: 'simplify', label: 'Simplify: min size (px)', min: 0, max: 60, step: 1 },
  { key: 'smoothing', label: 'Stroke smoothing', min: 0, max: 6, step: 0.5 },
  { key: 'Kmin', label: 'Min harmonics (Kmin)', min: 1, max: 20, step: 1 },
  { key: 'Kmax', label: 'Max harmonics (Kmax)', min: 2, max: 40, step: 1 },
  { key: 'harmonicDivisor', label: 'Harmonic divisor', min: 5, max: 100, step: 1 },
  { key: 'scale', label: 'Precision (SCALE)', options: [[100, '100 · compact'], [1000, '1000 · max precision']] },
  { key: 'maxStrokes', label: 'Max strokes', min: 10, max: 2000, step: 10 },
  { key: 'lineWidth', label: 'Line width hint', min: 0.5, max: 4, step: 0.5 },
];
const PRESET_KEYS = Object.keys(PRESETS.high);

/* ================= DOM refs ================= */

const els = {
  file: $('#file'), drop: $('#drop'), samples: $('#samples'), editor: $('#editor'), src: $('#srcCanvas'),
  brush: $('#brush'), brushWrap: $('#brushWrap'), sliders: $('#sliders'), modeHint: $('#modeHint'),
  sketch: $('#sketchCanvas'), edge: $('#edgeCanvas'), desmos: $('#desmosEl'), empty: $('#emptyState'),
  busy: $('#busy'), busyText: $('#busyText'), engine: $('#engine'),
  eq: $('#eq'), copy: $('#copy'), download: $('#download'), multiCopy: $('#multiCopy'), multiDownload: $('#multiDownload'),
  layerTabs: $('#layerTabs'), verifyBadge: $('#verifyBadge'), verifyNow: $('#verifyNow'),
  sStrokes: $('#sStrokes'), sChars: $('#sChars'), sTime: $('#sTime'), sList: $('#sList'),
  listBar: $('#listBar'), listMeter: $('#listMeter'), warn: $('#warn'),
  undo: $('#undo'), restoreAll: $('#restoreAll'), toast: $('#toast'), status: $('#status'),
  viewportHint: $('#viewportHint'), themeBtn: $('#themeBtn'),
};

/* ================= toast / status ================= */

let toastTimer = 0;
function toast(msg) {
  els.toast.textContent = msg;
  els.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.remove('show'), 2200);
}
const announce = (msg) => { els.status.textContent = msg; };
function setBusy(on, text) {
  els.busy.hidden = !on;
  if (text) els.busyText.textContent = text;
}

/* ================= theme ================= */

const THEMES = ['auto', 'light', 'dark'];
let theme = store.get('p2d-theme') || 'auto';
const isDark = () => theme === 'dark' || (theme === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
function applyTheme() {
  if (theme === 'auto') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = theme;
  els.themeBtn.setAttribute('aria-label', `Theme: ${theme} (click to change)`);
  els.themeBtn.title = `Theme: ${theme}`;
  sketch.data && (sketch.data.dark = isDark(), sketch.draw());
  desmosView.setDark(isDark());
  drawEdges();
}
els.themeBtn.addEventListener('click', () => {
  theme = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];
  store.set('p2d-theme', theme);
  applyTheme();
  toast(`Theme: ${theme}`);
});
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => theme === 'auto' && applyTheme());

/* ================= worker ================= */

const worker = new Worker('js/worker.js');
let engineReady = false;
let reqId = 0, busy = false, pending = false;
let lastResult = null;   // raw worker result
let lastDebug = null;    // ImageData of edge/mask/cluster preview

worker.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'status') { if (busy) setBusy(true, m.text); }
  else if (m.type === 'ready') {
    engineReady = true;
    if (m.engine === 'opencv') { els.engine.textContent = 'OpenCV.js'; els.engine.className = 'chip ok'; }
    else {
      els.engine.textContent = 'Built-in engine';
      els.engine.className = 'chip warn';
      els.engine.title = m.error ? `OpenCV.js failed to load (${m.error}); using the built-in Canny + contour tracer.` : 'Built-in Canny + contour tracer';
      if (m.error) toast('OpenCV.js could not load — using the built-in edge detector');
    }
    setBusy(false);
    if (image) runProcess();
  } else if (m.type === 'result') {
    busy = false;
    lastResult = m;
    if (m.debug) lastDebug = new ImageData(new Uint8ClampedArray(m.debug.buffer), m.width, m.height);
    drawEdges();
    rebuildOutput();
    if (pending) { pending = false; runProcess(); } else setBusy(false);
  } else if (m.type === 'error') {
    busy = false;
    setBusy(false);
    toast('Processing error: ' + m.message);
    console.error(m.message);
    if (pending) { pending = false; runProcess(); }
  }
};
worker.onerror = (e) => { console.error(e); toast('Worker error: ' + (e.message || 'unknown')); };

setBusy(true, 'Loading OpenCV.js…');
els.engine.textContent = 'Loading OpenCV…';
const forceFallback = new URLSearchParams(location.search).has('fallback');
worker.postMessage({ type: 'init', opencvUrl: new URL(OPENCV_URL, location.href).href, forceFallback });

/* ================= image state ================= */

let image = null;          // { canvas (source, ≤ SOURCE_MAX), name }
let maskCanvas = null;     // same size as source; painted alpha = erased
let crop = null;           // { x, y, w, h } in source px
let work = null;           // { canvas, width, height } — the image actually sent to the worker
let imageVersion = 0, maskVersion = 0;

async function loadBlob(blob, name = 'image') {
  if (!blob || !/^image\//.test(blob.type || 'image/')) { toast('That file is not an image'); return; }
  const url = URL.createObjectURL(blob);
  try {
    const img = await new Promise((resolve, reject) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = () => reject(new Error('Could not decode the image'));
      im.src = url;
    });
    let w = img.naturalWidth || 1000, h = img.naturalHeight || 1000;
    const s = Math.min(1, SOURCE_MAX / Math.max(w, h));
    w = Math.max(1, Math.round(w * s)); h = Math.max(1, Math.round(h * s));
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff';                         // transparent PNGs → white paper
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);                 // GIF → first frame
    image = { canvas: c, name };
    maskCanvas = document.createElement('canvas');
    maskCanvas.width = w; maskCanvas.height = h;
    crop = { x: 0, y: 0, w, h };
    deleted = [];
    els.editor.hidden = false;
    els.drop.classList.add('compact');
    els.empty.hidden = true;
    drawEditor();
    prepareImage();
    announce(`Loaded ${name}, ${w}×${h} pixels`);
  } catch (err) {
    toast(err.message);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Crop + downscale to maxDim, send pixels + mask to the worker. */
function prepareImage() {
  if (!image) return;
  const s = settings.maxDim / Math.max(crop.w, crop.h);
  const tw = Math.max(16, Math.round(crop.w * s)), th = Math.max(16, Math.round(crop.h * s));
  const c = document.createElement('canvas');
  c.width = tw; c.height = th;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, tw, th);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(image.canvas, crop.x, crop.y, crop.w, crop.h, 0, 0, tw, th);
  const data = ctx.getImageData(0, 0, tw, th);
  work = { canvas: c, width: tw, height: th };
  imageVersion++;
  worker.postMessage({ type: 'image', width: tw, height: th, rgba: data.data.buffer, version: imageVersion }, [data.data.buffer]);
  sendMask();
  scheduleProcess(0);
}

function sendMask() {
  if (!work) return;
  const { width: tw, height: th } = work;
  const c = document.createElement('canvas');
  c.width = tw; c.height = th;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(maskCanvas, crop.x, crop.y, crop.w, crop.h, 0, 0, tw, th);
  const a = ctx.getImageData(0, 0, tw, th).data;
  const m = new Uint8Array(tw * th);
  let any = false;
  for (let i = 0; i < m.length; i++) if (a[4 * i + 3] > 40) { m[i] = 1; any = true; }
  maskVersion++;
  worker.postMessage({ type: 'mask', mask: any ? m.buffer : null, version: maskVersion }, any ? [m.buffer] : []);
}

/* ================= processing schedule ================= */

let processTimer = 0;
function scheduleProcess(delay = 300) {
  clearTimeout(processTimer);
  processTimer = setTimeout(runProcess, delay);
}
function runProcess() {
  if (!image || !engineReady) return;
  if (busy) { pending = true; return; }
  busy = true;
  setBusy(true, 'Processing…');
  worker.postMessage({ type: 'process', id: ++reqId, settings: { ...settings } });
}

/* ================= deletions (click-to-delete) ================= */

let deleted = [];   // [{ layer, cx, cy, len }] normalised by width — survives re-processing
function isDeleted(li, s, w) {
  const tol = 0.005;
  return deleted.some((d) => d.layer === li && Math.abs(d.cx - s.cx / w) < tol && Math.abs(d.cy - s.cy / w) < tol
    && Math.abs(d.len / (s.len / w) - 1) < 0.25);
}

/* ================= output ================= */

let output = null;       // { layers: [{color, strokes, latex}], P, ... }
let activeLayer = 0;

function rebuildOutput() {
  const r = lastResult;
  if (!r) return;
  const P = 2 * (settings.Kmax + 1);
  const perLayerLimit = Math.max(1, Math.min(settings.maxStrokes, Math.floor(DESMOS_LIST_LIMIT / P)));
  let kept = 0, overLimit = 0, delCount = 0, maxList = 0, chars = 0;
  const layers = r.layers.map((layer, li) => {
    const alive = [];
    for (const s of layer.strokes) {
      if (isDeleted(li, s, r.width)) { delCount++; continue; }
      alive.push(s);
    }
    const strokes = alive.slice(0, perLayerLimit);
    overLimit += alive.length - strokes.length;
    kept += strokes.length;
    maxList = Math.max(maxList, strokes.length * P);
    const latex = layerEquation(strokes, settings.Kmax, settings.scale);
    chars += latex.length;
    return { color: layer.color, strokes, latex };
  }).filter((l) => l.strokes.length);
  const c = r.counts;
  const dropped = c.short + c.tiny + c.capped + overLimit + delCount;
  output = { layers, P, kept, dropped, overLimit, delCount, maxList, chars, counts: c, perLayerLimit };
  if (activeLayer >= layers.length) activeLayer = 0;

  // preview
  sketch.set({
    layers, width: r.width, height: r.height, scale: settings.scale, centerY: settings.centerY,
    lineWidth: settings.lineWidth, original: work && work.canvas, showOriginal: settings.showOriginal, dark: isDark(),
  });
  // stats
  els.sStrokes.textContent = `${fmt(kept)} kept · ${fmt(dropped)} dropped`;
  els.sStrokes.title = `short: ${c.short}, tiny: ${c.tiny}, over list limit: ${overLimit + c.capped}, deleted: ${delCount}`;
  els.sChars.textContent = fmt(chars);
  els.sTime.textContent = `${r.ms} ms`;
  els.sList.textContent = `${fmt(maxList)} / ${fmt(DESMOS_LIST_LIMIT)}`;
  const pct = Math.min(100, (maxList / DESMOS_LIST_LIMIT) * 100);
  els.listBar.style.width = pct + '%';
  els.listMeter.setAttribute('aria-valuenow', String(maxList));
  els.listMeter.className = 'meter' + (overLimit > 0 ? ' red' : pct > 85 ? ' amber' : '');
  const warns = [];
  let level = '';
  if (overLimit > 0) {
    level = 'red';
    warns.push(`Desmos list limit reached: ${fmt(overLimit)} of the shortest strokes were dropped to stay under ${fmt(DESMOS_LIST_LIMIT)} values. Lower Kmax or raise Min stroke length to fit more.`);
  }
  if (chars > WARN_CHARS) {
    level = level || 'amber';
    warns.push(`${fmt(chars)} characters — Desmos may be slow. Desktop handles this; the phone app may not.`);
  }
  if (!kept) { level = level || 'amber'; warns.push('No strokes found. Try a lower Canny threshold, a shorter Min stroke length, or another mode.'); }
  els.warn.hidden = !warns.length;
  els.warn.className = 'warn ' + level;
  els.warn.textContent = warns.join(' ');
  // viewport hint
  const b = pictureBounds(r.width, r.height, settings.centerY);
  els.viewportHint.textContent = `Desmos viewport: the picture sits in ${b.left} ≤ x ≤ ${b.right}, ${b.bottom.toFixed(2)} ≤ y ≤ ${b.top.toFixed(2)}. Zoom to that box if it looks small.`;
  renderLayerTabs();
  renderEquation();
  els.undo.disabled = !deleted.length;
  els.restoreAll.disabled = !deleted.length;
  announce(`${kept} strokes, ${chars} characters`);
  scheduleVerify();
}

function renderLayerTabs() {
  const layers = output ? output.layers : [];
  const show = settings.mode === 'color' && layers.length > 0;
  els.layerTabs.hidden = !show;
  if (!show) return;
  els.layerTabs.innerHTML = '';
  layers.forEach((l, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'layer-tab';
    b.setAttribute('aria-pressed', String(i === activeLayer));
    b.innerHTML = `<span class="swatch" style="background:${l.color}"></span>${l.color} · ${l.strokes.length}`;
    b.title = 'Each color is its own equation. Paste each one into its own line and set that color in Desmos.';
    b.addEventListener('click', () => { activeLayer = i; renderLayerTabs(); renderEquation(); });
    els.layerTabs.appendChild(b);
  });
  const note = document.createElement('p');
  note.className = 'muted small';
  note.style.margin = '0';
  note.textContent = `Color mode: ${layers.length} equations, one per color. Paste each into its own expression line and set its color.`;
  els.layerTabs.appendChild(note);
}

function currentLatex() {
  if (!output || !output.layers.length) return '';
  return output.layers[activeLayer].latex;
}
function renderEquation() {
  const latex = currentLatex();
  els.eq.value = latex;
  for (const b of [els.copy, els.download, els.multiCopy, els.multiDownload]) b.disabled = !latex;
}

/* ================= previews ================= */

const sketch = new SketchPreview(els.sketch);
const desmosView = new DesmosPreview(els.desmos, DESMOS_API_URL);
let view = 'sketch';

function setView(v) {
  view = v;
  $$('.seg.tabs [role="tab"]').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.view === v)));
  $$('.stage .view').forEach((el) => el.classList.toggle('active', el.dataset.view === v));
  $$('[data-view-only]').forEach((el) => { el.hidden = el.dataset.viewOnly !== v; });
  if (v === 'desmos') {
    desmosView.ensure().then(() => desmosView.resize()).catch(() => {});
    if (verifyState !== 'ok' && verifyState !== 'checking') verify();
  }
}
$$('.seg.tabs [role="tab"]').forEach((t) => t.addEventListener('click', () => setView(t.dataset.view)));
$$('.seg.tabs [role="tab"]').forEach((t) => t.addEventListener('keydown', (e) => {
  const tabs = $$('.seg.tabs [role="tab"]');
  const i = tabs.indexOf(t);
  if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
    const n = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
    n.focus(); setView(n.dataset.view);
  }
}));

function drawEdges() {
  if (!lastDebug) return;
  const c = els.edge;
  c.width = lastDebug.width; c.height = lastDebug.height;
  const ctx = c.getContext('2d');
  let img = lastDebug;
  const flip = settings.mode !== 'color' && (settings.invertEdges !== isDark());
  if (flip) {
    const d = new Uint8ClampedArray(lastDebug.data);
    for (let i = 0; i < d.length; i += 4) { d[i] = 255 - d[i]; d[i + 1] = 255 - d[i + 1]; d[i + 2] = 255 - d[i + 2]; }
    img = new ImageData(d, lastDebug.width, lastDebug.height);
  }
  ctx.putImageData(img, 0, 0);
}

// sketch click-to-delete
els.sketch.addEventListener('pointermove', (e) => {
  if (e.pointerType !== 'mouse') return;
  const h = sketch.hitTest(e.clientX, e.clientY);
  els.sketch.classList.toggle('hovering', !!h);
  sketch.setHover(h);
});
els.sketch.addEventListener('pointerleave', () => sketch.setHover(null));
els.sketch.addEventListener('click', (e) => {
  if (!output || !lastResult) return;
  const h = sketch.hitTest(e.clientX, e.clientY, e.pointerType === 'touch' ? 14 : 8);
  if (!h) return;
  const s = output.layers[h.layer].strokes[h.index];
  // map back to the worker layer index (output layers drop empty ones)
  const li = lastResult.layers.findIndex((L) => L.strokes.includes(s));
  const w = lastResult.width;
  deleted.push({ layer: li, cx: s.cx / w, cy: s.cy / w, len: s.len / w });
  sketch.hover = null;
  rebuildOutput();
  toast('Stroke deleted — Ctrl+Z to undo');
});
function undoDelete() {
  if (!deleted.length) return;
  deleted.pop();
  rebuildOutput();
  toast('Stroke restored');
}
els.undo.addEventListener('click', undoDelete);
els.restoreAll.addEventListener('click', () => { deleted = []; rebuildOutput(); toast('All strokes restored'); });

/* ================= Desmos verification ================= */

let verifyTimer = 0, verifyState = 'idle';
function setBadge(state, text) {
  verifyState = state;
  els.verifyBadge.className = 'badge ' + (state === 'ok' ? 'ok' : state === 'err' ? 'err' : state === 'checking' ? 'checking' : 'idle');
  els.verifyBadge.textContent = text;
}
function scheduleVerify() {
  clearTimeout(verifyTimer);
  setBadge('idle', settings.autoVerify ? 'Waiting to check…' : 'Not checked');
  if (settings.autoVerify || view === 'desmos') verifyTimer = setTimeout(verify, 900);
}
async function verify() {
  if (!output || !output.layers.length || !lastResult) { setBadge('idle', 'Nothing to check'); return; }
  setBadge('checking', 'Checking in Desmos…');
  const items = output.layers.map((l, i) => ({
    id: 'pic' + i, latex: l.latex, color: l.color === '#000000' ? (isDark() ? '#ffffff' : '#000000') : l.color,
  }));
  try {
    desmosView.setDark(isDark());
    const res = await desmosView.verify(items, pictureBounds(lastResult.width, lastResult.height, settings.centerY), settings.lineWidth);
    if (res.stale) return;
    if (res.ok) setBadge('ok', '✅ Verified in Desmos');
    else setBadge('err', '❌ ' + res.errors.map((e) => e.message).join('; '));
  } catch (err) {
    setBadge('err', 'Desmos API unavailable — canvas preview only');
  }
}
els.verifyNow.addEventListener('click', verify);

/* ================= copy / download ================= */

async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return true; }
  } catch (_) { /* fall through */ }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed'; ta.style.top = '-1000px'; ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  ta.setSelectionRange(0, text.length);
  let ok = false;
  try { ok = document.execCommand('copy'); } catch (_) { ok = false; }
  ta.remove();
  return ok;
}
function download(text, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
const baseName = () => (image ? image.name.replace(/\.[^.]+$/, '') : 'pic2desmos').replace(/[^\w-]+/g, '_') || 'pic2desmos';
const layerSuffix = () => (output && output.layers.length > 1 ? `-${output.layers[activeLayer].color.slice(1)}` : '');

async function copyEquation() {
  const t = currentLatex();
  if (!t) return;
  const ok = await copyText(t);
  if (!ok) { els.eq.focus(); els.eq.select(); }
  toast(ok ? `Copied! (${fmt(t.length)} characters)` : 'Press Ctrl+C to copy the selected text');
}
els.copy.addEventListener('click', copyEquation);
els.download.addEventListener('click', () => download(currentLatex(), `${baseName()}-desmos${layerSuffix()}.txt`));
const multiText = () => (output && output.layers.length ? multiExpression(output.layers[activeLayer].strokes, settings.scale) : '');
els.multiCopy.addEventListener('click', async () => {
  const t = multiText();
  const ok = await copyText(t);
  toast(ok ? `Copied ${output.layers[activeLayer].strokes.length} lines` : 'Copy failed — use Download instead');
});
els.multiDownload.addEventListener('click', () => download(multiText(), `${baseName()}-multi${layerSuffix()}.txt`));

/* ================= settings UI ================= */

function buildSliders() {
  for (const d of SLIDERS) {
    const wrap = document.createElement('div');
    wrap.className = 'slider';
    wrap.dataset.key = d.key;
    if (d.modes) wrap.dataset.modes = d.modes.join(' ');
    const id = 'set-' + d.key;
    if (d.options) {
      wrap.innerHTML = `<div class="top"><label for="${id}">${d.label}</label></div>
        <select id="${id}">${d.options.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select>`;
    } else {
      wrap.innerHTML = `<div class="top"><label for="${id}">${d.label}</label><output for="${id}"></output></div>
        <input id="${id}" type="range" min="${d.min}" max="${d.max}" step="${d.step}">`;
    }
    els.sliders.appendChild(wrap);
    const input = wrap.querySelector('input, select');
    input.addEventListener('input', () => {
      settings[d.key] = Number(input.value);
      const out = wrap.querySelector('output');
      if (out) out.textContent = input.value;
      if (PRESET_KEYS.includes(d.key)) settings.preset = 'custom';
      afterSettingChange(d.reimage);
    });
  }
}

function syncUI() {
  for (const d of SLIDERS) {
    const input = document.getElementById('set-' + d.key);
    input.value = String(settings[d.key]);
    const out = input.closest('.slider').querySelector('output');
    if (out) out.textContent = String(settings[d.key]);
  }
  $$('input[name="preset"]').forEach((r) => { r.checked = r.value === settings.preset; });
  $('#presetSeg').classList.toggle('custom', settings.preset === 'custom');
  $$('input[name="mode"]').forEach((r) => { r.checked = r.value === settings.mode; });
  for (const k of ['invertSilhouette', 'skipBackground', 'centerY', 'showOriginal', 'invertEdges', 'autoVerify']) {
    const el = document.getElementById(k);
    if (el) el.checked = !!settings[k];
  }
  $$('.slider[data-modes]').forEach((el) => { el.hidden = !el.dataset.modes.split(' ').includes(settings.mode); });
  $$('.check[data-mode]').forEach((el) => { el.hidden = el.dataset.mode !== settings.mode; });
  els.modeHint.textContent = {
    edges: 'Canny edge detection — best for photos and drawings.',
    silhouette: 'Otsu threshold → outlines. Best for logos and simple shapes.',
    color: 'Splits the picture into color clusters and traces each region. One equation per color.',
  }[settings.mode];
}

let lastMaxDim = settings.maxDim;
function afterSettingChange(reimage) {
  saveSettings();
  syncUI();
  if (!image) return;
  if (reimage || settings.maxDim !== lastMaxDim) {
    lastMaxDim = settings.maxDim;
    clearTimeout(reimageTimer);
    reimageTimer = setTimeout(prepareImage, 300);
  } else scheduleProcess(300);
}
let reimageTimer = 0;

$$('input[name="preset"]').forEach((r) => r.addEventListener('change', () => {
  settings.preset = r.value;
  Object.assign(settings, PRESETS[r.value]);
  afterSettingChange(false);
  toast(`${r.value[0].toUpperCase() + r.value.slice(1)} preset`);
}));
$$('input[name="mode"]').forEach((r) => r.addEventListener('change', () => {
  settings.mode = r.value;
  activeLayer = 0;
  afterSettingChange(false);
}));
for (const k of ['invertSilhouette', 'skipBackground', 'centerY']) {
  document.getElementById(k).addEventListener('change', (e) => { settings[k] = e.target.checked; afterSettingChange(false); });
}
$('#showOriginal').addEventListener('change', (e) => {
  settings.showOriginal = e.target.checked; saveSettings();
  if (sketch.data) { sketch.data.showOriginal = settings.showOriginal; sketch.draw(); }
});
$('#invertEdges').addEventListener('change', (e) => { settings.invertEdges = e.target.checked; saveSettings(); drawEdges(); });
$('#autoVerify').addEventListener('change', (e) => { settings.autoVerify = e.target.checked; saveSettings(); if (e.target.checked) scheduleVerify(); });
$('#resetSettings').addEventListener('click', () => {
  settings = { ...DEFAULTS };
  afterSettingChange(true);
  toast('Settings reset');
});

/* ================= source editor: crop + mask ================= */

let tool = 'crop';
let drag = null;
$$('input[name="tool"]').forEach((r) => r.addEventListener('change', () => {
  tool = r.value;
  els.brushWrap.style.visibility = tool === 'crop' ? 'hidden' : 'visible';
}));
els.brushWrap.style.visibility = 'hidden';

function drawEditor(preview) {
  if (!image) return;
  const c = els.src;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const cssW = c.clientWidth || 400;
  const cssH = (cssW * image.canvas.height) / image.canvas.width;
  c.style.height = cssH + 'px';
  c.width = Math.round(cssW * dpr); c.height = Math.round(cssH * dpr);
  const ctx = c.getContext('2d');
  const k = c.width / image.canvas.width;
  ctx.drawImage(image.canvas, 0, 0, c.width, c.height);
  // mask overlay (red)
  ctx.globalAlpha = 0.55;
  ctx.drawImage(maskCanvas, 0, 0, c.width, c.height);
  ctx.globalAlpha = 1;
  // crop shading
  const r = preview || crop;
  ctx.fillStyle = 'rgba(0,0,0,.5)';
  ctx.beginPath();
  ctx.rect(0, 0, c.width, c.height);
  ctx.rect(r.x * k, r.y * k, r.w * k, r.h * k);
  ctx.fill('evenodd');
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 2 * dpr;
  ctx.setLineDash([6 * dpr, 4 * dpr]);
  ctx.strokeRect(r.x * k + 1, r.y * k + 1, r.w * k - 2, r.h * k - 2);
  ctx.setLineDash([]);
}

function srcPoint(e) {
  const rect = els.src.getBoundingClientRect();
  return {
    x: Math.max(0, Math.min(image.canvas.width, ((e.clientX - rect.left) / rect.width) * image.canvas.width)),
    y: Math.max(0, Math.min(image.canvas.height, ((e.clientY - rect.top) / rect.height) * image.canvas.height)),
  };
}
function paint(from, to) {
  const ctx = maskCanvas.getContext('2d');
  const rect = els.src.getBoundingClientRect();
  const r = (Number(els.brush.value) / 2) * (image.canvas.width / rect.width);
  ctx.globalCompositeOperation = tool === 'restore' ? 'destination-out' : 'source-over';
  ctx.strokeStyle = ctx.fillStyle = '#ff3b30';
  ctx.lineCap = 'round';
  ctx.lineWidth = 2 * r;
  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  ctx.lineTo(to.x, to.y);
  ctx.stroke();
  ctx.globalCompositeOperation = 'source-over';
}
els.src.addEventListener('pointerdown', (e) => {
  if (!image) return;
  els.src.setPointerCapture(e.pointerId);
  const p = srcPoint(e);
  drag = { start: p, last: p };
  if (tool !== 'crop') { paint(p, p); drawEditor(); }
});
els.src.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const p = srcPoint(e);
  if (tool === 'crop') {
    const r = { x: Math.min(drag.start.x, p.x), y: Math.min(drag.start.y, p.y), w: Math.abs(p.x - drag.start.x), h: Math.abs(p.y - drag.start.y) };
    drag.rect = r;
    drawEditor(r);
  } else {
    paint(drag.last, p);
    drag.last = p;
    drawEditor();
  }
});
function endDrag() {
  if (!drag) return;
  if (tool === 'crop') {
    const r = drag.rect;
    const minSide = Math.max(12, image.canvas.width * 0.03);
    if (r && r.w > minSide && r.h > minSide) {
      crop = { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h) };
      deleted = [];
      prepareImage();
      toast('Cropped');
    }
    drawEditor();
  } else {
    sendMask();
    scheduleProcess(50);
  }
  drag = null;
}
els.src.addEventListener('pointerup', endDrag);
els.src.addEventListener('pointercancel', endDrag);
$('#resetCrop').addEventListener('click', () => {
  if (!image) return;
  crop = { x: 0, y: 0, w: image.canvas.width, h: image.canvas.height };
  deleted = [];
  drawEditor(); prepareImage();
});
$('#clearMask').addEventListener('click', () => {
  if (!image) return;
  maskCanvas.getContext('2d').clearRect(0, 0, maskCanvas.width, maskCanvas.height);
  drawEditor(); sendMask(); scheduleProcess(0);
});

/* ================= input: file, drop, paste, samples ================= */

els.file.addEventListener('change', () => { const f = els.file.files[0]; if (f) loadBlob(f, f.name); els.file.value = ''; });
els.drop.addEventListener('click', (e) => { if (e.target.tagName !== 'LABEL') els.file.click(); });
els.drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); els.file.click(); } });
['dragenter', 'dragover'].forEach((t) => document.addEventListener(t, (e) => { e.preventDefault(); els.drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((t) => document.addEventListener(t, (e) => {
  e.preventDefault();
  if (t === 'dragleave' && e.relatedTarget) return;
  els.drop.classList.remove('over');
}));
document.addEventListener('drop', (e) => {
  const f = e.dataTransfer && Array.from(e.dataTransfer.files).find((x) => x.type.startsWith('image/'));
  if (f) loadBlob(f, f.name);
});
document.addEventListener('paste', (e) => {
  const items = e.clipboardData ? Array.from(e.clipboardData.items) : [];
  const it = items.find((i) => i.kind === 'file' && i.type.startsWith('image/'));
  if (!it) return;
  e.preventDefault();
  loadBlob(it.getAsFile(), 'pasted-image.png');
  toast('Image pasted');
});

for (const s of SAMPLES) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'sample';
  b.innerHTML = `<img src="${s.file}" alt="" loading="lazy"><span>${s.label}</span>`;
  b.setAttribute('aria-label', `Try sample: ${s.label}`);
  b.addEventListener('click', async () => {
    try {
      const blob = await (await fetch(s.file)).blob();
      settings.preset = s.preset;
      Object.assign(settings, PRESETS[s.preset]);
      settings.mode = s.mode;
      lastMaxDim = settings.maxDim;
      saveSettings(); syncUI();
      await loadBlob(blob, s.file.split('/').pop());
    } catch (err) { toast('Could not load sample: ' + err.message); }
  });
  els.samples.appendChild(b);
}

/* ================= keyboard shortcuts ================= */

document.addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey;
  const inText = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName) && document.activeElement.type !== 'range'
    && document.activeElement.type !== 'radio' && document.activeElement.type !== 'checkbox';
  if (mod && e.shiftKey && (e.key === 'C' || e.key === 'c')) { e.preventDefault(); copyEquation(); }
  else if (mod && !e.shiftKey && (e.key === 'z' || e.key === 'Z') && !inText && deleted.length) { e.preventDefault(); undoDelete(); }
});

/* ================= resize ================= */

let resizeTimer = 0;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { drawEditor(); sketch.draw(); desmosView.resize(); }, 120);
});

/* ================= boot ================= */

buildSliders();
syncUI();
applyTheme();
setView('sketch');

// expose a tiny hook for automated tests
window.__p2d = { sketch, get output() { return output; }, get settings() { return settings; }, get verifyState() { return verifyState; }, loadBlob, verify };
