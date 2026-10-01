// Generates a small 2-layer demo board (KiCad-style file names) into sample/src.
// Usage: node tools/make-sample.mjs   (then zip sample/src → sample/sample-board.zip)
import { mkdirSync, writeFileSync } from 'node:fs';

const OUT = new URL('../sample/src/', import.meta.url);
mkdirSync(OUT, { recursive: true });

const W = 60, H = 40, R = 3;
const c = v => Math.round(v * 1e6);
const xy = (x, y) => `X${c(x)}Y${c(y)}`;

function gerber(func, body) {
  return [
    `%TF.FileFunction,${func}*%`,
    '%FSLAX46Y46*%', '%MOMM*%', 'G04 webGerber sample board*',
    '%LPD*%', 'G01*', 'G75*',
    ...body, 'M02*', '',
  ].join('\n');
}

// ---------- geometry ----------
const soic = []; // [x, y]
for (const side of [-1, 1]) for (const dy of [-1.905, -0.635, 0.635, 1.905]) soic.push([30 + side * 2.7, 22 + dy * -side]);
const header = [];
for (let r = 0; r < 4; r++) for (let col = 0; col < 2; col++) header.push([8 + col * 2.54, 12 + r * 2.54]);
const mounts = [[4, 4], [W - 4, 4], [4, H - 4], [W - 4, H - 4]];
const vias = [[20, 10], [22, 30], [38, 12], [40, 32], [50, 18], [14, 28]];
const r0805 = [[44.05, 28], [45.95, 28]];
const c0805 = [[44.05, 20], [45.95, 20]];

// ---------- stroke font (4 × 6 grid) ----------
const GL = {
  W: [[0, 6, 1, 0, 2, 4, 3, 0, 4, 6]], E: [[4, 6, 0, 6, 0, 0, 4, 0], [0, 3, 3, 3]],
  B: [[0, 0, 0, 6, 3, 6, 4, 5, 4, 4, 3, 3, 0, 3], [3, 3, 4, 2, 4, 1, 3, 0, 0, 0]],
  G: [[4, 5, 3, 6, 1, 6, 0, 5, 0, 1, 1, 0, 3, 0, 4, 1, 4, 3, 2, 3]],
  R: [[0, 0, 0, 6, 3, 6, 4, 5, 4, 4, 3, 3, 0, 3], [2, 3, 4, 0]],
  V: [[0, 6, 2, 0, 4, 6]], 1: [[1, 5, 2, 6, 2, 0], [1, 0, 3, 0]],
  '.': [[2, 0, 2, 0.3]], 0: [[1, 0, 3, 0, 4, 1, 4, 5, 3, 6, 1, 6, 0, 5, 0, 1, 1, 0], [0, 1, 4, 5]],
  U: [[0, 6, 0, 1, 1, 0, 3, 0, 4, 1, 4, 6]], J: [[1, 6, 4, 6], [3, 6, 3, 1, 2, 0, 1, 0, 0, 1]],
  C: [[4, 5, 3, 6, 1, 6, 0, 5, 0, 1, 1, 0, 3, 0, 4, 1]],
  O: [[1, 0, 3, 0, 4, 1, 4, 5, 3, 6, 1, 6, 0, 5, 0, 1, 1, 0]],
  T: [[0, 6, 4, 6], [2, 6, 2, 0]], M: [[0, 0, 0, 6, 2, 3, 4, 6, 4, 0]],
  ' ': [],
};
function text(str, x, y, h, mirror = false) {
  const k = h / 6, adv = 5.5 * k;
  const out = [];
  [...str].forEach((ch, i) => {
    for (const pl of GL[ch] || []) {
      const pts = [];
      for (let j = 0; j < pl.length; j += 2) {
        let px = x + i * adv + pl[j] * k;
        if (mirror) px = 2 * x - px;
        pts.push([px, y + pl[j + 1] * k]);
      }
      out.push(pts);
    }
  });
  return out;
}
const poly = pts => pts.map((p, i) => xy(p[0], p[1]) + (i ? 'D01*' : 'D02*'));

