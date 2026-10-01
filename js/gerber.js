// RS-274X (Gerber) parser → canvas-ready geometry.
// All output coordinates are in millimetres.
//
// Output layer:
//   blocks   : [{ dark, nz: Path2D, strokes: Map<width, Path2D> }]  (drawn in order)
//   bounds   : { minX, minY, maxX, maxY }
//   segments : [[x,y,x,y,...]] draw polylines (only when opts.keepSegments)
//
// Every solid shape is wound counter-clockwise (positive area) and every hole
// clockwise, so one nonzero Path2D per block is a correct union.

import { Bounds, PolarityBlocks, arcPoints, polyArea } from './geom.js';

const TAU = Math.PI * 2;

export function parseGerber(text, opts = {}) {
  const st = {
    fmt: { zero: 'L', int: 3, dec: 6 },
    unit: 1,                 // mm per file unit
    apertures: new Map(),
    macros: new Map(),
    cur: null,               // current aperture
    x: 0, y: 0,
    interp: 1,               // 1 linear, 2 cw, 3 ccw
    quadrant: 'multi',
    region: false,
    contour: null,
    contours: [],
    dark: true,
    lastD: 2,
    sr: null,
  };
  const bounds = new Bounds();
  const out = new PolarityBlocks();
  const segments = opts.keepSegments ? [] : null;
  let curSeg = null;

  // ---------- tokenizer ----------
  const tokens = tokenize(text);

  for (const tk of tokens) {
    if (tk.ext) handleExtended(tk.body);
    else if (handleWord(tk.body) === 'end') break;
  }
  finishSR();

  return { blocks: out.blocks, bounds: bounds.value(), segments };

  // ---------- coordinate helpers ----------
  function num(str) {
    if (str == null) return null;
    if (str.includes('.')) return parseFloat(str) * st.unit;
    let neg = false;
    if (str[0] === '-' || str[0] === '+') { neg = str[0] === '-'; str = str.slice(1); }
    const { zero, int, dec } = st.fmt;
    if (zero === 'T') {
      while (str.length < int + dec) str += '0';
    }
    const v = parseInt(str, 10) / Math.pow(10, dec);
    return (neg ? -v : v) * st.unit;
  }

  // ---------- extended (%...%) commands ----------
  function handleExtended(body) {
    // body: commands separated by '*', may contain several (e.g. AM)
    const parts = body.split('*').filter(s => s.length);
    if (!parts.length) return;
    const head = parts[0];
    const code = head.slice(0, 2);

    switch (code) {
      case 'FS': {
        const m = /^FS([LTD]?)([AI]?).*?X(\d)(\d)Y(\d)(\d)/.exec(head);
        if (m) st.fmt = { zero: m[1] === 'T' ? 'T' : 'L', int: +m[3], dec: +m[4] };
        break;
      }
      case 'MO':
        st.unit = head.startsWith('MOIN') ? 25.4 : 1;
        break;
      case 'AD':
        for (const p of parts) defineAperture(p);
        break;
      case 'AM': {
        const name = head.slice(2);
        st.macros.set(name, parts.slice(1));
        break;
      }
      case 'LP':
        st.dark = head[2] !== 'C';
        break;
      case 'SR': {
        finishSR();
        const m = /X(\d+)Y(\d+)I([\d.]+)J([\d.]+)/.exec(head);
        if (m && (+m[1] > 1 || +m[2] > 1)) {
          st.sr = {
            nx: +m[1], ny: +m[2],
            dx: parseFloat(m[3]) * st.unit, dy: parseFloat(m[4]) * st.unit,
            start: out.blocks.length,
          };
          out.forceNew();
        }
        break;
      }
      default:
        // IP, LN, TF, TA, TO, TD, OF, SF, MI, IR, AS, LM, LR, LS, AB … ignored
        // Some generators put ordinary word commands inside %...%
        if (/^(G\d|D\d|X|Y|M0)/.test(head)) for (const p of parts) handleWord(p);
    }
  }

  function defineAperture(p) {
    const m = /^ADD(\d+)([^,]+)(?:,(.*))?$/.exec(p);
    if (!m) return;
    const code = +m[1];
    const tpl = m[2];
    const params = m[3] ? m[3].split('X').map(parseFloat) : [];
    const u = st.unit;
    let shape;
    switch (tpl) {
      case 'C': shape = stdCircle(params[0] * u, holeOf(params, 1)); break;
      case 'R': shape = stdRect(params[0] * u, params[1] * u, holeOf(params, 2)); break;
      case 'O': shape = stdObround(params[0] * u, params[1] * u, holeOf(params, 2)); break;
      case 'P': shape = stdPolygon(params[0] * u, params[1], params[2] || 0, holeOf(params, 3)); break;
      default: {
        const macro = st.macros.get(tpl);
        shape = macro ? buildMacro(macro, params, u) : stdCircle(0, 0);
      }
    }
    st.apertures.set(code, shape);
  }
  function holeOf(params, i) { return params[i] ? params[i] * st.unit : 0; }

  // ---------- word commands ----------
  function handleWord(w) {
    if (!w) return;
    if (w.startsWith('G04') || w.startsWith('G4 ')) return;
    if (w === 'M02' || w === 'M00' || w === 'M2' || w === 'M0') return 'end';

    let rest = w;
    // G codes (there may be one at the start)
    const g = /^G0*(\d+)/.exec(rest);
    if (g) {
      const gc = +g[1];
      rest = rest.slice(g[0].length);
      switch (gc) {
        case 1: case 2: case 3: st.interp = gc; break;
        case 74: st.quadrant = 'single'; break;
        case 75: st.quadrant = 'multi'; break;
        case 36: beginRegion(); break;
        case 37: endRegion(); break;
        case 70: st.unit = 25.4; break;
        case 71: st.unit = 1; break;
        case 54: case 55: break; // tool prepare (deprecated) – D follows
        default: break;
      }
      if (!rest) return;
    }

    const coords = {};
    const re = /([XYIJ])([+-]?[\d.]+)/g;
    let m, any = false;
    while ((m = re.exec(rest))) { coords[m[1]] = m[2]; any = true; }

    // embedded G code after coords (e.g. "X..Y..G02" is rare) – check again
    const g2 = /G0*([123])(?!\d)/.exec(rest);
    if (g2) st.interp = +g2[1];

    const d = /D0*(\d+)/.exec(rest);
    let dc = d ? +d[1] : null;

    if (dc != null && dc >= 10) {
      st.cur = st.apertures.get(dc) || null;
      return;
    }
    if (dc == null) {
      if (!any) return;
      dc = st.lastD; // deprecated modal operation
    }
    st.lastD = dc;

    const nx = coords.X != null ? num(coords.X) : st.x;
    const ny = coords.Y != null ? num(coords.Y) : st.y;
    const ci = coords.I != null ? num(coords.I) : 0;
    const cj = coords.J != null ? num(coords.J) : 0;

    if (dc === 1) interpolate(st.x, st.y, nx, ny, ci, cj);
    else if (dc === 2) move(nx, ny);
    else if (dc === 3) flash(nx, ny);
    st.x = nx; st.y = ny;
  }

  // ---------- operations ----------
  function move(nx, ny) {
    if (st.region) {
      closeContour();
      st.contour = [nx, ny];
    }
    curSeg = null;
  }

  function flash(x, y) {
    curSeg = null;
    const ap = st.cur;
    if (!ap) return;
    const mtx = new DOMMatrix([1, 0, 0, 1, x, y]);
    for (const part of ap.parts) {
      const blk = out.get(part.dark ? st.dark : !st.dark);
      blk.nz.addPath(part.path, mtx);
    }
    bounds.add(x, y, ap.ext);
  }

  function interpolate(x0, y0, x1, y1, i, j) {
    let pts; // polyline for region / segments
    let arc = null;
    if (st.interp === 1) {
      pts = [x0, y0, x1, y1];
    } else {
      arc = solveArc(x0, y0, x1, y1, i, j);
      pts = arc ? arcPoints(arc.cx, arc.cy, arc.r, arc.a0, arc.a1, arc.ccw) : [x0, y0, x1, y1];
    }

    if (st.region) {
      if (!st.contour) st.contour = [x0, y0];
      for (let k = 2; k < pts.length; k++) st.contour.push(pts[k]);
      return;
    }

    if (segments) {
      if (!curSeg) { curSeg = [pts[0], pts[1]]; segments.push(curSeg); }
      for (let k = 2; k < pts.length; k++) curSeg.push(pts[k]);
    }

    const ap = st.cur;
    if (!ap) return;
    const blk = out.get(st.dark);

    if (ap.type === 'C' || (ap.type !== 'R') || arc) {
      const w = ap.type === 'C' ? ap.w : ap.minDim;
      let p = blk.strokes.get(w);
      if (!p) { p = new Path2D(); blk.strokes.set(w, p); }
      p.moveTo(x0, y0);
      if (arc) {
        if (arc.full) { p.arc(arc.cx, arc.cy, arc.r, arc.a0, arc.a0 + (arc.ccw ? TAU : -TAU), !arc.ccw); }
        else p.arc(arc.cx, arc.cy, arc.r, arc.a0, arc.a1, !arc.ccw);
      } else p.lineTo(x1, y1);
      for (let k = 0; k < pts.length; k += 2) bounds.add(pts[k], pts[k + 1], w / 2);
    } else {
      // rectangular aperture swept along a line → convex hull of both rectangles
      const hw = ap.w / 2, hh = ap.h / 2;
      const hull = convexHull([
        x0 - hw, y0 - hh, x0 + hw, y0 - hh, x0 + hw, y0 + hh, x0 - hw, y0 + hh,
        x1 - hw, y1 - hh, x1 + hw, y1 - hh, x1 + hw, y1 + hh, x1 - hw, y1 + hh,
      ]);
      addPoly(blk.nz, hull);
      bounds.add(x0, y0, ap.ext); bounds.add(x1, y1, ap.ext);
    }
  }

  function solveArc(x0, y0, x1, y1, i, j) {
    const ccw = st.interp === 3;
    let cx, cy;
    if (st.quadrant === 'multi') {
      cx = x0 + i; cy = y0 + j;
    } else {
      // single quadrant: signs unknown, pick the best candidate with sweep ≤ 90°
      let best = null;
      for (const sx of [1, -1]) for (const sy of [1, -1]) {
        const ccx = x0 + sx * Math.abs(i), ccy = y0 + sy * Math.abs(j);
        const r0 = Math.hypot(x0 - ccx, y0 - ccy), r1 = Math.hypot(x1 - ccx, y1 - ccy);
        const sweep = sweepOf(Math.atan2(y0 - ccy, x0 - ccx), Math.atan2(y1 - ccy, x1 - ccx), ccw);
        if (sweep > Math.PI / 2 + 1e-6) continue;
        const err = Math.abs(r0 - r1);
        if (!best || err < best.err) best = { err, ccx, ccy };
      }
      if (!best) return null;
      cx = best.ccx; cy = best.ccy;
    }
    const r = Math.hypot(x0 - cx, y0 - cy);
    if (r < 1e-9) return null;
    const a0 = Math.atan2(y0 - cy, x0 - cx);
    const a1 = Math.atan2(y1 - cy, x1 - cx);
    const same = Math.abs(x0 - x1) < 1e-9 && Math.abs(y0 - y1) < 1e-9;
    const full = same && st.quadrant === 'multi';
    if (same && !full) return null;
    return { cx, cy, r, a0, a1: full ? a0 + (ccw ? TAU : -TAU) : a1, ccw, full };
  }

  // ---------- regions ----------
  function beginRegion() { st.region = true; st.contour = null; st.contours = []; curSeg = null; }
  function closeContour() {
    if (st.contour && st.contour.length >= 6) st.contours.push(st.contour);
    st.contour = null;
  }
  function endRegion() {
    closeContour();
    st.region = false;
    if (!st.contours.length) return;
    const blk = out.get(st.dark);
    for (const c of st.contours) {
      addPoly(blk.nz, c);
      for (let k = 0; k < c.length; k += 2) bounds.add(c[k], c[k + 1], 0);
    }
    st.contours = [];
  }

  // ---------- step & repeat ----------
  function finishSR() {
    const sr = st.sr;
    if (!sr) return;
    st.sr = null;
    const blocks = out.blocks.slice(sr.start);
    const b0 = bounds.value();
    for (const blk of blocks) {
      const nz = new Path2D();
      const strokes = new Map();
      for (let ix = 0; ix < sr.nx; ix++) for (let iy = 0; iy < sr.ny; iy++) {
        const m = new DOMMatrix([1, 0, 0, 1, ix * sr.dx, iy * sr.dy]);
        nz.addPath(blk.nz, m);
        for (const [w, p] of blk.strokes) {
          let q = strokes.get(w);
          if (!q) { q = new Path2D(); strokes.set(w, q); }
          q.addPath(p, m);
        }
      }
      blk.nz = nz; blk.strokes = strokes;
    }
    if (isFinite(b0.minX)) {
      bounds.add(b0.maxX + (sr.nx - 1) * sr.dx, b0.maxY + (sr.ny - 1) * sr.dy, 0);
    }
    out.forceNew();
  }
}

