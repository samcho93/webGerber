(() => {
const { parseGerber, parseExcellon, LAYER_TYPES, detectFormat, detectType, buildBoardShape, innerColor, unionBounds, Viewer } = WG;

const $ = sel => document.querySelector(sel);

const DEFAULT_HIDDEN = new Set(['top-paste', 'bottom-paste', 'inner-copper', 'other']);
const SKIP_EXT = /\.(pdf|png|jpe?g|bmp|svg|html?|xml|json|gbrjob|csv|pos|rpt|ipc|step|stp|wrl|xls[xm]?|doc[x]?|md)$/i;

const ui = {
  dual: false,            // two boards side by side
  view: 'split',          // TOP + BOTTOM | TOP | BOTTOM
  linked: true,           // TOP and BOTTOM panels pan/zoom together
  active: null,           // Workspace shown in the sidebar
};

// ---------- workspace: one loaded board in one screen slot ----------
class Workspace {
  constructor(index) {
    this.index = index;
    this.tag = 'AB'[index];
    this.layers = [];
    this.fileName = '';
    this.el = $('#slotTpl').content.firstElementChild.cloneNode(true);
    this.el.querySelector('.slot-tag').textContent = this.tag;
    $('#slots').appendChild(this.el);

    this.viewer = new Viewer(this.el.querySelector('.panels'), {
      onCursor: (x, y) => { $('#stCursor').textContent = `${ui.dual ? this.tag + '  ' : ''}X ${x.toFixed(3)}  Y ${y.toFixed(3)} mm`; },
      onZoom: z => { this.zoom = z; if (ui.active === this) $('#zoomLabel').textContent = `${Math.round(z * 100)}%`; },
    });

    this.el.addEventListener('pointerdown', () => activate(this), true);
    this.el.querySelector('.drop').addEventListener('click', () => { activate(this); openPicker(); });
    this.el.querySelector('.slot-open').addEventListener('click', () => { activate(this); openPicker(); });
    this.el.querySelector('.slot-sample').addEventListener('click', () => { activate(this); this.loadSample(); });
  }

  busy(text) {
    this.el.querySelector('.busy').hidden = !text;
    if (text) this.el.querySelector('.busy-text').textContent = text;
  }

  async loadFiles(fileList) {
    const files = [...fileList];
    if (!files.length) return;
    const busy = t => this.busy(t);
    busy('불러오는 중…');
    try {
      const entries = [];
      for (const f of files) {
        const data = new Uint8Array(await f.arrayBuffer());
        if (archiveKind(data, f.name)) entries.push(...await readArchive(data, f.name, busy));
        else entries.push({ name: f.name, text: decodeText(data) });
      }
      await this.buildLayers(entries, files.length === 1 ? files[0].name : `${files.length}개 파일`);
    } catch (e) {
      console.error(e);
      alert(`${ui.dual ? `[${this.tag}] ` : ''}파일을 읽을 수 없습니다: ` + e.message);
    } finally {
      busy(null);
    }
  }

  async loadSample() {
    const busy = t => this.busy(t);
    busy('샘플 불러오는 중…');
    try {
      const res = await fetch('sample/sample-board.zip');
      if (!res.ok) throw new Error(res.statusText);
      const entries = await readArchive(new Uint8Array(await res.arrayBuffer()), 'sample-board.zip', busy);
      await this.buildLayers(entries, 'sample-board.zip');
    } catch (e) {
      alert('샘플을 불러오지 못했습니다: ' + e.message + (location.protocol === 'file:' ? ' (로컬 파일로 열면 샘플은 지원되지 않습니다. 파일 열기를 사용하세요.)' : ''));
    } finally {
      busy(null);
    }
  }

  async buildLayers(entries, fileName) {
    const layers = [];
    let id = 0;
    for (const { name, text } of entries) {
      const format = detectFormat(name, text);
      if (!format) continue;
      const type = detectType(name, text, format);
      layers.push({ id: id++, name: name.split('/').pop(), path: name, text, format, type, visible: !DEFAULT_HIDDEN.has(type), color: null, data: null, error: null });
    }
    if (!layers.length) throw new Error('거버 / 드릴 파일을 찾지 못했습니다.');

    layers.sort((a, b) => LAYER_TYPES[a.type].order - LAYER_TYPES[b.type].order || a.name.localeCompare(b.name, undefined, { numeric: true }));
    let inner = 0;
    for (const l of layers) {
      l.color = l.type === 'inner-copper' ? innerColor(inner++) : LAYER_TYPES[l.type].color;
      this.busy(`해석 중: ${l.name}`);
      await new Promise(r => setTimeout(r, 0));
      parseLayer(l);
    }
    this.layers = layers;
    this.fileName = fileName;
    this.el.querySelector('.drop').classList.add('hide');
    this.el.querySelector('.slot-name').textContent = fileName;
    this.el.querySelector('.slot-name').title = fileName;
    this.refresh(true);
  }

  refresh(fit) {
    const layers = this.layers;
    const outline = layers.find(l => l.type === 'outline' && l.data && l.data.segments);
    const board = outline ? buildBoardShape(outline.data.segments) : null;
    const bounds = unionBounds(layers.filter(l => l.data && l.type !== 'other').map(l => l.data.bounds));
    this.boardBounds = board ? board.bounds : bounds;
    if (fit) {
      this.viewer.setData(layers, board, bounds);
    } else {
      Object.assign(this.viewer, { layers, board, bounds });
      this.viewer.draw();
    }
    if (ui.active === this) updateSidebar();
  }
}

function parseLayer(l) {
  try {
    l.data = l.format === 'drill' ? parseExcellon(l.text) : parseGerber(l.text, { keepSegments: l.type === 'outline' });
    l.error = null;
  } catch (e) {
    console.error(l.name, e);
    l.data = null;
    l.error = e.message;
  }
}

// ---------- archives ----------
const ARCHIVE_EXT = /\.(zip|rar|7z|tar|tgz|tbz2?|txz|gz|bz2|xz|lzh|lha|cab|arj|iso)$/i;

// Identify an archive by its signature, falling back to the file extension.
function archiveKind(d, name) {
  const at = (off, ...bytes) => bytes.every((b, i) => d[off + i] === b);
  if (at(0, 0x50, 0x4b, 0x03, 0x04) || at(0, 0x50, 0x4b, 0x05, 0x06)) return 'zip';
  if (at(0, 0x52, 0x61, 0x72, 0x21, 0x1a, 0x07)) return 'rar';
  if (at(0, 0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c)) return '7z';
  if (at(0, 0x1f, 0x8b) || at(0, 0x42, 0x5a, 0x68) || at(0, 0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00)) return 'compressed';
  if (at(257, 0x75, 0x73, 0x74, 0x61, 0x72)) return 'tar';
  if (at(0, 0x4d, 0x53, 0x43, 0x46)) return 'cab';
  return ARCHIVE_EXT.test(name) ? 'other' : null;
}

// Returns [{ name, text }] for every non-archive file, descending into nested archives.
async function readArchive(data, name, busy, depth = 0) {
  busy(`압축 해제 중: ${name.split('/').pop()}`);
  const raw = archiveKind(data, name) === 'zip' ? await unzip(data) : await unarchive(data, name);
  const out = [];
  for (const e of raw) {
    if (/(^|\/)(__MACOSX|\.)/.test(e.name)) continue;
    if (archiveKind(e.data, e.name)) {
      if (depth < 3) out.push(...await readArchive(e.data, e.name, busy, depth + 1));
      continue;
    }
    if (SKIP_EXT.test(e.name)) continue;
    out.push({ name: e.name, text: decodeText(e.data) });
  }
  return out;
}

// ZIP via JSZip (works offline-from-disk too).
async function unzip(data) {
  if (!window.JSZip) throw new Error('ZIP 라이브러리(JSZip)를 불러오지 못했습니다. 인터넷 연결을 확인하세요.');
  const zip = await JSZip.loadAsync(data);
  const out = [];
  for (const entry of Object.values(zip.files)) {
    if (entry.dir) continue;
    out.push({ name: entry.name, data: await entry.async('uint8array') });
  }
  return out;
}

// RAR / 7Z / TAR(.gz/.bz2/.xz) / CAB / LZH … via libarchive (WebAssembly), loaded on first use.
let archiveLib = null;
async function libarchive() {
  if (!archiveLib) {
    if (location.protocol === 'file:') {
      throw new Error('RAR·7Z 등은 웹서버(GitHub Pages)에서 열어야 합니다. index.html을 로컬 파일로 열었을 때는 ZIP만 지원됩니다.');
    }
    const mod = await import(new URL('vendor/libarchive/libarchive.js', document.baseURI).href);
    mod.Archive.init();
    archiveLib = mod.Archive;
  }
  return archiveLib;
}

async function unarchive(data, name) {
  const Archive = await libarchive();
  const archive = await Archive.open(new File([data], name.split('/').pop()));
  try {
    if (await archive.hasEncryptedData()) {
      const pw = prompt(`"${name.split('/').pop()}" 압축파일의 암호를 입력하세요.`);
      if (pw == null) throw new Error('암호가 입력되지 않았습니다.');
      await archive.usePassword(pw);
    }
    const files = [];
    const walk = (node, prefix) => {
      for (const [k, v] of Object.entries(node)) {
        if (v instanceof File) files.push({ name: prefix + k, file: v });
        else if (v && typeof v === 'object') walk(v, prefix + k + '/');
      }
    };
    walk(await archive.extractFiles(), '');
    return Promise.all(files.map(async f => ({ name: f.name, data: new Uint8Array(await f.file.arrayBuffer()) })));
  } finally {
    archive.close();
  }
}

function decodeText(data) { return new TextDecoder('utf-8').decode(data); }


// ---------- workspaces / layout ----------
const spaces = [new Workspace(0), new Workspace(1)];

function activate(ws) {
  if (ui.active === ws) return;
  ui.active = ws;
  for (const w of spaces) w.el.classList.toggle('active', w === ws);
  $('#zoomLabel').textContent = `${Math.round((ws.zoom || 1) * 100)}%`;
  updateSidebar();
}

function setLayout(dual) {
  ui.dual = dual;
  document.body.classList.toggle('dual', dual);
  $('#slots').classList.toggle('dual', dual);
  spaces[1].el.hidden = !dual;
  $('#wsTabs').hidden = !dual;
  arrange();
  if (!dual) activate(spaces[0]);
  // re-fit loaded boards to their new slot size (each screen pans/zooms independently)
  requestAnimationFrame(() => { for (const w of spaces) if (w.layers.length) w.viewer.fit(); });
  updateSidebar();
}

// TOP+BOTTOM view → stack boards as rows (A above B); single-side view → columns.
function arrange() {
  $('#slots').classList.toggle('rows', ui.view === 'split');
  $('#slots').classList.toggle('cols', ui.view !== 'split');
}

// ---------- sidebar ----------
const GROUPS = [
  ['TOP', t => LAYER_TYPES[t].side === 'top'],
  ['INNER', t => t === 'inner-copper'],
  ['BOTTOM', t => LAYER_TYPES[t].side === 'bottom'],
  ['기구 / 드릴', t => t === 'outline' || t === 'drill'],
  ['기타', t => t === 'other'],
];

function updateSidebar() {
  const ws = ui.active;
  // tabs
  $('#wsTabs').querySelectorAll('button').forEach((b, i) => {
    b.classList.toggle('on', spaces[i] === ws);
    b.querySelector('span').textContent = spaces[i].fileName || '파일 없음';
    b.title = spaces[i].fileName || '';
  });
  // status bar
  const b = ws.boardBounds;
  const prefix = ui.dual ? `[${ws.tag}] ` : '';
  $('#stFile').textContent = ws.layers.length ? `${prefix}${ws.fileName} · ${ws.layers.length} 레이어` : `${prefix}파일 없음`;
  $('#stSize').textContent = b && isFinite(b.minX) ? `보드 ${(b.maxX - b.minX).toFixed(2)} × ${(b.maxY - b.minY).toFixed(2)} mm` : '';
  // layer list
  const list = $('#layerList');
  list.innerHTML = '';
  if (!ws.layers.length) {
    list.innerHTML = `<p class="empty">${ui.dual ? `${ws.tag} 화면에 ` : ''}압축파일을 열면 레이어 목록이 표시됩니다.</p>`;
    return;
  }
  for (const [title, test] of GROUPS) {
    const items = ws.layers.filter(l => test(l.type));
    if (!items.length) continue;
    const h = document.createElement('div');
    h.className = 'group-title';
    h.textContent = title;
    list.appendChild(h);
    for (const l of items) list.appendChild(layerRow(ws, l));
  }
}

function layerRow(ws, l) {
  const row = document.createElement('label');
  row.className = 'layer' + (l.error ? ' err' : '');
  row.title = l.error ? `오류: ${l.error}` : l.path;

  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = l.visible;
  cb.addEventListener('change', () => { l.visible = cb.checked; ws.viewer.draw(); });

  const color = document.createElement('input');
  color.type = 'color';
  color.value = l.color;
  color.title = '레이어 색상 (레이어 색상 모드)';
  color.addEventListener('input', () => { l.color = color.value; ws.viewer.draw(); });

  const meta = document.createElement('div');
  meta.className = 'meta';
  const name = document.createElement('span');
  name.className = 'fname';
  name.textContent = l.name;
  const sel = document.createElement('select');
  for (const [k, v] of Object.entries(LAYER_TYPES)) {
    if (l.format === 'drill' && k !== 'drill' && k !== 'other') continue;
    const o = document.createElement('option');
    o.value = k; o.textContent = v.label;
    if (k === l.type) o.selected = true;
    sel.appendChild(o);
  }
  sel.addEventListener('change', () => {
    l.type = sel.value;
    l.color = l.type === 'inner-copper' ? innerColor(l.id) : LAYER_TYPES[l.type].color;
    if (l.format === 'gerber' && l.type === 'outline' && !(l.data && l.data.segments)) parseLayer(l);
    ws.refresh(false);
  });
  meta.append(name, sel);

  row.append(cb, color, meta);
  return row;
}

// ---------- UI wiring ----------
function openPicker() { $('#fileInput').click(); }

$('#fileInput').addEventListener('change', e => { ui.active.loadFiles(e.target.files); e.target.value = ''; });
$('#sampleBtn').addEventListener('click', () => ui.active.loadSample());

let dragDepth = 0;
window.addEventListener('dragenter', e => { e.preventDefault(); dragDepth++; document.body.classList.add('dragging'); });
window.addEventListener('dragleave', e => { e.preventDefault(); if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dragging'); } });
window.addEventListener('dragover', e => e.preventDefault());
window.addEventListener('drop', e => {
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('dragging');
  if (!e.dataTransfer?.files?.length) return;
  // dropped on a slot → load there; elsewhere → the active one
  const slot = e.target.closest?.('.slot');
  const ws = spaces.find(w => w.el === slot) || ui.active;
  activate(ws);
  ws.loadFiles(e.dataTransfer.files);
});

function segment(id, attr, fn) {
  const seg = $(id);
  seg.addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    seg.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
    fn(b.dataset[attr]);
  });
}
segment('#layoutSeg', 'layout', l => setLayout(l === 'dual'));
segment('#viewSeg', 'view', v => {
  ui.view = v;
  arrange();
  for (const w of spaces) w.viewer.setView(v);
  $('#linkBtn').disabled = v !== 'split';   // only meaningful with both panels shown
});

$('#linkBtn').addEventListener('click', () => {
  ui.linked = !ui.linked;
  const b = $('#linkBtn');
  b.classList.toggle('on', ui.linked);
  b.setAttribute('aria-pressed', ui.linked);
  b.querySelector('span').textContent = ui.linked ? 'TOP·BOTTOM 연동' : 'TOP·BOTTOM 독립';
  for (const w of spaces) w.viewer.setLinked(ui.linked);
});
segment('#modeSeg', 'mode', m => spaces.forEach(w => w.viewer.setMode(m)));

$('#wsTabs').addEventListener('click', e => {
  const b = e.target.closest('button');
  if (b) activate(spaces[+b.dataset.ws]);
});

const act = () => ui.active.viewer;
$('#zoomIn').addEventListener('click', () => act().zoomBy(1.25));
$('#zoomOut').addEventListener('click', () => act().zoomBy(0.8));
$('#zoomFit').addEventListener('click', () => act().fit());
$('#allOn').addEventListener('click', () => { ui.active.layers.forEach(l => l.visible = true); updateSidebar(); act().draw(); });
$('#allOff').addEventListener('click', () => { ui.active.layers.forEach(l => l.visible = false); updateSidebar(); act().draw(); });

window.addEventListener('keydown', e => {
  if (e.target.closest('input, select, textarea')) return;
  if (e.key === '+' || e.key === '=') act().zoomBy(1.25);
  else if (e.key === '-' || e.key === '_') act().zoomBy(0.8);
  else if (e.key === '0' || e.key === 'f' || e.key === 'F') act().fit();
});

arrange();
setLayout(false);
})();
