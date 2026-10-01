// Layer type detection and board outline construction.

export const LAYER_TYPES = {
  'top-silk':      { label: 'Top Silkscreen',    side: 'top',    order: 10, color: '#f5f5f0' },
  'top-paste':     { label: 'Top Paste',         side: 'top',    order: 11, color: '#b8bcc4' },
  'top-mask':      { label: 'Top Solder Mask',   side: 'top',    order: 12, color: '#1e8a46' },
  'top-copper':    { label: 'Top Copper',        side: 'top',    order: 13, color: '#e0a040' },
  'inner-copper':  { label: 'Inner Copper',      side: 'inner',  order: 20, color: '#d06bd0' },
  'bottom-copper': { label: 'Bottom Copper',     side: 'bottom', order: 30, color: '#4f9be8' },
  'bottom-mask':   { label: 'Bottom Solder Mask',side: 'bottom', order: 31, color: '#1e8a46' },
  'bottom-paste':  { label: 'Bottom Paste',      side: 'bottom', order: 32, color: '#b8bcc4' },
  'bottom-silk':   { label: 'Bottom Silkscreen', side: 'bottom', order: 33, color: '#f5f5f0' },
  'outline':       { label: 'Board Outline',     side: 'all',    order: 40, color: '#f2d33a' },
  'drill':         { label: 'Drill',             side: 'all',    order: 41, color: '#9aa4b2' },
  'other':         { label: 'Other',             side: 'all',    order: 50, color: '#5ad1c8' },
};

const INNER_COLORS = ['#d06bd0', '#e86b6b', '#6bd0a0', '#c0c050', '#8a7be8', '#e8a06b'];

const EXT_MAP = {
  gtl: 'top-copper', cmp: 'top-copper', top: 'top-copper',
  gbl: 'bottom-copper', sol: 'bottom-copper', bot: 'bottom-copper',
  gts: 'top-mask', stc: 'top-mask', smt: 'top-mask', tsm: 'top-mask',
  gbs: 'bottom-mask', sts: 'bottom-mask', smb: 'bottom-mask', bsm: 'bottom-mask',
  gto: 'top-silk', plc: 'top-silk', sst: 'top-silk', tsk: 'top-silk',
  gbo: 'bottom-silk', pls: 'bottom-silk', ssb: 'bottom-silk', bsk: 'bottom-silk',
  gtp: 'top-paste', crc: 'top-paste', spt: 'top-paste', tsp: 'top-paste',
  gbp: 'bottom-paste', crs: 'bottom-paste', spb: 'bottom-paste', bsp: 'bottom-paste',
  gko: 'outline', gm1: 'outline', gml: 'outline', gm: 'outline', dim: 'outline',
  oln: 'outline', out: 'outline', bor: 'outline', fab: 'outline',
  drl: 'drill', xln: 'drill', drd: 'drill', exc: 'drill', tap: 'drill', nc: 'drill', ncd: 'drill',
};

// Returns 'gerber' | 'drill' | null
export function detectFormat(name, text) {
  const head = text.slice(0, 4000);
  if (/^\s*(;[^\n]*\n\s*)*M48/m.test(head) && !/%FS/.test(head)) return 'drill';
  if (/%FS[LTD]?[AI]?/.test(head) || /%MO(MM|IN)/.test(head) || /%ADD\d+/.test(text.slice(0, 50000))) return 'gerber';
  if (/(^|\n)\s*T\d+C[\d.]+/.test(head) && /(^|\n)\s*X[-\d.]+Y[-\d.]+/.test(text)) return 'drill';
  return null;
}

