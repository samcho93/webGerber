// Canvas renderer with synced pan/zoom across TOP / BOTTOM panels.

import { LAYER_TYPES } from './layers.js';

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

export class Viewer {
  constructor(root, { onCursor, onZoom } = {}) {
    this.root = root;
    this.onCursor = onCursor || (() => {});
    this.onZoom = onZoom || (() => {});
    this.layers = [];
    this.board = null;           // { path, bounds }
    this.bounds = null;
    this.mode = 'real';          // 'real' | 'layer'
    this.view = 'split';         // 'split' | 'top' | 'bottom'
    this.s = 10; this.cx = 0; this.cy = 0;
    this.dpr = window.devicePixelRatio || 1;
    this.panels = {
      top: this.makePanel('top', false),
      bottom: this.makePanel('bottom', true),
    };
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
    el.innerHTML = `<canvas></canvas><div class="panel-label">${side === 'top' ? 'TOP' : 'BOTTOM'}${mirror ? ' <span>(mirrored)</span>' : ''}</div>`;
    this.root.appendChild(el);
    const canvas = el.querySelector('canvas');
    const panel = { side, mirror, el, canvas, ctx: canvas.getContext('2d'), w: 0, h: 0 };
    this.bindInput(panel);
    return panel;
  }

  setView(v) { this.view = v; this.applyView(); }
  applyView() {
    this.panels.top.el.hidden = this.view === 'bottom';
    this.panels.bottom.el.hidden = this.view === 'top';
    this.root.dataset.view = this.view;
    this.resize();
    this.draw();
  }
  setMode(m) { this.mode = m; this.draw(); }

  visiblePanels() { return Object.values(this.panels).filter(p => !p.el.hidden); }

  resize() {
    for (const p of Object.values(this.panels)) {
      const r = p.canvas.getBoundingClientRect();
      p.w = Math.max(1, r.width); p.h = Math.max(1, r.height);
      const W = Math.round(p.w * this.dpr), H = Math.round(p.h * this.dpr);
      if (p.canvas.width !== W || p.canvas.height !== H) { p.canvas.width = W; p.canvas.height = H; }
    }
  }

  // ---------- data ----------
  setData(layers, board, bounds) {
    this.layers = layers;
    this.board = board;
    this.bounds = bounds;
    this.fit();
  }

  fit() {
    const b = this.board ? this.board.bounds : this.bounds;
    this.resize();
    if (!b || !isFinite(b.minX)) { this.draw(); return; }
    const ps = this.visiblePanels();
    const w = Math.min(...ps.map(p => p.w)), h = Math.min(...ps.map(p => p.h));
    const bw = Math.max(b.maxX - b.minX, 1e-3), bh = Math.max(b.maxY - b.minY, 1e-3);
    this.s = Math.min(w / bw, h / bh) * 0.88;
    this.cx = (b.minX + b.maxX) / 2;
    this.cy = (b.minY + b.maxY) / 2;
    this.fitScale = this.s;
    this.onZoom(1);
    this.draw();
  }

  zoomBy(f, panel, sx, sy) {
    panel = panel || this.visiblePanels()[0];
    if (sx == null) { sx = panel.w / 2; sy = panel.h / 2; }
    const m = panel.mirror ? -1 : 1;
    const wx = this.cx + (sx - panel.w / 2) / (this.s * m);
    const wy = this.cy - (sy - panel.h / 2) / this.s;
    const base = this.fitScale || this.s;
    this.s = Math.min(base * 2000, Math.max(base * 0.05, this.s * f));
    this.cx = wx - (sx - panel.w / 2) / (this.s * m);
    this.cy = wy + (sy - panel.h / 2) / this.s;
    this.onZoom(this.s / base);
    this.draw();
  }

  toWorld(panel, sx, sy) {
    const m = panel.mirror ? -1 : 1;
    return [this.cx + (sx - panel.w / 2) / (this.s * m), this.cy - (sy - panel.h / 2) / this.s];
  }

  // ---------- input ----------
  bindInput(panel) {
    const c = panel.canvas;
    const pts = new Map();
    let pinch = null;

    c.addEventListener('wheel', e => {
      e.preventDefault();
      const r = c.getBoundingClientRect();
      const dy = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;
      this.zoomBy(Math.pow(1.0015, -dy), panel, e.clientX - r.left, e.clientY - r.top);
    }, { passive: false });

    c.addEventListener('pointerdown', e => {
      c.setPointerCapture(e.pointerId);
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
      const m = panel.mirror ? -1 : 1;
      if (pts.size === 1) {
        this.cx -= (cur.x - prev.x) / (this.s * m);
        this.cy += (cur.y - prev.y) / this.s;
        this.draw();
      } else if (pts.size === 2 && pinch) {
        const [a, b] = [...pts.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
        this.cx -= (mx - pinch.mx) / (this.s * m);
        this.cy += (my - pinch.my) / this.s;
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
    c.addEventListener('dblclick', () => this.fit());
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
    const d = this.dpr, s = this.s, m = panel.mirror ? -1 : 1;
    return [s * m * d, 0, 0, -s * d, (panel.w / 2 - this.cx * s * m) * d, (panel.h / 2 + this.cy * s) * d];
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
    const minW = 1 / (this.s * this.dpr) * 1.2;
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
