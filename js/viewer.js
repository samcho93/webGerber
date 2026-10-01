// Canvas renderer; the TOP / BOTTOM panels of one viewer share pan/zoom.
(() => {
const { LAYER_TYPES } = WG;


const COL = {
  bg: '#14171c',
  mask: '#14612f',
  cuUnderMask: '#2c8443',
  finish: '#d8b158',
  substrate: '#a8955e',
  silk: '#f6f6f0',
  paste: '#c3c7ce',
  hole: '#14171c',
  outline: '#f2d33a',
};

class Viewer {
  constructor(root, { onCursor, onZoom } = {}) {
    this.root = root;
    this.onCursor = onCursor || (() => {});
    this.onZoom = onZoom || (() => {});
    this.layers = [];
    this.board = null;           // { path, bounds }
    this.bounds = null;
    this.mode = 'real';          // 'real' | 'layer'
    this.view = 'split';         // 'split' | 'top' | 'bottom'
    this.linked = true;          // TOP and BOTTOM share one view (pan/zoom/orientation)
    this.dpr = window.devicePixelRatio || 1;
    this.panels = {
      top: this.makePanel('top', false),
      bottom: this.makePanel('bottom', true),
    };
    // Each panel has a view { s: px per mm, cx, cy: world centre, fitScale, o: orientation }.
    // o is a 2×2 matrix [m11, m12, m21, m22] (rotation/flip, applied to world coords before
    // the bottom panel's mirror). While linked both panels point at the same object.
    const v = { s: 10, cx: 0, cy: 0, fitScale: 0, o: [1, 0, 0, 1] };
    this.panels.top.v = this.panels.bottom.v = v;
    this.focus = this.panels.top;   // panel last interacted with (zoom/rotate buttons, zoom label)
    this.off = [document.createElement('canvas'), document.createElement('canvas'), document.createElement('canvas')];
    this.pending = false;
    new ResizeObserver(() => { this.resize(); this.draw(); }).observe(root);
    window.matchMedia(`(resolution: ${this.dpr}dppx)`).addEventListener?.('change', () => {
      this.dpr = window.devicePixelRatio || 1; this.resize(); this.draw();
    });
    this.applyView();
  }

  // ---------- panels ----------
  makePanel(side, mirror) {
    const el = document.createElement('div');
    el.className = 'panel';
    el.innerHTML = `<canvas></canvas><div class="panel-label">${side === 'top' ? 'TOP' : 'BOTTOM'}${mirror ? ' <span>(mirrored)</span>' : ''}<em class="orient"></em></div>`;
    this.root.appendChild(el);
    const canvas = el.querySelector('canvas');
    const panel = { side, mirror, el, canvas, ctx: canvas.getContext('2d'), w: 0, h: 0, orientEl: el.querySelector('.orient') };
    this.bindInput(panel);
    return panel;
  }

  setView(v) { this.view = v; this.applyView(); }
  applyView() {
    this.panels.top.el.hidden = this.view === 'bottom';
    this.panels.bottom.el.hidden = this.view === 'top';
    this.root.dataset.view = this.view;
    if (this.focus.el.hidden) this.focus = this.visiblePanels()[0];
    this.resize();
    this.draw();
  }
  setMode(m) { this.mode = m; this.draw(); }

  // Link / unlink the TOP and BOTTOM views. Linking adopts the focused panel's view.
  setLinked(on) {
    if (on === this.linked) return;
    this.linked = on;
    const { top, bottom } = this.panels;
    if (on) top.v = bottom.v = this.focus.v;
    else bottom.v = { ...top.v, o: top.v.o.slice() };
    this.updateLabels();
    this.draw();
  }

  visiblePanels() { return Object.values(this.panels).filter(p => !p.el.hidden); }
  focused() { return this.focus.el.hidden ? this.visiblePanels()[0] : this.focus; }

  resize() {
    for (const p of Object.values(this.panels)) {
      const r = p.canvas.getBoundingClientRect();
      p.w = Math.max(1, r.width); p.h = Math.max(1, r.height);
      const W = Math.round(p.w * this.dpr), H = Math.round(p.h * this.dpr);
      if (p.canvas.width !== W || p.canvas.height !== H) { p.canvas.width = W; p.canvas.height = H; }
    }
  }

  // ---------- orientation ----------
  // Linear part world → screen (y up) for a panel: mirror (bottom) ∘ orientation.
  lin(panel) {
    const o = panel.v.o;
    return panel.mirror ? [-o[0], -o[1], o[2], o[3]] : o;
  }

  // Rotate / flip what the focused panel shows, as seen on screen.
  // op: 'cw' | 'ccw' | 'flipH' | 'flipV' | 'reset'
  orient(op) {
    const panel = this.focused();
    const v = panel.v;
    const atFit = v.fitScale && Math.abs(v.s - v.fitScale) < 1e-9 * v.s;
    if (op === 'reset') v.o = [1, 0, 0, 1];
    else {
      const T = { cw: [0, 1, -1, 0], ccw: [0, -1, 1, 0], flipH: [-1, 0, 0, 1], flipV: [1, 0, 0, -1] }[op];
      // screen op T on panel with mirror P:  P·o' = T·P·o  →  o' = P·T·P·o
      const P = panel.mirror ? [-1, 0, 0, 1] : [1, 0, 0, 1];
      v.o = mul(P, mul(T, mul(P, v.o)));
    }
    if (atFit) this.fit(this.linked ? undefined : panel);
    this.updateLabels();
    this.draw();
  }

  updateLabels() {
    for (const p of Object.values(this.panels)) {
      // on-screen change relative to the panel's default:  P·o·P
      const P = p.mirror ? [-1, 0, 0, 1] : [1, 0, 0, 1];
      const m = mul(P, mul(p.v.o, P));
      const flipped = m[0] * m[3] - m[1] * m[2] < 0;
      const r = flipped ? mul(m, [-1, 0, 0, 1]) : m;           // strip a horizontal flip
      const deg = (Math.round(-Math.atan2(r[2], r[0]) * 180 / Math.PI) + 360) % 360;
      const parts = [];
      if (flipped && deg === 180) parts.push('상하반전');
      else {
        if (deg) parts.push(`${deg}°`);
        if (flipped) parts.push('좌우반전');
      }
      p.orientEl.textContent = parts.length ? ' · ' + parts.join(' · ') : '';
    }
  }

  // ---------- data ----------
  setData(layers, board, bounds) {
    this.layers = layers;
    this.board = board;
    this.bounds = bounds;
    this.fit();
  }

  // Fit the board. Linked: one view sized for the smaller panel. Unlinked: the given
  // panel only, or every visible panel to its own size when none is given.
  fit(panel) {
    const b = this.board ? this.board.bounds : this.bounds;
    this.resize();
    if (!b || !isFinite(b.minX)) { this.draw(); return; }
    const bw = Math.max(b.maxX - b.minX, 1e-3), bh = Math.max(b.maxY - b.minY, 1e-3);
    const fitView = (v, w, h) => {
      const [a, c, d, e] = v.o;                           // on-screen extent after rotation
      const sw = Math.abs(a) * bw + Math.abs(c) * bh, sh = Math.abs(d) * bw + Math.abs(e) * bh;
      v.s = v.fitScale = Math.min(w / sw, h / sh) * 0.88;
      v.cx = (b.minX + b.maxX) / 2;
      v.cy = (b.minY + b.maxY) / 2;
    };
    const ps = this.visiblePanels();
    if (this.linked) fitView(ps[0].v, Math.min(...ps.map(p => p.w)), Math.min(...ps.map(p => p.h)));
    else for (const p of panel ? [panel] : ps) fitView(p.v, p.w, p.h);
    this.reportZoom();
    this.draw();
  }

  zoomBy(f, panel, sx, sy) {
    panel = panel || this.focused();
    const v = panel.v;
    if (sx == null) { sx = panel.w / 2; sy = panel.h / 2; }
    const [wx, wy] = this.toWorld(panel, sx, sy);
    const base = v.fitScale || v.s;
    v.s = Math.min(base * 2000, Math.max(base * 0.05, v.s * f));
    // keep the world point under the cursor fixed
    const [nx, ny] = this.toWorld(panel, sx, sy);
    v.cx += wx - nx;
    v.cy += wy - ny;
    this.reportZoom();
    this.draw();
  }

  reportZoom() {
    const v = this.focus.v;
    this.onZoom(v.s / (v.fitScale || v.s));
  }

  // Screen-space vector (px, y down) → world vector (mm), via the orthogonal inverse.
  screenToWorldVec(panel, dx, dy) {
    const A = this.lin(panel), s = panel.v.s;
    const u = dx / s, w = -dy / s;
    return [A[0] * u + A[2] * w, A[1] * u + A[3] * w];
  }

  toWorld(panel, sx, sy) {
    const [dx, dy] = this.screenToWorldVec(panel, sx - panel.w / 2, sy - panel.h / 2);
    return [panel.v.cx + dx, panel.v.cy + dy];
  }

  pan(panel, dx, dy) {
    const [wx, wy] = this.screenToWorldVec(panel, dx, dy);
    panel.v.cx -= wx;
    panel.v.cy -= wy;
  }

  // ---------- input ----------
  bindInput(panel) {
    const c = panel.canvas;
    const pts = new Map();
    let pinch = null;
    const focus = () => { if (this.focus !== panel) { this.focus = panel; this.reportZoom(); } };

    c.addEventListener('wheel', e => {
      e.preventDefault();
      focus();
      const r = c.getBoundingClientRect();
      const dy = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;
      this.zoomBy(Math.pow(1.0015, -dy), panel, e.clientX - r.left, e.clientY - r.top);
    }, { passive: false });

    c.addEventListener('pointerdown', e => {
      focus();
      try { c.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      c.classList.add('grabbing');
      if (pts.size === 2) {
        const [a, b] = [...pts.values()];
        pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
      }
    });
    c.addEventListener('pointermove', e => {
      const r = c.getBoundingClientRect();
      const [wx, wy] = this.toWorld(panel, e.clientX - r.left, e.clientY - r.top);
      this.onCursor(wx, wy);
      const prev = pts.get(e.pointerId);
      if (!prev) return;
      const cur = { x: e.clientX, y: e.clientY };
      pts.set(e.pointerId, cur);
      if (pts.size === 1) {
        this.pan(panel, cur.x - prev.x, cur.y - prev.y);
        this.draw();
      } else if (pts.size === 2 && pinch) {
        const [a, b] = [...pts.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
        this.pan(panel, mx - pinch.mx, my - pinch.my);
        this.zoomBy(d / (pinch.d || d), panel, mx - r.left, my - r.top);
        pinch = { d, mx, my };
      }
    });
    const up = e => {
      pts.delete(e.pointerId);
      if (pts.size < 2) pinch = null;
      if (!pts.size) c.classList.remove('grabbing');
    };
    c.addEventListener('pointerup', up);
    c.addEventListener('pointercancel', up);
    c.addEventListener('dblclick', () => { focus(); this.fit(panel); });
  }

  // ---------- rendering ----------
  draw() {
    if (this.pending) return;
    this.pending = true;
    requestAnimationFrame(() => {
      this.pending = false;
      for (const p of this.visiblePanels()) this.renderPanel(p);
    });
  }

  worldMatrix(panel) {
    const { s, cx, cy } = panel.v, d = this.dpr;
    const [a11, a12, a21, a22] = this.lin(panel);
    return [
      s * a11 * d, -s * a21 * d, s * a12 * d, -s * a22 * d,
      (panel.w / 2 - s * (a11 * cx + a12 * cy)) * d,
      (panel.h / 2 + s * (a21 * cx + a22 * cy)) * d,
    ];
  }

  prepOff(i, panel) {
    const c = this.off[i];
    if (c.width !== panel.canvas.width || c.height !== panel.canvas.height) {
      c.width = panel.canvas.width; c.height = panel.canvas.height;
    }
    const ctx = c.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.clearRect(0, 0, c.width, c.height);
    return ctx;
  }

  // Render one layer into offscreen i using a single colour.
  layerToOff(i, panel, layer, color) {
    const ctx = this.prepOff(i, panel);
    ctx.setTransform(...this.worldMatrix(panel));
    ctx.fillStyle = ctx.strokeStyle = color;
    ctx.lineCap = ctx.lineJoin = 'round';
    const minW = 1 / (panel.v.s * this.dpr) * 1.2;
    for (const b of layer.data.blocks) {
      ctx.globalCompositeOperation = b.dark ? 'source-over' : 'destination-out';
      ctx.fill(b.nz, 'nonzero');
      for (const [w, p] of b.strokes) {
        ctx.lineWidth = Math.max(w, minW);
        ctx.stroke(p);
      }
    }
    ctx.globalCompositeOperation = 'source-over';
    return this.off[i];
  }

  blit(ctx, src, alpha = 1, op = 'source-over') {
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = alpha;
    ctx.globalCompositeOperation = op;
    ctx.drawImage(src, 0, 0);
    ctx.restore();
  }

  sideLayers(panel) {
    return this.layers.filter(l => l.data && l.visible && sideMatches(l.type, panel.side));
  }
  find(panel, type) { return this.layers.find(l => l.data && l.type === `${panel.side}-${type}`); }

  renderPanel(panel) {
    const ctx = panel.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.fillStyle = COL.bg;
    ctx.fillRect(0, 0, panel.canvas.width, panel.canvas.height);
    if (!this.layers.length) return;
    if (this.mode === 'real') this.renderReal(panel, ctx);
    else this.renderLayers(panel, ctx);
  }

  boardClip(ctx, panel) {
    ctx.setTransform(...this.worldMatrix(panel));
    if (this.board) {
      ctx.clip(this.board.path, 'evenodd');
      return this.board.path;
    }
    const b = this.bounds;
    const p = new Path2D();
    if (b && isFinite(b.minX)) p.rect(b.minX, b.minY, b.maxX - b.minX, b.maxY - b.minY);
    ctx.clip(p);
    return p;
  }

  renderReal(panel, ctx) {
    const vis = t => { const l = this.find(panel, t); return l && l.visible ? l : null; };
    const copper = vis('copper'), mask = vis('mask'), silk = vis('silk'), paste = vis('paste');
    const maskExists = !!this.find(panel, 'mask');
    const masked = !!mask;

    ctx.save();
    const shape = this.boardClip(ctx, panel);
    ctx.fillStyle = (maskExists && !masked) ? COL.substrate : COL.mask;
    ctx.fill(shape, this.board ? 'evenodd' : 'nonzero');

    // inner layers (only if user enabled them) sit beneath the outer copper
    for (const l of this.layers) {
      if (l.data && l.visible && l.type === 'inner-copper') this.blit(ctx, this.layerToOff(0, panel, l, l.color), 0.55);
    }

    if (copper) this.blit(ctx, this.layerToOff(0, panel, copper, masked ? COL.cuUnderMask : COL.finish));

    if (masked) {
      const maskOff = this.layerToOff(1, panel, mask, COL.substrate);
      this.blit(ctx, maskOff);                       // openings expose the laminate
      if (copper) {
        const cu = this.layerToOff(0, panel, copper, COL.finish);
        this.blit(cu.getContext('2d'), maskOff, 1, 'destination-in');
        this.blit(ctx, cu);                          // exposed copper → finish
      }
    }
    if (paste) this.blit(ctx, this.layerToOff(0, panel, paste, COL.paste), 0.9);
    if (silk) {
      const s = this.layerToOff(0, panel, silk, COL.silk);
      if (masked) this.blit(s.getContext('2d'), this.off[1], 1, 'destination-out');
      this.blit(ctx, s);
    }
    for (const l of this.layers) {
      if (l.data && l.visible && l.type === 'other') this.blit(ctx, this.layerToOff(0, panel, l, l.color), 0.7);
    }
    for (const l of this.layers) {
      if (l.data && l.visible && l.type === 'drill') this.blit(ctx, this.layerToOff(0, panel, l, COL.hole));
    }
    ctx.restore();

    for (const l of this.layers) {
      if (l.data && l.visible && l.type === 'outline') this.blit(ctx, this.layerToOff(0, panel, l, COL.outline), 0.9);
    }
  }

  renderLayers(panel, ctx) {
    const list = this.sideLayers(panel).sort((a, b) => layerRank(a.type, panel.side) - layerRank(b.type, panel.side));
    for (const l of list) {
      const alpha = l.type.endsWith('mask') ? 0.45 : l.type === 'drill' ? 1 : 0.85;
      this.blit(ctx, this.layerToOff(0, panel, l, l.color), alpha);
    }
  }
}

// 2×2 matrix product, matrices as [m11, m12, m21, m22]
function mul(a, b) {
  return [a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3], a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3]];
}

function sideMatches(type, side) {
  const t = LAYER_TYPES[type];
  if (!t) return false;
  return t.side === side || t.side === 'all' || t.side === 'inner';
}

const RANK = ['inner-copper', 'copper', 'mask', 'paste', 'silk', 'other', 'drill', 'outline'];
function layerRank(type, side) {
  const k = type.startsWith(side + '-') ? type.slice(side.length + 1) : type;
  const i = RANK.indexOf(k);
  return i < 0 ? 99 : i;
}

Object.assign(WG, { Viewer });
})();