// ---------- tokenizer ----------
function tokenize(text) {
  const tokens = [];
  const n = text.length;
  let i = 0;
  while (i < n) {
    const c = text[i];
    if (c === '%') {
      const end = text.indexOf('%', i + 1);
      const body = text.slice(i + 1, end < 0 ? n : end).replace(/\s+/g, '');
      tokens.push({ ext: true, body });
      i = end < 0 ? n : end + 1;
    } else if (c === '\n' || c === '\r' || c === ' ' || c === '\t') {
      i++;
    } else {
      const end = text.indexOf('*', i);
      const raw = text.slice(i, end < 0 ? n : end);
      const body = raw.startsWith('G04') ? 'G04' : raw.replace(/\s+/g, '');
      tokens.push({ ext: false, body });
      i = end < 0 ? n : end + 1;
    }
  }
  return tokens;
}

// ---------- standard apertures (built at origin) ----------
function circlePath(p, x, y, r, hole) {
  if (r <= 0) return;
  p.moveTo(x + r, y);
  if (hole) p.arc(x, y, r, TAU, 0, true);
  else p.arc(x, y, r, 0, TAU, false);
  p.closePath();
}

function stdCircle(d, hole) {
  const path = new Path2D();
  circlePath(path, 0, 0, d / 2, false);
  if (hole) circlePath(path, 0, 0, hole / 2, true);
  return { type: 'C', w: d, minDim: d, ext: d / 2, parts: [{ dark: true, path }] };
}

