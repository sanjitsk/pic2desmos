/*
 * fourier.js — resampling + DFT helpers.
 *
 * Written as a classic script (not an ES module) so the same file can be
 * loaded by the Web Worker with importScripts() *and* by the page with a
 * plain <script> tag. Everything is exposed on `self.P2DFourier`.
 */
(function (root) {
  'use strict';

  const TAU = Math.PI * 2;

  /** Closed-loop arc length of an interleaved [x0,y0,x1,y1,...] point array. */
  function arcLength(pts) {
    const n = pts.length >> 1;
    if (n < 2) return 0;
    let len = 0;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      len += Math.hypot(pts[2 * j] - pts[2 * i], pts[2 * j + 1] - pts[2 * i + 1]);
    }
    return len;
  }

  /** Axis-aligned bounding box. */
  function bbox(pts) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < pts.length; i += 2) {
      const x = pts[i], y = pts[i + 1];
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY };
  }

  /** Circular Gaussian smoothing of a closed contour (sigma in points). */
  function smoothClosed(pts, sigma) {
    const n = pts.length >> 1;
    if (!sigma || sigma <= 0 || n < 5) return Float64Array.from(pts);
    const r = Math.min(Math.ceil(sigma * 3), (n >> 1) - 1);
    const w = new Float64Array(2 * r + 1);
    let ws = 0;
    for (let k = -r; k <= r; k++) { w[k + r] = Math.exp(-(k * k) / (2 * sigma * sigma)); ws += w[k + r]; }
    for (let k = 0; k < w.length; k++) w[k] /= ws;
    const out = new Float64Array(pts.length);
    for (let i = 0; i < n; i++) {
      let sx = 0, sy = 0;
      for (let k = -r; k <= r; k++) {
        const j = ((i + k) % n + n) % n;
        sx += w[k + r] * pts[2 * j];
        sy += w[k + r] * pts[2 * j + 1];
      }
      out[2 * i] = sx;
      out[2 * i + 1] = sy;
    }
    return out;
  }

  /** Resample a closed contour to N points evenly spaced by arc length. */
  function resampleClosed(pts, N) {
    const n = pts.length >> 1;
    const xs = new Float64Array(N), ys = new Float64Array(N);
    if (n === 0) return { xs, ys };
    if (n === 1) { xs.fill(pts[0]); ys.fill(pts[1]); return { xs, ys }; }
    // cumulative lengths over the closed loop (n segments)
    const cum = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      cum[i + 1] = cum[i] + Math.hypot(pts[2 * j] - pts[2 * i], pts[2 * j + 1] - pts[2 * i + 1]);
    }
    const total = cum[n];
    if (total === 0) { xs.fill(pts[0]); ys.fill(pts[1]); return { xs, ys }; }
    let seg = 0;
    for (let s = 0; s < N; s++) {
      const target = (s / N) * total;
      while (seg < n - 1 && cum[seg + 1] < target) seg++;
      const segLen = cum[seg + 1] - cum[seg];
      const u = segLen > 0 ? (target - cum[seg]) / segLen : 0;
      const a = seg, b = (seg + 1) % n;
      xs[s] = pts[2 * a] + (pts[2 * b] - pts[2 * a]) * u;
      ys[s] = pts[2 * a + 1] + (pts[2 * b + 1] - pts[2 * a + 1]) * u;
    }
    return { xs, ys };
  }

  /**
   * Real DFT of one axis → coefficient vector in the exact order
   * [mean, 0, a1, b1, a2, b2, ..., aK, bK] padded with zeros to length P.
   *   a_k =  Re(F_k) * 2 / N   (cosine amplitude)
   *   b_k = -Im(F_k) * 2 / N   (sine amplitude)
   * so that  v(t) = mean + Σ a_k cos(2πkt) + b_k sin(2πkt),  t ∈ [0, 1).
   */
  const tables = new Map();
  function trigTable(N) {
    let t = tables.get(N);
    if (!t) {
      const c = new Float64Array(N), s = new Float64Array(N);
      for (let i = 0; i < N; i++) { c[i] = Math.cos((TAU * i) / N); s[i] = Math.sin((TAU * i) / N); }
      t = { c, s };
      tables.set(N, t);
    }
    return t;
  }

  function dftVector(v, K, P) {
    const N = v.length;
    const out = new Float64Array(P);
    const { c, s } = trigTable(N);
    let mean = 0;
    for (let i = 0; i < N; i++) mean += v[i];
    out[0] = mean / N;
    for (let k = 1; k <= K; k++) {
      let re = 0, im = 0;
      for (let i = 0, idx = 0; i < N; i++, idx = (idx + k) % N) {
        re += v[i] * c[idx];
        im -= v[i] * s[idx];
      }
      out[2 * k] = (re / N) * 2;
      out[2 * k + 1] = (-im / N) * 2;
    }
    return out;
  }

  /**
   * Full per-stroke pipeline: smooth → resample(512) → normalise → DFT → quantise.
   * pts: interleaved pixel coords. Returns quantised Int32Array vectors of length P.
   */
  function strokeCoefficients(pts, o) {
    const len = arcLength(pts);
    const P = 2 * (o.Kmax + 1);
    const K = Math.max(o.Kmin, Math.min(o.Kmax, Math.round(len / o.divisor)));
    const sm = o.smoothing > 0 ? smoothClosed(pts, o.smoothing) : pts;
    const { xs, ys } = resampleClosed(sm, o.samples || 512);
    const W = o.width, H = o.height;
    const yOff = o.centerY ? H / 2 : H;
    for (let i = 0; i < xs.length; i++) {
      xs[i] = (xs[i] / W) * 10 - 5;
      ys[i] = ((yOff - ys[i]) / W) * 10;
    }
    const fx = dftVector(xs, K, P), fy = dftVector(ys, K, P);
    const X = new Int32Array(P), Y = new Int32Array(P);
    for (let j = 0; j < P; j++) {
      X[j] = Math.round(fx[j] * o.scale);
      Y[j] = Math.round(fy[j] * o.scale);
    }
    return { K, X, Y, len };
  }

  /**
   * Evaluate a quantised coefficient vector exactly as Desmos will:
   *   (1/S) Σ_j c_j cos(2π floor(j/2) t − (π/2) mod(j,2))
   * Returns interleaved [x,y,...] in Desmos units for M samples over t∈[0,1].
   */
  function reconstruct(X, Y, K, scale, M) {
    const out = new Float64Array(2 * (M + 1));
    for (let s = 0; s <= M; s++) {
      const t = s / M;
      let x = X[0], y = Y[0];
      for (let k = 1; k <= K; k++) {
        const c = Math.cos(TAU * k * t), sn = Math.sin(TAU * k * t);
        x += X[2 * k] * c + X[2 * k + 1] * sn;
        y += Y[2 * k] * c + Y[2 * k + 1] * sn;
      }
      out[2 * s] = x / scale;
      out[2 * s + 1] = y / scale;
    }
    return out;
  }

  root.P2DFourier = { arcLength, bbox, smoothClosed, resampleClosed, dftVector, strokeCoefficients, reconstruct };
})(typeof self !== 'undefined' ? self : globalThis);
