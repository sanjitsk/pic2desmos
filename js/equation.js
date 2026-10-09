// equation.js — builds the Desmos LaTeX (format tested in desmos.com/calculator).

/**
 * One equation for all strokes.
 *   (1/S) ( Σ_j X[P·[0…n−1]+j+1]·C ,  Σ_j Y[P·[0…n−1]+j+1]·C )
 *   C = cos(2π·floor(j/2)·t − (π/2)·mod(j,2))
 * `[0...n-1]` broadcasts into n separate parametric curves (no connecting lines).
 * NOTE: the \cdot before \left[0...n-1\right] is required — without it Desmos
 * reads "44[0...91]" as indexing the number 44.
 */
export function buildEquation(Xflat, Yflat, n, Kmax, SCALE = 100) {
  const P = 2 * (Kmax + 1);
  const C = String.raw`\cos\left(2\pi\operatorname{floor}\left(\frac{j}{2}\right)t-\frac{\pi}{2}\operatorname{mod}\left(j,2\right)\right)`;
  const idx = String.raw`\left[${P}\cdot\left[0...${n - 1}\right]+j+1\right]`;
  const sum = (L) => String.raw`\sum_{j=0}^{${P - 1}}\left[${L.join(',')}\right]${idx}${C}`;
  return String.raw`\frac{1}{${SCALE}}\left(${sum(Xflat)},${sum(Yflat)}\right)`;
}

/** Flatten a list of strokes (each with Int32Array X, Y of length P) into joined lists. */
export function flatten(strokes, P) {
  const X = new Array(strokes.length * P), Y = new Array(strokes.length * P);
  strokes.forEach((s, i) => {
    for (let j = 0; j < P; j++) { X[i * P + j] = s.X[j]; Y[i * P + j] = s.Y[j]; }
  });
  return { X, Y };
}

/** Equation for one layer of strokes, or '' when empty. */
export function layerEquation(strokes, Kmax, scale) {
  if (!strokes.length) return '';
  const P = 2 * (Kmax + 1);
  const { X, Y } = flatten(strokes, P);
  return buildEquation(X, Y, strokes.length, Kmax, scale);
}

/** Explicit trig series for one axis of one stroke, e.g. 123+45\cos(2\pi t)-6\sin(2\pi t). */
function series(v, K) {
  let out = String(v[0]);
  for (let k = 1; k <= K; k++) {
    const arg = k === 1 ? String.raw`2\pi t` : String.raw`${2 * k}\pi t`;
    for (const [c, fn] of [[v[2 * k], 'cos'], [v[2 * k + 1], 'sin']]) {
      if (!c) continue;
      out += (c < 0 ? '-' : '+') + (Math.abs(c) === 1 ? '' : Math.abs(c)) + '\\' + fn + '\\left(' + arg + '\\right)';
    }
  }
  return out;
}

/** "Advanced: multi-expression mode" — one parametric equation per stroke (0 ≤ t ≤ 1). */
export function multiExpression(strokes, scale) {
  return strokes
    .map((s) => String.raw`\left(\frac{${series(s.X, s.K)}}{${scale}},\frac{${series(s.Y, s.K)}}{${scale}}\right)`)
    .join('\n');
}
