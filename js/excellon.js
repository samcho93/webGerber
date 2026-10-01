// Excellon (NC drill) parser → same layer structure as the Gerber parser.

import { Bounds, PolarityBlocks } from './geom.js';

export function parseExcellon(text) {
  const st = {
    unit: 25.4,          // default inch
    zero: 'TZ',          // TZ = trailing zeros kept (leading suppressed)
    int: 2, dec: 4,
    fmtSet: false,
    tools: new Map(),
    tool: null,
    x: 0, y: 0,
    abs: true,
    route: false, down: false,
  };
  const bounds = new Bounds();
  const out = new PolarityBlocks();
  const blk = out.get(true);

  const lines = text.split(/\r?\n/);
  for (let raw of lines) {
    let line = raw.trim();
    if (!line) continue;

    if (line[0] === ';') {
      const m = /FILE_FORMAT\s*=\s*(\d+):(\d+)/i.exec(line);
      if (m) { st.int = +m[1]; st.dec = +m[2]; st.fmtSet = true; }
      continue;
    }
    line = line.replace(/\s+/g, '').toUpperCase();

    const um = /^(METRIC|INCH)(?:,(LZ|TZ))?(?:,(0+)\.(0+))?/.exec(line);
    if (um) {
      st.unit = um[1] === 'METRIC' ? 1 : 25.4;
      if (um[2]) st.zero = um[2];
      if (um[3]) { st.int = um[3].length; st.dec = um[4].length; st.fmtSet = true; }
      else if (!st.fmtSet) { st.int = um[1] === 'METRIC' ? 3 : 2; st.dec = um[1] === 'METRIC' ? 3 : 4; }
      continue;
    }
    if (line === 'M71') { st.unit = 1; if (!st.fmtSet) { st.int = 3; st.dec = 3; } continue; }
    if (line === 'M72') { st.unit = 25.4; if (!st.fmtSet) { st.int = 2; st.dec = 4; } continue; }
    if (line === 'G90') { st.abs = true; continue; }
    if (line === 'G91') { st.abs = false; continue; }
    if (line === 'M15') { st.down = true; continue; }
    if (line === 'M16' || line === 'M17') { st.down = false; continue; }
    if (line === 'M30' || line === 'M00') break;

    // tool definition: T1C0.8 / T01F00S00C0.0320
    const td = /^T(\d+)(?:[FSBHZN][-\d.]+)*C([\d.]+)/.exec(line);
    if (td) {
      st.tools.set(+td[1], parseFloat(td[2]) * st.unit);
      // KiCad etc. may combine definition with selection outside the header
      continue;
    }
    const ts = /^T(\d+)/.exec(line);
    if (ts) {
      st.tool = +ts[1];
      line = line.slice(ts[0].length);
      if (!line) continue;
    }

    if (/^G0?0/.test(line)) { st.route = true; st.down = false; }
    if (/^G0?1/.test(line)) { st.route = true; }
    if (/^G05/.test(line)) { st.route = false; }

    // slot: X..Y..G85X..Y..
    const slot = /^(.*)G85(.*)$/.exec(line);
    if (slot) {
      const [x0, y0] = coords(slot[1]);
      const [x1, y1] = coords(slot[2]);
      stroke(x0, y0, x1, y1);
      continue;
    }

    if (/[XY]/.test(line)) {
      const px = st.x, py = st.y;
      const [x, y] = coords(line);
      if (st.route) {
        if (st.down && /^G0?[123]/.test(line)) stroke(px, py, x, y);
      } else {
        hit(x, y);
      }
    }
  }

  return { blocks: out.blocks, bounds: bounds.value(), segments: null };

  function dia() { return st.tools.get(st.tool) || 0.5; }

  function hit(x, y) {
    const r = dia() / 2;
    blk.nz.moveTo(x + r, y);
    blk.nz.arc(x, y, r, 0, Math.PI * 2, false);
    blk.nz.closePath();
    bounds.add(x, y, r);
  }
  function stroke(x0, y0, x1, y1) {
    const w = dia();
    let p = blk.strokes.get(w);
    if (!p) { p = new Path2D(); blk.strokes.set(w, p); }
    p.moveTo(x0, y0); p.lineTo(x1, y1);
    bounds.add(x0, y0, w / 2); bounds.add(x1, y1, w / 2);
  }

  function coords(s) {
    const mx = /X([+-]?[\d.]+)/.exec(s);
    const my = /Y([+-]?[\d.]+)/.exec(s);
    let x = st.x, y = st.y;
    if (mx) x = st.abs ? num(mx[1]) : st.x + num(mx[1]);
    if (my) y = st.abs ? num(my[1]) : st.y + num(my[1]);
    st.x = x; st.y = y;
    return [x, y];
  }

  function num(str) {
    if (str.includes('.')) return parseFloat(str) * st.unit;
    let neg = false;
    if (str[0] === '-' || str[0] === '+') { neg = str[0] === '-'; str = str.slice(1); }
    let v;
    if (st.zero === 'LZ') {
      // leading zeros present, trailing suppressed → pad right
      while (str.length < st.int + st.dec) str += '0';
      v = parseInt(str, 10) / Math.pow(10, st.dec);
    } else {
      v = parseInt(str, 10) / Math.pow(10, st.dec);
    }
    return (neg ? -v : v) * st.unit;
  }
}
