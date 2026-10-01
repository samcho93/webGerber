// Shared geometry helpers.

const TAU = Math.PI * 2;

export class Bounds {
  constructor() { this.minX = this.minY = Infinity; this.maxX = this.maxY = -Infinity; }
  add(x, y, pad = 0) {
    if (x - pad < this.minX) this.minX = x - pad;
    if (y - pad < this.minY) this.minY = y - pad;
    if (x + pad > this.maxX) this.maxX = x + pad;
    if (y + pad > this.maxY) this.maxY = y + pad;
  }
  value() { return { minX: this.minX, minY: this.minY, maxX: this.maxX, maxY: this.maxY }; }
}

export function unionBounds(list) {
  const b = new Bounds();
  for (const v of list) {
    if (!v || !isFinite(v.minX)) continue;
    b.add(v.minX, v.minY); b.add(v.maxX, v.maxY);
  }
  return b.value();
}

// Sequence of polarity blocks. Consecutive shapes of the same polarity share a block.
export class PolarityBlocks {
  constructor() { this.blocks = []; this.fresh = false; }
  get(dark) {
    const last = this.blocks[this.blocks.length - 1];
    if (last && last.dark === dark && !this.fresh) return last;
    this.fresh = false;
    const b = { dark, nz: new Path2D(), strokes: new Map() };
    this.blocks.push(b);
    return b;
  }
  forceNew() { this.fresh = true; }
}

// Tessellate an arc into a flat [x,y,...] list (start and end included).
export function arcPoints(cx, cy, r, a0, a1, ccw) {
  let s = ccw ? a1 - a0 : a0 - a1;
  if (s < -1e-12) s += TAU * Math.ceil(-s / TAU);
  const n = Math.max(2, Math.ceil((s / TAU) * 72 * Math.min(4, Math.max(1, Math.sqrt(r)))));
  const out = [];
  for (let k = 0; k <= n; k++) {
    const a = a0 + (ccw ? 1 : -1) * (s * k) / n;
    out.push(cx + r * Math.cos(a), cy + r * Math.sin(a));
  }
  return out;
}

export function polyArea(p) {
  let a = 0;
  const n = p.length;
  for (let k = 0; k < n; k += 2) {
    const j = (k + 2) % n;
    a += p[k] * p[j + 1] - p[j] * p[k + 1];
  }
  return a / 2;
}