function stdRect(w, h, hole) {
  const path = new Path2D();
  addPoly(path, [-w / 2, -h / 2, w / 2, -h / 2, w / 2, h / 2, -w / 2, h / 2]);
  if (hole) circlePath(path, 0, 0, hole / 2, true);
  return { type: 'R', w, h, minDim: Math.min(w, h), ext: Math.hypot(w, h) / 2, parts: [{ dark: true, path }] };
}

function stdObround(w, h, hole) {
  const path = new Path2D();
  if (Math.abs(w - h) < 1e-9) circlePath(path, 0, 0, w / 2, false);
  else if (w > h) {
    const r = h / 2, dx = w / 2 - r;
    path.moveTo(dx, -r);
    path.arc(dx, 0, r, -Math.PI / 2, Math.PI / 2, false);
    path.lineTo(-dx, r);
    path.arc(-dx, 0, r, Math.PI / 2, Math.PI * 1.5, false);
    path.closePath();
  } else {
    const r = w / 2, dy = h / 2 - r;
    path.moveTo(r, dy);
    path.arc(0, dy, r, 0, Math.PI, false);
    path.lineTo(-r, -dy);
    path.arc(0, -dy, r, Math.PI, TAU, false);
    path.closePath();
  }
  if (hole) circlePath(path, 0, 0, hole / 2, true);
  return { type: 'O', w, h, minDim: Math.min(w, h), ext: Math.max(w, h) / 2, parts: [{ dark: true, path }] };
}