// ---------- copper ----------
const topCu = gerber('Copper,L1,Top', [
  '%ADD10C,0.250000*%', '%ADD11R,1.500000X0.600000*%', '%ADD12C,1.700000*%', '%ADD13R,1.700000X1.700000*%',
  '%ADD14C,0.600000*%', '%ADD15C,6.000000*%', '%ADD16C,0.500000*%',
  '%AMRoundRect*0 rounded rectangle $1=radius*21,1,$2,$3-$1-$1,0,0,0*21,1,$2-$1-$1,$3,0,0,0*1,1,$1+$1,($2/2)-$1,($3/2)-$1*1,1,$1+$1,-($2/2)+$1,($3/2)-$1*1,1,$1+$1,($2/2)-$1,-($3/2)+$1*1,1,$1+$1,-($2/2)+$1,-($3/2)+$1*%',
  '%ADD17RoundRect,0.250000X1.000000X1.300000*%',
  '%AMTHERM*7,0,0,2.4,1.6,0.4,45*%', '%ADD18THERM*%',
  'D11*', ...soic.map(p => xy(...p) + 'D03*'),
  'D13*', xy(...header[0]) + 'D03*',
  'D12*', ...header.slice(1).map(p => xy(...p) + 'D03*'),
  'D14*', ...vias.map(p => xy(...p) + 'D03*'),
  'D15*', ...mounts.map(p => xy(...p) + 'D03*'),
  'D17*', ...r0805.concat(c0805).map(p => xy(...p) + 'D03*'),
  'D18*', xy(50, 10) + 'D03*',
  // traces
  'D10*',
  ...poly([[27.3, 23.905], [24, 23.905], [22, 25.905], [12, 25.905], [10.54, 19.62]]),
  ...poly([[27.3, 22.635], [23.5, 22.635], [21, 20.135], [13, 20.135], [10.54, 17.08]]),
  ...poly([[27.3, 21.365], [22.5, 21.365], [20, 18.865], [12.5, 15.5], [10.54, 14.54]]),
  ...poly([[27.3, 20.095], [25, 20.095], [20, 10]]),
  ...poly([[32.7, 20.095], [36, 20.095], [38, 12]]),
  ...poly([[32.7, 21.365], [40, 21.365], [44.05, 20]]),
  ...poly([[32.7, 22.635], [38, 22.635], [44.05, 28]]),
  ...poly([[32.7, 23.905], [34, 26], [40, 32]]),
  'D16*',
  ...poly([[45.95, 20], [50, 18]]),
  // arc trace: quarter circle from (45.95,28) around (50,28)
  xy(45.95, 28) + 'D02*', 'G02*', `${xy(50, 32.05)}I${c(4.05)}J0D01*`, 'G01*',
  ...poly([[50, 32.05], [56, 32.05]]),
]);

const pour = [[1, 1], [W - 1, 1], [W - 1, H - 1], [1, H - 1]];
const thtAll = header.concat(vias);
const botCu = gerber('Copper,L2,Bot', [
  '%ADD10C,0.400000*%', '%ADD12C,1.700000*%', '%ADD13R,1.700000X1.700000*%', '%ADD14C,0.600000*%',
  '%ADD20C,2.400000*%', '%ADD21C,1.400000*%', '%ADD22C,6.800000*%', '%ADD23C,6.000000*%',
  'G36*', ...poly(pour), xy(...pour[0]) + 'D01*', 'G37*',
  '%LPC*%',
  'D20*', ...header.map(p => xy(...p) + 'D03*'),
  'D21*', ...vias.map(p => xy(...p) + 'D03*'),
  'D22*', ...mounts.map(p => xy(...p) + 'D03*'),
  'G36*', ...poly([[24, 4], [36, 4], [36, 9], [24, 9]]), xy(24, 4) + 'D01*', 'G37*',
  '%LPD*%',
  'D13*', xy(...header[0]) + 'D03*',
  'D12*', ...header.slice(1).map(p => xy(...p) + 'D03*'),
  'D14*', ...vias.map(p => xy(...p) + 'D03*'),
  'D23*', ...mounts.map(p => xy(...p) + 'D03*'),
  'D10*', ...poly([[25, 6.5], [35, 6.5]]),
]);

// ---------- solder mask ----------
const topMask = gerber('Soldermask,Top', [
  '%ADD11R,1.600000X0.700000*%', '%ADD12C,1.800000*%', '%ADD13R,1.800000X1.800000*%', '%ADD15C,6.100000*%',
  '%ADD17R,1.100000X1.400000*%', '%ADD18C,2.500000*%',
  'D11*', ...soic.map(p => xy(...p) + 'D03*'),
  'D13*', xy(...header[0]) + 'D03*',
  'D12*', ...header.slice(1).map(p => xy(...p) + 'D03*'),
  'D15*', ...mounts.map(p => xy(...p) + 'D03*'),
  'D17*', ...r0805.concat(c0805).map(p => xy(...p) + 'D03*'),
  'D18*', xy(50, 10) + 'D03*',
]);
const botMask = gerber('Soldermask,Bot', [
  '%ADD12C,1.800000*%', '%ADD13R,1.800000X1.800000*%', '%ADD15C,6.100000*%',
  'D13*', xy(...header[0]) + 'D03*',
  'D12*', ...header.slice(1).map(p => xy(...p) + 'D03*'),
  'D15*', ...mounts.map(p => xy(...p) + 'D03*'),
]);

