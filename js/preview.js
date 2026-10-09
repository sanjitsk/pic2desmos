// preview.js — canvas reconstruction (exactly what Desmos computes) + Desmos embed.

const F = globalThis.P2DFourier;

/** Picture bounds in Desmos units. */
export function pictureBounds(width, height, centerY) {
  const H = (10 * height) / width;
  const bottom = centerY ? -H / 2 : 0;
  return { left: -5, right: 5, bottom, top: bottom + H };
}

export class SketchPreview {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.items = [];      // [{ layer, index, color, pts: Float32Array (canvas px) }]
    this.hover = null;
    this.data = null;
  }

  /**
   * data: { layers: [{ color, strokes: [{X,Y,K,...}] }], width, height, scale, centerY,
   *         lineWidth, original: CanvasImageSource|null, showOriginal, dark }
   */
  set(data) { this.data = data; this.draw(); }

  resize() {
    if (!this.data) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cssW = this.canvas.clientWidth || 600;
    const cssH = (cssW * this.data.height) / this.data.width;
    this.canvas.style.height = cssH + 'px';
    this.canvas.width = Math.round(cssW * dpr);
    this.canvas.height = Math.round(cssH * dpr);
    this.dpr = dpr;
  }

  draw() {
    const d = this.data;
    if (!d) return;
    this.resize();
    const { ctx, canvas } = this;
    const b = pictureBounds(d.width, d.height, d.centerY);
    const sx = canvas.width / (b.right - b.left), sy = canvas.height / (b.top - b.bottom);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = d.dark ? '#14161b' : '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (d.showOriginal && d.original) {
      ctx.globalAlpha = 0.3;
      ctx.drawImage(d.original, 0, 0, canvas.width, canvas.height);
      ctx.globalAlpha = 1;
    }
    this.items = [];
    d.layers.forEach((layer, li) => {
      layer.strokes.forEach((s, si) => {
        const M = Math.max(64, Math.min(600, 16 * s.K));
        const p = F.reconstruct(s.X, s.Y, s.K, d.scale, M);
        const pts = new Float32Array(p.length);
        for (let i = 0; i < p.length; i += 2) {
          pts[i] = (p[i] - b.left) * sx;
          pts[i + 1] = (b.top - p[i + 1]) * sy;
        }
        this.items.push({ layer: li, index: si, color: layer.color, pts });
      });
    });
    const lw = Math.max(0.75, d.lineWidth) * this.dpr;
    for (const it of this.items) {
      const isHover = this.hover && this.hover.layer === it.layer && this.hover.index === it.index;
      let col = it.color;
      if (d.dark && /^#0{6}$/i.test(col)) col = '#e8eaf0';
      ctx.strokeStyle = isHover ? '#e5484d' : col;
      ctx.lineWidth = isHover ? lw * 2.5 : lw;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(it.pts[0], it.pts[1]);
      for (let i = 2; i < it.pts.length; i += 2) ctx.lineTo(it.pts[i], it.pts[i + 1]);
      ctx.stroke();
    }
  }

  /** Nearest stroke to a client point, within `tol` CSS px. */
  hitTest(clientX, clientY, tol = 8) {
    const r = this.canvas.getBoundingClientRect();
    const x = (clientX - r.left) * this.dpr, y = (clientY - r.top) * this.dpr;
    const t = tol * this.dpr;
    let best = null, bd = t * t;
    for (const it of this.items) {
      const p = it.pts;
      for (let i = 0; i < p.length - 2; i += 2) {
        const ax = p[i], ay = p[i + 1], bx = p[i + 2], by = p[i + 3];
        const dx = bx - ax, dy = by - ay;
        const L = dx * dx + dy * dy;
        let u = L ? ((x - ax) * dx + (y - ay) * dy) / L : 0;
        u = u < 0 ? 0 : u > 1 ? 1 : u;
        const ex = ax + u * dx - x, ey = ay + u * dy - y;
        const dd = ex * ex + ey * ey;
        if (dd < bd) { bd = dd; best = it; }
      }
    }
    return best ? { layer: best.layer, index: best.index } : null;
  }

  setHover(h) {
    const same = (a, b) => (a && b ? a.layer === b.layer && a.index === b.index : a === b);
    if (same(h, this.hover)) return;
    this.hover = h;
    this.draw();
  }
}

/* ---------------- Desmos embed ---------------- */

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    s.onload = resolve;
    s.onerror = () => reject(new Error('Could not load the Desmos API'));
    document.head.appendChild(s);
  });
}

export class DesmosPreview {
  constructor(el, apiUrl) {
    this.el = el;
    this.apiUrl = apiUrl;
    this.calc = null;
    this.loading = null;
    this.token = 0;
  }

  async ensure() {
    if (this.calc) return this.calc;
    if (!this.loading) {
      this.loading = (window.Desmos ? Promise.resolve() : loadScript(this.apiUrl)).then(() => {
        this.calc = window.Desmos.GraphingCalculator(this.el, {
          expressions: false, keypad: false, settingsMenu: false, zoomButtons: true,
          showGrid: false, showXAxis: false, showYAxis: false, border: false,
        });
        return this.calc;
      });
      this.loading.catch(() => { this.loading = null; });
    }
    return this.loading;
  }

  resize() { if (this.calc) this.calc.resize(); }

  setDark(dark) {
    if (this.calc && this.calc.updateSettings) {
      try { this.calc.updateSettings({ invertedColors: !!dark }); } catch (_) { /* older API */ }
    }
  }

  /**
   * items: [{ id, latex, color }]. Draws them and waits for Desmos's own analysis.
   * Resolves { ok, errors: [{id, message}], stale } — stale=true if superseded.
   */
  async verify(items, bounds, lineWidth = 1, timeoutMs = 25000) {
    const my = ++this.token;
    const calc = await this.ensure();
    if (my !== this.token) return { stale: true };
    calc.removeExpressions(calc.getExpressions());
    calc.updateSettings({ showGrid: false, showXAxis: false, showYAxis: false });
    for (const it of items) {
      calc.setExpression({ id: it.id, latex: it.latex, color: it.color, lineWidth });
    }
    // expand bounds to the element's aspect ratio so the picture isn't stretched
    const W = this.el.clientWidth || 1, H = this.el.clientHeight || 1;
    const bw = bounds.right - bounds.left, bh = bounds.top - bounds.bottom;
    const pad = 0.04;
    let left = bounds.left - bw * pad, right = bounds.right + bw * pad;
    let bottom = bounds.bottom - bh * pad, top = bounds.top + bh * pad;
    const want = (right - left) / (top - bottom), have = W / H;
    if (have > want) { const extra = ((top - bottom) * have - (right - left)) / 2; left -= extra; right += extra; }
    else { const extra = ((right - left) / have - (top - bottom)) / 2; bottom -= extra; top += extra; }
    calc.setMathBounds({ left, right, bottom, top });

    const t0 = performance.now();
    while (performance.now() - t0 < timeoutMs) {
      await new Promise((r) => setTimeout(r, 200));
      if (my !== this.token) return { stale: true };
      const a = calc.expressionAnalysis || {};
      if (items.every((it) => a[it.id])) {
        const errors = [];
        for (const it of items) {
          const r = a[it.id];
          if (r.isError || !r.isGraphable) errors.push({ id: it.id, message: r.errorMessage || 'Not graphable' });
        }
        return { ok: errors.length === 0, errors };
      }
    }
    return { ok: false, errors: [{ id: '', message: 'Desmos did not finish analysing in time' }] };
  }
}