function stdPolygon(d, n, rot, hole) {
  n = Math.max(3, Math.round(n || 3));
  const pts = [];
  for (let k = 0; k < n; k++) {
    const a = (rot * Math.PI) / 180 + (TAU * k) / n;
    pts.push((d / 2) * Math.cos(a), (d / 2) * Math.sin(a));
  }
  const path = new Path2D();
  addPoly(path, pts);
  if (hole) circlePath(path, 0, 0, hole / 2, true);
  return { type: 'P', w: d, minDim: d, ext: d / 2, parts: [{ dark: true, path }] };
}

// ---------- aperture macros ----------
function buildMacro(lines, params, u) {
  const vars = {};
  params.forEach((v, k) => { vars[k + 1] = v; });
  const parts = []; // {dark, polys: [[...]]}
  let ext = 0;

  const ev = s => evalExpr(s, vars);
  const push = (dark, polys) => {
    const last = parts[parts.length - 1];
    if (last && last.dark === dark) last.polys.push(...polys);
    else parts.push({ dark, polys: [...polys] });
    for (const p of polys) for (let k = 0; k < p.length; k += 2) ext = Math.max(ext, Math.hypot(p[k], p[k + 1]));
  };

  for (const raw of lines) {
    if (!raw) continue;
    if (raw[0] === '0') continue; // comment
    if (raw[0] === '$') {
      const m = /^\$(\d+)=(.*)$/.exec(raw);
      if (m) vars[+m[1]] = ev(m[2]);
      continue;
    }
    const f = raw.split(',');
    const code = parseInt(f[0], 10);
    const a = f.slice(1).map(ev);
    const on = a[0] !== 0;
    let polys = [];
    switch (code) {
      case 1: { // circle: exp, dia, cx, cy, rot
        const [, dia, cx = 0, cy = 0, rot = 0] = a;
        const [x, y] = rotPt(cx * u, cy * u, rot);
        polys = [circlePoly(x, y, (dia * u) / 2)];
        break;
      }
      case 2: case 20: { // vector line: exp, w, x1, y1, x2, y2, rot
        const [, w, x1, y1, x2, y2, rot = 0] = a;
        const dx = x2 - x1, dy = y2 - y1, L = Math.hypot(dx, dy) || 1;
        const nx = (-dy / L) * w / 2, ny = (dx / L) * w / 2;
        polys = [rotPoly([
          (x1 - nx) * u, (y1 - ny) * u, (x2 - nx) * u, (y2 - ny) * u,
          (x2 + nx) * u, (y2 + ny) * u, (x1 + nx) * u, (y1 + ny) * u,
        ], rot)];
        break;
      }
      case 21: { // center line: exp, w, h, cx, cy, rot
        const [, w, h, cx, cy, rot = 0] = a;
        polys = [rotPoly(rectPts((cx - w / 2) * u, (cy - h / 2) * u, w * u, h * u), rot)];
        break;
      }
      case 22: { // lower-left line: exp, w, h, x, y, rot
        const [, w, h, x, y, rot = 0] = a;
        polys = [rotPoly(rectPts(x * u, y * u, w * u, h * u), rot)];
        break;
      }
      case 4: { // outline: exp, n, x0, y0, ..., rot
        const n = a[1];
        const pts = [];
        for (let k = 0; k <= n; k++) pts.push(a[2 + k * 2] * u, a[3 + k * 2] * u);
        const rot = a[2 + (n + 1) * 2] || 0;
        polys = [rotPoly(pts, rot)];
        break;
      }
      case 5: { // polygon: exp, n, cx, cy, dia, rot
        const [, n, cx, cy, dia, rot = 0] = a;
        const pts = [];
        for (let k = 0; k < n; k++) {
          const ang = (TAU * k) / n;
          pts.push(cx * u + (dia * u / 2) * Math.cos(ang), cy * u + (dia * u / 2) * Math.sin(ang));
        }
        polys = [rotPoly(pts, rot)];
        break;
      }
      case 6: { // moiré: cx, cy, outer, thick, gap, maxRings, crossThick, crossLen, rot
        const [cx, cy, od, th, gap, nr, ct, cl, rot = 0] = a;
        let r = od / 2;
        for (let k = 0; k < nr && r > 0; k++) {
          polys.push(circlePoly(cx * u, cy * u, r * u));
          const ri = r - th;
          if (ri > 0) polys.push(circlePoly(cx * u, cy * u, ri * u).reverseFlat());
          r = ri - gap;
        }
        polys.push(rectPts((cx - cl / 2) * u, (cy - ct / 2) * u, cl * u, ct * u));
        polys.push(rectPts((cx - ct / 2) * u, (cy - cl / 2) * u, ct * u, cl * u));
        polys = polys.map(p => rotPoly(p, rot));
        push(true, polys);
        continue;
      }
      case 7: { // thermal: cx, cy, outer, inner, gap, rot
        const [cx, cy, od, id, gap, rot = 0] = a;
        polys = thermalPolys(od / 2 * u, id / 2 * u, gap / 2 * u).map(p => {
          for (let k = 0; k < p.length; k += 2) { p[k] += cx * u; p[k + 1] += cy * u; }
          return rotPoly(p, rot);
        });
        push(true, polys);
        continue;
      }
      default: continue;
    }
    push(on, polys);
  }

  const out = parts.map(pt => {
    const path = new Path2D();
    for (const p of pt.polys) addPoly(path, p, true);
    return { dark: pt.dark, path };
  });
  return { type: 'M', w: ext * 2, minDim: ext * 2, ext, parts: out };
}