// ---------- silkscreen ----------
const strokes = list => list.flatMap(poly);
const topSilk = gerber('Legend,Top', [
  '%ADD30C,0.150000*%', '%ADD31C,0.200000*%', '%ADD32C,0.400000*%',
  'D30*',
  ...poly([[28.2, 19.5], [31.8, 19.5], [31.8, 24.5], [28.2, 24.5], [28.2, 19.5]]),
  ...poly([[6.6, 10.6], [11.9, 10.6], [11.9, 21.0], [6.6, 21.0], [6.6, 10.6]]),
  ...poly([[43.2, 27.1], [46.8, 27.1], [46.8, 28.9], [43.2, 28.9], [43.2, 27.1]]),
  ...poly([[43.2, 19.1], [46.8, 19.1], [46.8, 20.9], [43.2, 20.9], [43.2, 19.1]]),
  'D32*', xy(26.6, 25.3) + 'D03*',
  'D31*',
  ...strokes(text('U1', 28.6, 25.6, 1.2)),
  ...strokes(text('J1', 7.6, 21.6, 1.2)),
  ...strokes(text('R1', 44, 29.6, 1)),
  ...strokes(text('C1', 44, 21.6, 1)),
  ...strokes(text('WEBGERBER', 17, 34, 2.2)),
  ...strokes(text('V1.0', 46, 4, 1.4)),
]);
const botSilk = gerber('Legend,Bot', [
  '%ADD31C,0.200000*%',
  'D31*',
  ...strokes(text('BOTTOM', 42, 33, 2.2, true)),
  ...strokes(text('J1', 13.2, 21.6, 1.2, true)),
]);

// ---------- paste ----------
const topPaste = gerber('Paste,Top', [
  '%ADD11R,1.500000X0.600000*%', '%ADD17R,1.000000X1.300000*%',
  'D11*', ...soic.map(p => xy(...p) + 'D03*'),
  'D17*', ...r0805.concat(c0805).map(p => xy(...p) + 'D03*'),
]);

// ---------- outline (rounded rectangle with arcs) ----------
const edge = gerber('Profile,NP', [
  '%ADD40C,0.100000*%', 'D40*',
  xy(R, 0) + 'D02*',
  xy(W - R, 0) + 'D01*', 'G03*', `${xy(W, R)}I0J${c(R)}D01*`, 'G01*',
  xy(W, H - R) + 'D01*', 'G03*', `${xy(W - R, H)}I${c(-R)}J0D01*`, 'G01*',
  xy(R, H) + 'D01*', 'G03*', `${xy(0, H - R)}I0J${c(-R)}D01*`, 'G01*',
  xy(0, R) + 'D01*', 'G03*', `${xy(R, 0)}I${c(R)}J0D01*`, 'G01*',
]);

// ---------- drill ----------
const f3 = v => v.toFixed(3);
const drill = [
  'M48', '; DRILL file webGerber sample', 'FMAT,2', 'METRIC,TZ',
  'T1C0.300', 'T2C1.000', 'T3C3.200', 'T4C1.200', '%', 'G90', 'G05',
  'T1', ...vias.map(([x, y]) => `X${f3(x)}Y${f3(y)}`),
  'T2', ...header.map(([x, y]) => `X${f3(x)}Y${f3(y)}`),
  'T3', ...mounts.map(([x, y]) => `X${f3(x)}Y${f3(y)}`),
  'T4', `X${f3(53)}Y${f3(24)}G85X${f3(56)}Y${f3(24)}`,
  'T0', 'M30', '',
].join('\n');

const files = {
  'sample-F_Cu.gbr': topCu, 'sample-B_Cu.gbr': botCu,
  'sample-F_Mask.gbr': topMask, 'sample-B_Mask.gbr': botMask,
  'sample-F_Silkscreen.gbr': topSilk, 'sample-B_Silkscreen.gbr': botSilk,
  'sample-F_Paste.gbr': topPaste, 'sample-Edge_Cuts.gbr': edge,
  'sample.drl': drill,
};
for (const [n, t] of Object.entries(files)) writeFileSync(new URL(n, OUT), t);
console.log('wrote', Object.keys(files).length, 'files');