export function detectType(name, text, format) {
  if (format === 'drill') return 'drill';

  // Gerber X2 file function (also as G04 #@! comment)
  const ff = /TF\.FileFunction,([^*%\n]+)/.exec(text.slice(0, 20000));
  if (ff) {
    const f = ff[1].split(',');
    const kind = f[0].toLowerCase();
    const side = (f.find(s => /^(Top|Bot|Inr)$/i.test(s)) || '').toLowerCase();
    if (kind === 'copper') return side === 'top' ? 'top-copper' : side === 'bot' ? 'bottom-copper' : 'inner-copper';
    if (kind === 'soldermask') return side === 'bot' ? 'bottom-mask' : 'top-mask';
    if (kind === 'legend') return side === 'bot' ? 'bottom-silk' : 'top-silk';
    if (kind === 'paste') return side === 'bot' ? 'bottom-paste' : 'top-paste';
    if (kind === 'profile') return 'outline';
    if (kind === 'plated' || kind === 'nonplated') return 'drill';
  }

  const base = name.split('/').pop().toLowerCase();
  const ext = base.includes('.') ? base.split('.').pop() : '';
  const stem = base.replace(/\.[^.]+$/, '');

  // KiCad / name-based
  const n = stem.replace(/[\s_.\-]+/g, '_');
  const has = re => re.test(n);
  if (has(/(^|_)(edge_cuts|outline|board_outline|profile|edge|border)(_|$)/) || has(/boardoutline/)) return 'outline';
  if (has(/(^|_)in\d+_cu(_|$)/) || has(/inner/)) return 'inner-copper';
  const top = has(/(^|_)(f|top|front)(_|$)/) || has(/(^|_)top(layer|silk|solder|paste|overlay|mask|copper)/);
  const bot = has(/(^|_)(b|bot|bottom|back)(_|$)/) || has(/(^|_)bottom(layer|silk|solder|paste|overlay|mask|copper)/);
  const sideOf = t => (top ? 'top-' : 'bottom-') + t;
  if (top !== bot) {
    if (has(/silk|legend|overlay/)) return sideOf('silk');
    if (has(/paste|cream|stencil/)) return sideOf('paste');
    if (has(/mask|solder|resist/)) return sideOf('mask');
    if (has(/cu|copper|layer|signal/)) return sideOf('copper');
  }

  if (EXT_MAP[ext]) return EXT_MAP[ext];
  if (/^g\d+$/.test(ext) || /^gp\d+$/.test(ext) || /^g\d+l$/.test(ext) || /^ly\d+$/.test(ext)) return 'inner-copper';
  if (/^gm\d+$/.test(ext)) return 'other';
  return 'other';
}

export function innerColor(index) { return INNER_COLORS[index % INNER_COLORS.length]; }

// ---------- board outline ----------
// Chains the outline layer's draw segments into closed loops.
export function buildBoardShape(segments) {
  if (!segments || !segments.length) return null;
  const tol = 0.05;
  const segs = segments.filter(s => s.length >= 4).map(s => ({ p: s, used: false }));
  const loops = [];
  const near = (ax, ay, bx, by) => Math.abs(ax - bx) < tol && Math.abs(ay - by) < tol;

  for (const s of segs) {
    if (s.used) continue;
    s.used = true;
    let chain = s.p.slice();
    let closed = near(chain[0], chain[1], chain[chain.length - 2], chain[chain.length - 1]) && chain.length > 4;
    let grew = true;
    while (!closed && grew) {
      grew = false;
      const ex = chain[chain.length - 2], ey = chain[chain.length - 1];
      for (const t of segs) {
        if (t.used) continue;
        const p = t.p, L = p.length;
        if (near(ex, ey, p[0], p[1])) {
          for (let k = 2; k < L; k++) chain.push(p[k]);
        } else if (near(ex, ey, p[L - 2], p[L - 1])) {
          for (let k = L - 4; k >= 0; k -= 2) chain.push(p[k], p[k + 1]);
        } else continue;
        t.used = true; grew = true;
        break;
      }
      if (near(chain[0], chain[1], chain[chain.length - 2], chain[chain.length - 1])) closed = true;
    }
    if (closed && chain.length >= 8) loops.push(chain);
  }
  if (!loops.length) return null;

  const path = new Path2D();
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const l of loops) {
    path.moveTo(l[0], l[1]);
    for (let k = 2; k < l.length; k += 2) path.lineTo(l[k], l[k + 1]);
    path.closePath();
    for (let k = 0; k < l.length; k += 2) {
      minX = Math.min(minX, l[k]); maxX = Math.max(maxX, l[k]);
      minY = Math.min(minY, l[k + 1]); maxY = Math.max(maxY, l[k + 1]);
    }
  }
  return { path, bounds: { minX, minY, maxX, maxY } };
}