function thermalPolys(R, r, g) {
  const polys = [];
  if (g >= R) return polys;
  const aO0 = Math.asin(Math.min(1, g / R)), aO1 = Math.PI / 2 - aO0;
  for (let q = 0; q < 4; q++) {
    const base = (q * Math.PI) / 2;
    const pts = arcPoints(0, 0, R, base + aO0, base + aO1, true);
    if (g < r) {
      const aI0 = Math.asin(g / r), aI1 = Math.PI / 2 - aI0;
      pts.push(...arcPoints(0, 0, r, base + aI1, base + aI0, false));
    } else {
      const c = Math.cos(base), s = Math.sin(base);
      pts.push(g * c - g * s, g * s + g * c);
    }
    polys.push(pts);
  }
  return polys;
}

// ---------- small geometry helpers ----------
function circlePoly(x, y, r) {
  const pts = arcPoints(x, y, r, 0, TAU, true);
  pts.length -= 2;
  pts.reverseFlat = function () { return reverseFlat(this); };
  return pts;
}
function reverseFlat(p) {
  const o = [];
  for (let k = p.length - 2; k >= 0; k -= 2) o.push(p[k], p[k + 1]);
  return o;
}
function rectPts(x, y, w, h) { return [x, y, x + w, y, x + w, y + h, x, y + h]; }
function rotPt(x, y, deg) {
  if (!deg) return [x, y];
  const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  return [x * c - y * s, x * s + y * c];
}
function rotPoly(p, deg) {
  if (!deg) return p;
  const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  const o = new Array(p.length);
  for (let k = 0; k < p.length; k += 2) { o[k] = p[k] * c - p[k + 1] * s; o[k + 1] = p[k] * s + p[k + 1] * c; }
  return o;
}

