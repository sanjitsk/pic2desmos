// config.js — the one file you'd normally edit.

/**
 * Desmos API key. This is the public demo key from the Desmos API docs and is
 * fine for development. For a public site, request your own free key at
 * https://www.desmos.com/api and paste it here.
 */
export const DESMOS_API_KEY = 'dcb31709b452b1cf9dc26972add0fda6';
export const DESMOS_API_URL = `https://www.desmos.com/api/v1.9/calculator.js?apiKey=${DESMOS_API_KEY}`;

/** OpenCV.js build (pinned). ~10 MB, loaded inside the Web Worker. */
export const OPENCV_URL = 'https://cdn.jsdelivr.net/npm/@techstark/opencv-js@4.10.0-release.1/dist/opencv.js';

/** Desmos hard limit on list length. Applies to the X list and the Y list separately. */
export const DESMOS_LIST_LIMIT = 10000;

/** Character counts that trigger UI warnings. */
export const WARN_CHARS = 60000;

/** Longest side of the in-memory "original" (crop + mask work at this size). */
export const SOURCE_MAX = 2000;

/** Resolution presets (Section 4 of the spec). */
export const PRESETS = {
  low:    { maxDim: 600,  cannyLow: 30, cannyHigh: 80, minLength: 70, Kmax: 8,  harmonicDivisor: 45, scale: 100 },
  medium: { maxDim: 800,  cannyLow: 18, cannyHigh: 50, minLength: 45, Kmax: 12, harmonicDivisor: 30, scale: 100 },
  high:   { maxDim: 1000, cannyLow: 10, cannyHigh: 32, minLength: 28, Kmax: 18, harmonicDivisor: 20, scale: 100 },
  max:    { maxDim: 1200, cannyLow: 8,  cannyHigh: 25, minLength: 20, Kmax: 24, harmonicDivisor: 15, scale: 100 },
};

/** Everything the pipeline needs. Presets overwrite a subset of these. */
export const DEFAULTS = {
  preset: 'high',
  mode: 'edges',          // 'edges' | 'silhouette' | 'color'
  ...PRESETS.high,
  blur: 5,                // Gaussian kernel (1 = off)
  Kmin: 3,
  maxStrokes: 2000,       // user cap; the 10,000-element list limit also applies
  lineWidth: 1,
  smoothing: 0,           // Gaussian sigma (points) applied to contours before the DFT
  simplify: 0,            // drop strokes whose bounding box is smaller than this (px)
  invertSilhouette: false,
  invertEdges: false,     // edge-preview display only
  colorK: 4,
  skipBackground: true,
  centerY: false,         // y = (h/2 − py) instead of (h − py)
  showOriginal: false,
  autoVerify: true,
};

export const SAMPLES = [
  { file: 'assets/samples/astronaut.jpg', label: 'Astronaut portrait', preset: 'high', mode: 'edges' },
  { file: 'assets/samples/cat.jpg', label: 'Cat', preset: 'medium', mode: 'edges' },
  { file: 'assets/samples/coffee.jpg', label: 'Coffee cup', preset: 'medium', mode: 'edges' },
  { file: 'assets/samples/logo.svg', label: 'Logo (silhouette)', preset: 'high', mode: 'silhouette' },
];
