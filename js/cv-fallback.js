/*
 * cv-fallback.js — tiny hand-written computer-vision kit used when OpenCV.js
 * can't be loaded (offline, CDN blocked, old browser…). Also used for the
 * k-means/morphology steps of colour mode in both engines.
 *
 * Classic script: exposes `self.P2DVision`.
 * All images are single-channel Uint8Array (row-major, width w, height h)
 * unless noted otherwise.
 */
(function (root) {
  'use strict';

  /** RGBA → luma, same weights as OpenCV's RGBA2GRAY. */
  function toGray(rgba, w, h) {
    const out = new Uint8Array(w * h);
    for (let i = 0, p = 0; i < out.length; i++, p += 4) {
      out[i] = (rgba[p] * 4899 + rgba[p + 1] * 9617 + rgba[p + 2] * 1868 + 8192) >> 14;
    }
    return out;
  }

  /** Separable Gaussian blur, ksize odd (1 = no-op). Sigma follows OpenCV's rule. */
  function gaussian(src, w, h, ksize) {
    if (!ksize || ksize < 3) return src;
    const r = ksize >> 1;
    const sigma = 0.3 * ((ksize - 1) * 0.5 - 1) + 0.8;
    const k = new Float32Array(ksize);
    let s = 0;
    for (let i = -r; i <= r; i++) { k[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma)); s += k[i + r]; }
    for (let i = 0; i < ksize; i++) k[i] /= s;
    const tmp = new Float32Array(w * h);
    const out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        let acc = 0;
        for (let i = -r; i <= r; i++) {
          let xx = x + i;
          if (xx < 0) xx = -xx; else if (xx >= w) xx = 2 * w - xx - 2;
          acc += k[i + r] * src[row + Math.max(0, Math.min(w - 1, xx))];
        }
        tmp[row + x] = acc;
      }
    }
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let acc = 0;
        for (let i = -r; i <= r; i++) {
          let yy = y + i;
          if (yy < 0) yy = -yy; else if (yy >= h) yy = 2 * h - yy - 2;
          acc += k[i + r] * tmp[Math.max(0, Math.min(h - 1, yy)) * w + x];
        }
        out[y * w + x] = acc + 0.5;
      }
    }
    return out;
  }

  /** Bilateral filter (edge-preserving smoothing), single channel. */
  function bilateral(src, w, h, d, sigmaColor, sigmaSpace) {
    const r = d >> 1;
    const spatial = [];
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (dx * dx + dy * dy > r * r) continue;
        spatial.push(dx, dy, Math.exp(-(dx * dx + dy * dy) / (2 * sigmaSpace * sigmaSpace)));
      }
    }
    const range = new Float32Array(256);
    for (let i = 0; i < 256; i++) range[i] = Math.exp(-(i * i) / (2 * sigmaColor * sigmaColor));
    const out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const c = src[y * w + x];
        let ws = 0, acc = 0;
        for (let s = 0; s < spatial.length; s += 3) {
          let xx = x + spatial[s], yy = y + spatial[s + 1];
          if (xx < 0) xx = 0; else if (xx >= w) xx = w - 1;
          if (yy < 0) yy = 0; else if (yy >= h) yy = h - 1;
          const v = src[yy * w + xx];
          const wt = spatial[s + 2] * range[v > c ? v - c : c - v];
          ws += wt; acc += wt * v;
        }
        out[y * w + x] = acc / ws + 0.5;
      }
    }
    return out;
  }

  /** Canny: Sobel → L1 magnitude → non-max suppression → hysteresis. Returns 0/255. */
  function canny(src, w, h, low, high) {
    const mag = new Float32Array(w * h);
    const gxA = new Float32Array(w * h), gyA = new Float32Array(w * h);
    const at = (x, y) => src[Math.max(0, Math.min(h - 1, y)) * w + Math.max(0, Math.min(w - 1, x))];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const gx = -at(x - 1, y - 1) - 2 * at(x - 1, y) - at(x - 1, y + 1) + at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1);
        const gy = -at(x - 1, y - 1) - 2 * at(x, y - 1) - at(x + 1, y - 1) + at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1);
        const i = y * w + x;
        gxA[i] = gx; gyA[i] = gy; mag[i] = Math.abs(gx) + Math.abs(gy);
      }
    }
    const T22 = Math.tan(Math.PI / 8), T67 = Math.tan((3 * Math.PI) / 8);
    // 0 = not edge, 1 = weak candidate, 2 = strong
    const state = new Uint8Array(w * h);
    const stack = [];
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x, m = mag[i];
        if (m <= low) continue;
        const gx = gxA[i], gy = gyA[i], ax = Math.abs(gx), ay = Math.abs(gy);
        let n1, n2;
        if (ay <= ax * T22) { n1 = mag[i - 1]; n2 = mag[i + 1]; }
        else if (ay > ax * T67) { n1 = mag[i - w]; n2 = mag[i + w]; }
        else if (gx * gy > 0) { n1 = mag[i - w - 1]; n2 = mag[i + w + 1]; }
        else { n1 = mag[i - w + 1]; n2 = mag[i + w - 1]; }
        if (m > n1 && m >= n2) {
          if (m > high) { state[i] = 2; stack.push(i); } else state[i] = 1;
        }
      }
    }
    const out = new Uint8Array(w * h);
    while (stack.length) {
      const i = stack.pop();
      if (out[i]) continue;
      out[i] = 255;
      const nb = [i - w - 1, i - w, i - w + 1, i - 1, i + 1, i + w - 1, i + w, i + w + 1];
      for (const j of nb) if (state[j] && !out[j]) stack.push(j);
    }
    return out;
  }

  /** Otsu threshold of a grey image. */
  function otsu(src) {
    const hist = new Float64Array(256);
    for (let i = 0; i < src.length; i++) hist[src[i]]++;
    const total = src.length;
    let sum = 0;
    for (let i = 0; i < 256; i++) sum += i * hist[i];
    let sumB = 0, wB = 0, best = 0, thr = 127;
    for (let t = 0; t < 256; t++) {
      wB += hist[t];
      if (!wB) continue;
      const wF = total - wB;
      if (!wF) break;
      sumB += t * hist[t];
      const mB = sumB / wB, mF = (sum - sumB) / wF;
      const between = wB * wF * (mB - mF) * (mB - mF);
      if (between > best) { best = between; thr = t; }
    }
    return thr;
  }

  /**
   * Suzuki–Abe border following (what OpenCV's findContours does) with
   * RETR_LIST + CHAIN_APPROX_NONE semantics: every outer and hole border,
   * every boundary pixel. Input: non-zero = foreground. Output: array of
   * Int32Array interleaved [x0,y0,x1,y1,...].
   */
  function findContours(bin, w, h) {
    const W = w + 2, H = h + 2;
    const f = new Int32Array(W * H);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (bin[y * w + x]) f[(y + 1) * W + x + 1] = 1;
    // neighbour directions, clockwise on screen (y down): E SE S SW W NW N NE
    const off = [1, W + 1, W, W - 1, -1, -W - 1, -W, -W + 1];
    const contours = [];
    let nbd = 1;
    const guardMax = 8 * W * H;
    for (let i = 1; i < H - 1; i++) {
      for (let j = 1; j < W - 1; j++) {
        const p = i * W + j, fp = f[p];
        if (fp === 0) continue;
        let startDir;
        if (fp === 1 && f[p - 1] === 0) startDir = 4;          // outer border, (i2,j2) = west
        else if (fp >= 1 && f[p + 1] === 0) startDir = 0;      // hole border, (i2,j2) = east
        else continue;
        nbd++;
        const pts = [];
        // 3.1: clockwise search around p starting at (i2,j2)
        let found = -1;
        for (let k = 0; k < 8; k++) {
          const d = (startDir + k) & 7;
          if (f[p + off[d]] !== 0) { found = d; break; }
        }
        if (found < 0) {
          f[p] = -nbd;
          pts.push(j - 1, i - 1);
          contours.push(Int32Array.from(pts));
          continue;
        }
        const p1 = p + off[found];
        let p3 = p, dir2 = found, guard = 0;
        for (;;) {
          // 3.3: counter-clockwise search around p3, starting just after p2
          let eastZero = false, d4 = -1;
          for (let k = 1; k <= 8; k++) {
            const d = (dir2 - k + 16) & 7;
            if (f[p3 + off[d]] !== 0) { d4 = d; break; }
            if (d === 0) eastZero = true;
          }
          // 3.4
          if (eastZero) f[p3] = -nbd;
          else if (f[p3] === 1) f[p3] = nbd;
          pts.push((p3 % W) - 1, ((p3 / W) | 0) - 1);
          const p4 = p3 + off[d4];
          if ((p4 === p && p3 === p1) || ++guard > guardMax) break;
          dir2 = (d4 + 4) & 7;
          p3 = p4;
        }
        contours.push(Int32Array.from(pts));
      }
    }
    return contours;
  }

  /** 3×3 binary erosion / dilation (non-zero = 1). */
  function morph(bin, w, h, dilate) {
    const out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let v = dilate ? 0 : 1;
        for (let dy = -1; dy <= 1 && v === (dilate ? 0 : 1); dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= h) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= w) continue;
            const b = bin[yy * w + xx] ? 1 : 0;
            if (dilate && b) { v = 1; break; }
            if (!dilate && !b) { v = 0; break; }
          }
        }
        out[y * w + x] = v;
      }
    }
    return out;
  }
  const open = (b, w, h) => morph(morph(b, w, h, false), w, h, true);
  const close = (b, w, h) => morph(morph(b, w, h, true), w, h, false);

  /** Small seeded PRNG so colour clusters are stable between runs. */
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /**
   * k-means on RGB pixels (k-means++ init, sampled). `skip` (optional) marks
   * pixels to ignore (label 255). Returns { labels: Uint8Array, centers: [[r,g,b],...] }.
   */
  function kmeans(rgba, w, h, k, skip) {
    const n = w * h;
    const rnd = mulberry32(1234567);
    const stride = Math.max(1, Math.floor(n / 40000));
    const samples = [];
    for (let i = 0; i < n; i += stride) if (!skip || !skip[i]) samples.push(rgba[4 * i], rgba[4 * i + 1], rgba[4 * i + 2]);
    const m = samples.length / 3;
    const centers = [];
    if (m === 0) return { labels: new Uint8Array(n).fill(255), centers: [] };
    const first = Math.floor(rnd() * m);
    centers.push([samples[3 * first], samples[3 * first + 1], samples[3 * first + 2]]);
    const dist = new Float64Array(m).fill(Infinity);
    while (centers.length < k) {
      const c = centers[centers.length - 1];
      let sum = 0;
      for (let i = 0; i < m; i++) {
        const dr = samples[3 * i] - c[0], dg = samples[3 * i + 1] - c[1], db = samples[3 * i + 2] - c[2];
        const d = dr * dr + dg * dg + db * db;
        if (d < dist[i]) dist[i] = d;
        sum += dist[i];
      }
      if (sum === 0) break;
      let r = rnd() * sum, pick = m - 1;
      for (let i = 0; i < m; i++) { r -= dist[i]; if (r <= 0) { pick = i; break; } }
      centers.push([samples[3 * pick], samples[3 * pick + 1], samples[3 * pick + 2]]);
    }
    const K = centers.length;
    const assign = new Uint8Array(m);
    for (let iter = 0; iter < 15; iter++) {
      const acc = new Float64Array(K * 4);
      for (let i = 0; i < m; i++) {
        let best = 0, bd = Infinity;
        for (let c = 0; c < K; c++) {
          const dr = samples[3 * i] - centers[c][0], dg = samples[3 * i + 1] - centers[c][1], db = samples[3 * i + 2] - centers[c][2];
          const d = dr * dr + dg * dg + db * db;
          if (d < bd) { bd = d; best = c; }
        }
        assign[i] = best;
        acc[4 * best] += samples[3 * i]; acc[4 * best + 1] += samples[3 * i + 1]; acc[4 * best + 2] += samples[3 * i + 2]; acc[4 * best + 3]++;
      }
      for (let c = 0; c < K; c++) if (acc[4 * c + 3]) centers[c] = [acc[4 * c] / acc[4 * c + 3], acc[4 * c + 1] / acc[4 * c + 3], acc[4 * c + 2] / acc[4 * c + 3]];
    }
    const labels = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      if (skip && skip[i]) { labels[i] = 255; continue; }
      let best = 0, bd = Infinity;
      for (let c = 0; c < K; c++) {
        const dr = rgba[4 * i] - centers[c][0], dg = rgba[4 * i + 1] - centers[c][1], db = rgba[4 * i + 2] - centers[c][2];
        const d = dr * dr + dg * dg + db * db;
        if (d < bd) { bd = d; best = c; }
      }
      labels[i] = best;
    }
    return { labels, centers: centers.map((c) => c.map(Math.round)) };
  }

  /** Per-channel Gaussian blur of an RGBA buffer (alpha untouched). */
  function blurRGBA(rgba, w, h, ksize) {
    if (!ksize || ksize < 3) return rgba;
    const out = new Uint8ClampedArray(rgba.length);
    const ch = new Uint8Array(w * h);
    for (let c = 0; c < 3; c++) {
      for (let i = 0; i < ch.length; i++) ch[i] = rgba[4 * i + c];
      const b = gaussian(ch, w, h, ksize);
      for (let i = 0; i < ch.length; i++) out[4 * i + c] = b[i];
    }
    for (let i = 0; i < ch.length; i++) out[4 * i + 3] = 255;
    return out;
  }

  root.P2DVision = { toGray, gaussian, bilateral, canny, otsu, findContours, morph, open, close, kmeans, blurRGBA };
})(typeof self !== 'undefined' ? self : globalThis);