// Add a closed polygon. Orientation is normalised to CCW unless keepWinding.
export function addPoly(path, p, keepWinding = false) {
  if (p.length < 6) return;
  if (!keepWinding && polyArea(p) < 0) p = reverseFlat(p);
  path.moveTo(p[0], p[1]);
  for (let k = 2; k < p.length; k += 2) path.lineTo(p[k], p[k + 1]);
  path.closePath();
}

function convexHull(flat) {
  const pts = [];
  for (let k = 0; k < flat.length; k += 2) pts.push([flat[k], flat[k + 1]]);
  pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [], upper = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  for (let k = pts.length - 1; k >= 0; k--) {
    const p = pts[k];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  const hull = lower.slice(0, -1).concat(upper.slice(0, -1));
  return hull.flat();
}

function sweepOf(a0, a1, ccw) {
  let s = ccw ? a1 - a0 : a0 - a1;
  while (s < 0) s += TAU;
  return s;
}

// ---------- macro arithmetic ----------
function evalExpr(src, vars) {
  const s = src.replace(/X/g, 'x');
  let i = 0;
  const peek = () => s[i];
  function expr() {
    let v = term();
    while (peek() === '+' || peek() === '-') { const op = s[i++]; const r = term(); v = op === '+' ? v + r : v - r; }
    return v;
  }
  function term() {
    let v = factor();
    while (peek() === 'x' || peek() === '/') { const op = s[i++]; const r = factor(); v = op === 'x' ? v * r : v / r; }
    return v;
  }
  function factor() {
    const c = peek();
    if (c === '-') { i++; return -factor(); }
    if (c === '+') { i++; return factor(); }
    if (c === '(') { i++; const v = expr(); if (peek() === ')') i++; return v; }
    if (c === '$') {
      i++;
      const m = /^\d+/.exec(s.slice(i));
      i += m ? m[0].length : 0;
      return m ? (vars[+m[0]] || 0) : 0;
    }
    const m = /^[\d.]+(?:e[+-]?\d+)?/i.exec(s.slice(i));
    if (m) { i += m[0].length; return parseFloat(m[0]); }
    i++;
    return 0;
  }
  const v = expr();
  return isFinite(v) ? v : 0;
}
