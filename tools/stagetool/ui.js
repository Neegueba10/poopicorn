// Panels: the sheet source list, the sprite palette, the layers panel, the
// overview map, the selection inspector, the object KV table, save/load, the
// byte counter and the view toggles. Adapted from tools/worldtool/ui.js — the
// same document, with one source kind instead of two.
//
// THE RENDER IS SPLIT AND COALESCED. `emit()` used to mean "rebuild every
// panel", and a drag calls it on every pointer move: one fresh canvas per
// sprite thumbnail, one DOM row per stamp and a deflate, sixty times a
// second. Each mutation now says WHICH panels it can have changed (see D in
// state.js) and the flags are consumed in one requestAnimationFrame pass. A
// drag redraws the picture and the numbers beside it, and nothing else.
import {
  state, commit, pushUndo, undo, redo, onChange, emit, clearUndo, D, D_ALL,
  fileText, flatLayers, flatAabbs, flatObjects, decode, srcDims, srcName, stats,
  selStamp, selAabb, selObject, selStampIxs, selAabbIxs, selObjIxs, selCount,
  setMultiStamps, setSelection, toggleMultiStamp, similarStamps,
  toggleLock, deleteSel, topmostStamp, arraySelection, reorderStamps,
  absorbBoxes, loadTileSettings, objectKeys, boxSelectedStamps,
  undoDepth, redoDepth, layerLocked, layerRate, SCREEN_W, SCREEN_H,
} from './state.js';
import {
  blit, refresh, bake, rebuildView, sheetThumb, spriteThumbURL, thumbVersion,
  clearThumbs, setGhost, ensureSheet, fitStage, frameSelection, centerOn, view,
} from './canvas.js';
import { dropArt, rectsOf } from './bake.js';
import {
  rebuildLayers, showAllLayers, newLayer, dropLayer, shiftLayer, setArmedRate,
  setSplitAt,
} from './layers.js';
import { drawOverview, mapToWorld } from './overview.js';
import { alignSelection, distributeSelection, selSpan } from './arrange.js';
import {
  usePrefs, typeName, setTypeName, presetNames, presetOf, setPreset,
  layerName, splitAt,
} from './prefs.js';
import { setStatus } from './status.js';
import { toggleShortcuts } from './shortcuts.js';
import { scrubbable } from '/sdftool/numfield.js';
import * as playtest from './playtest.js';
const { play } = playtest;

const $ = id => document.getElementById(id);
export { setStatus };

// --- coalesced render -----------------------------------------------------
// The pass is scheduled on requestAnimationFrame AND on a short timer,
// whichever comes first. rAF alone is the right clock while the window is
// visible, but a throttled or occluded tab can starve it for hundreds of
// milliseconds, and an editor whose panels stop agreeing with its document
// is worse than one that redraws a frame early.
let pending = 0, rafId = 0, timerId = 0;

function schedule() {
  if (rafId || timerId) return;
  rafId = requestAnimationFrame(fire);
  timerId = setTimeout(fire, 24);
}

function fire() {
  if (rafId) cancelAnimationFrame(rafId);
  if (timerId) clearTimeout(timerId);
  rafId = timerId = 0;
  flush();
}

function flush() {
  const w = pending;
  pending = 0;
  if (w & D.CANVAS) refresh();
  if (w & D.LISTS) {
    rebuildSources();
    rebuildPalette();
    rebuildStampList();
    rebuildLayers();
  }
  if (w & D.INSPECT) rebuildInspector();
  if (w & (D.VALUES | D.INSPECT)) {
    syncToolbar();
    syncInspectorValues();
    syncReadouts();
  }
  if (w & D.OVERVIEW) drawMap();
  if (w & D.BYTES) queueBytes();
}

function onDirty(what) {
  pending |= what;
  schedule();
}
onChange(onDirty);

/** Render everything now, without waiting for a frame. */
export function render() {
  pending |= D_ALL;
  fire();
}

// --- byte counter + stats (same shape as the worldtool's) ---
// Debounced: the counter runs the whole codegen and a deflate, and it is
// never worth doing that per frame.
let bytesTimer = 0;
function queueBytes() {
  if (bytesTimer) return;
  bytesTimer = setTimeout(() => { bytesTimer = 0; updateBytes(); }, 250);
}

async function updateBytes() {
  const text = fileText();
  let msg = `${new Blob([text]).size} B raw`;
  if (window.CompressionStream) {
    const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('deflate-raw'));
    const gz = await new Response(stream).arrayBuffer();
    msg += ` / ~${gz.byteLength} B deflated`;
  }
  $('bytes').textContent = msg;
  const s = stats();
  const baked = state.aabbs.filter(a => a.t).length;
  // Past ~150-200 baked boxes a runtime tilemap collider starts winning on
  // bytes — the warning is a nudge to
  // measure, not a hard rule.
  $('stats').textContent = `${s.layers} layers · ${s.stamps} stamps · ${s.aabbs} aabbs`
    + (state.tiles.size ? ` (${state.tiles.size} cells)` : '') + ` · ${s.objects} objects`
    + (baked > 200 ? ' ⚠ tile layer past 200 boxes — consider a runtime tilemap' : '');
  $('tile-stats').textContent = `${state.tiles.size} cells → ${baked} boxes`;
}

// --- status bar -----------------------------------------------------------
export function setCoords(wx, wy) { $('coords').textContent = `${wx}, ${wy}`; }

function syncReadouts() {
  $('zoomread').textContent = (state.zoom >= 1 ? state.zoom : state.zoom.toFixed(2)) + '×';
  const n = selCount();
  const s = selStampIxs().length, a = selAabbIxs().length, o = selObjIxs().length;
  $('selread').textContent = !n ? ''
    : [s && `${s} stamp${s > 1 ? 's' : ''}`, a && `${a} box${a > 1 ? 'es' : ''}`,
      o && `${o} object${o > 1 ? 's' : ''}`].filter(Boolean).join(' + ');
  const title = `stagetool — ${state.name}${state.dirty ? ' *' : ''}`;
  if (document.title !== title) document.title = title;
  $('undo').disabled = !undoDepth();
  $('redo').disabled = !redoDepth();
}

// --- overview map ---------------------------------------------------------
let mapT = null;
function drawMap() {
  const c = $('overview');
  const w = Math.max(64, c.clientWidth);
  if (c.width !== w) c.width = w;
  mapT = drawOverview(c, view.width, view.height);
}

function mapJump(e) {
  if (!mapT) return;
  const r = $('overview').getBoundingClientRect();
  const [wx, wy] = mapToWorld(mapT, e.clientX - r.left, e.clientY - r.top);
  centerOn(wx, wy);
  emit(D.VALUES | D.OVERVIEW);
}
$('overview').onpointerdown = e => {
  $('overview').setPointerCapture(e.pointerId);
  mapJump(e);
  $('overview').onpointermove = ev => { if (ev.buttons) mapJump(ev); };
};
$('overview').onpointerup = () => { $('overview').onpointermove = null; };

// --- source loading ---
/**
 * Import a sheet module into state.sheetData. `?v=` because a module is
 * cached by its resolved URL for the life of the page: a sheet edited in the
 * sdftool must come back re-read, and its BAKE has to be dropped with it or
 * the editor keeps showing the old pixels.
 */
export async function loadSheetData(name) {
  const mod = await import(`/src/js/sheets/${name}.js?v=${Date.now()}`);
  state.sheetData.set(name, mod.default);
  dropArt(name);
  clearThumbs();
  return mod.default;
}

/**
 * Add a sheet to the stage (a stamp's k indexes this list). The bake starts
 * BEFORE the document changes, because the rect table exists the moment
 * sheetBaker is constructed — so the sprite palette, the sizes and the stamp
 * list are all correct on the first render, with only the pixels still on
 * their way.
 */
export async function addSheet(name) {
  if (state.sheets.includes(name)) return setStatus(`${name} is already loaded`);
  ensureSheet(name, await loadSheetData(name));
  commit(() => { state.sheets.push(name); });
}

/** Load a saved stage file, recovering its sheet names from the imports. */
export async function loadStage(name) {
  const url = `/src/js/stages/${name}.js`;
  const [mod, text] = await Promise.all([
    import(`${url}?v=${Date.now()}`),
    fetch(url).then(r => r.text()),
  ]);
  const sheetNames = [...text.matchAll(/^import _\d+ from '\.\.\/sheets\/(.+)\.js';$/gm)].map(m => m[1]);
  await Promise.all(sheetNames.map(loadSheetData));
  Object.assign(state, decode(mod.default, sheetNames));
  state.name = name;
  state.sel = null;
  state.multi = [];
  state.multiA = [];
  state.multiO = [];
  state.locked = new Set(); // never saved (see state.js) — a load starts every stamp unlocked
  state.hiddenLayers = [];
  state.lockedLayers = [];
  state.soloLayer = null;
  state.l0 = 0;
  state.l1 = 1e9;
  state.arm.l = 0;
  state.dirty = false;
  usePrefs(name);
  // the tile layer is never saved (see state.js) — a reload starts empty,
  // unless this stage has remembered grid settings from a previous session,
  // in which case it's already a tiled stage: absorb its aligned boxes back
  // into cells automatically instead of making every load a manual step
  state.tiles = new Map();
  const rec = loadTileSettings(name);
  if (rec) {
    state.tile = rec.tile;
    state.tileOrigin = rec.origin;
    absorbBoxes();
  }
  clearUndo();
  $('name').value = name;
  bake();
  emit();
}

// --- source list ---
function sourceRow(label, onRemove, title) {
  const row = document.createElement('div');
  row.className = 'op-row';
  const lbl = document.createElement('span');
  lbl.textContent = label;
  if (title) lbl.title = title;
  const btn = document.createElement('button');
  btn.textContent = '✕';
  btn.onclick = onRemove;
  row.append(lbl, btn);
  return row;
}

// Removing a source would renumber every k above it, silently rewriting what
// the stage's stamps point at — so it's only allowed while nothing
// references it.
function removeSheet(ix) {
  if (state.stamps.some(s => s.k === ix) || state.objects.some(o => o.k === ix))
    return setStatus(`sheet ${state.sheets[ix]} is still in use`);
  commit(() => {
    state.sheets.splice(ix, 1);
    for (const s of state.stamps) if (s.k > ix) s.k--;
    for (const o of state.objects) if (o.k > ix) o.k--;
    if (state.arm.k >= state.sheets.length) state.arm = { ...state.arm, k: -2, i: 0 };
    state.variants = state.variants.filter(v => v[0] < state.sheets.length);
  });
  bake();
}

function rebuildSources() {
  const sl = $('sheet-list');
  sl.replaceChildren();
  state.sheets.forEach((n, i) => {
    const t = rectsOf(n);
    const ids = t ? t.length / 4 : 0;
    sl.append(sourceRow(`${i} · ${n} (${ids} ids)`, () => removeSheet(i),
      'an SDF sheet: models that raymarch into sprites at boot'));
  });
}

// --- stamp list --- windowed: 500 rows is 500 DOM nodes to show twelve, and
// the list rebuilt on every pointer move. Only the rows in view exist.
// Plain click selects only this stamp, Shift range-selects from the last
// clicked row (listbox style), Ctrl/Cmd toggles membership. A locked row is
// inert except for its own unlock button — the point of locking is that a
// stamp can't be picked up by an incidental click.
const ROW_H = 18;
let stampListAnchor = null;
let rowOrder = [];        // stamp indices, in the order the list shows them

function orderedStampIxs() {
  const filter = $('stamp-filter').value.trim().toLowerCase();
  let ixs = state.stamps.map((_, i) => i);
  if (filter) ixs = ixs.filter(i => {
    const s = state.stamps[i];
    return `${i} ${srcName(s.k, s.i)} L${s.l} ${layerName(s.l)}`.toLowerCase().includes(filter);
  });
  // "draw order" groups by layer, which IS the order the game draws in;
  // "list order" is the raw array, for finding something by when it was made
  if ($('stamp-sort').value === 'draw') ixs.sort((a, b) => state.stamps[a].l - state.stamps[b].l);
  return ixs;
}

function stampRow(i) {
  const locked = state.locked.has(i) || layerLocked(state.stamps[i].l);
  const s = state.stamps[i];
  const sel = selStampIxs().includes(i);
  const row = document.createElement('div');
  row.className = 'op-row' + (sel ? ' selected' : '') + (locked ? ' locked' : '');
  const lbl = document.createElement('span');
  lbl.textContent = `${i} ${srcName(s.k, s.i)} @${s.x},${s.y} L${s.l}`;
  if (!locked) lbl.onclick = e => {
    const ixs = selStampIxs();
    if (e.shiftKey) {
      const pos = rowOrder.indexOf(i);
      const a = rowOrder.indexOf(stampListAnchor);
      const [lo, hi] = a < 0 ? [pos, pos] : a < pos ? [a, pos] : [pos, a];
      setMultiStamps(rowOrder.slice(lo, hi + 1).filter(k => !state.locked.has(k)));
    } else if (e.ctrlKey || e.metaKey) {
      toggleMultiStamp(i);
      stampListAnchor = i;
    } else {
      setMultiStamps(ixs.length === 1 && ixs[0] === i ? [] : [i]);
      stampListAnchor = i;
    }
    emit();
  };
  row.append(lbl);
  const btns = document.createElement('span');
  if (!locked) {
    const x = document.createElement('button');
    x.textContent = '✕';
    x.title = 'delete this stamp';
    x.onclick = () => commit(() => { setSelection([i]); deleteSel(); });
    btns.append(x);
  }
  const lockBtn = document.createElement('button');
  lockBtn.textContent = state.locked.has(i) ? '🔒' : '🔓';
  lockBtn.title = state.locked.has(i) ? 'unlock (allow selecting this stamp again)'
    : 'lock (protect from click/drag-select)';
  lockBtn.onclick = () => { toggleLock(i); emit(); };
  btns.append(lockBtn);
  row.append(btns);
  return row;
}

function paintStampWindow() {
  const box = $('stamp-list'), rows = $('stamp-rows');
  rows.style.position = 'relative';
  rows.style.height = rowOrder.length * ROW_H + 'px';
  const first = Math.max(0, Math.floor(box.scrollTop / ROW_H) - 4);
  const last = Math.min(rowOrder.length, first + Math.ceil(box.clientHeight / ROW_H) + 8);
  rows.replaceChildren();
  for (let n = first; n < last; n++) {
    const el = stampRow(rowOrder[n]);
    el.style.position = 'absolute';
    el.style.top = n * ROW_H + 'px';
    el.style.left = '0';
    el.style.right = '0';
    rows.append(el);
  }
}

function rebuildStampList() {
  rowOrder = orderedStampIxs();
  paintStampWindow();
  scrollToSelection();
}

/** Keep the first selected row on screen — a selection made on the canvas is
 * invisible in a windowed list otherwise. */
function scrollToSelection() {
  const ixs = selStampIxs();
  if (!ixs.length) return;
  const pos = rowOrder.indexOf(ixs[0]);
  if (pos < 0) return;
  const box = $('stamp-list');
  const top = pos * ROW_H;
  if (top < box.scrollTop || top > box.scrollTop + box.clientHeight - ROW_H) {
    box.scrollTop = Math.max(0, top - box.clientHeight / 2);
    paintStampWindow();
  }
}
$('stamp-list').onscroll = () => paintStampWindow();
$('stamp-filter').oninput = rebuildStampList;
$('stamp-sort').onchange = rebuildStampList;

// --- sprite palette ---
// Every live sprite of every loaded sheet, as thumbnails. Clicking one arms
// the stamp tool (or, right after "sprite…" in the object panel, assigns it
// to the selected object); Shift-clicking adds it to the variant brush.
let pendingObjectSrc = false;
let paletteSig = '';

export function armSource(k, i) {
  if (pendingObjectSrc) {
    pendingObjectSrc = false;
    const o = selObject();
    if (o) return commit(() => { o.k = k; o.i = i; });
  }
  state.arm = { ...state.arm, k, i };
  state.tool = 'stamp';
  emit();
}

/** Add or remove a sprite from the variant brush (Shift-click). */
export function toggleVariant(k, i) {
  if (state.arm.k === k && state.arm.i === i) return;
  const at = state.variants.findIndex(v => v[0] === k && v[1] === i);
  if (at >= 0) state.variants.splice(at, 1);
  else state.variants.push([k, i]);
  emit(D.LISTS | D.VALUES);
}

function rebuildPalette() {
  const box = $('palette');
  const filter = $('palette-search').value.trim().toLowerCase();
  const armed = state.tool === 'stamp' || pendingObjectSrc;
  const sig = [state.sheets.join('|'), filter, armed, state.arm.k, state.arm.i,
    state.variants.map(v => v.join(':')).join(','), thumbVersion(),
    state.sheets.map(n => (rectsOf(n) || []).length).join('.')].join('~');
  if (sig === paletteSig) return armInfo();
  paletteSig = sig;
  box.replaceChildren();
  const card = (k, i, label) => {
    const c = document.createElement('div');
    const isArmed = armed && state.arm.k === k && state.arm.i === i;
    const isVar = state.variants.some(v => v[0] === k && v[1] === i);
    c.className = 'sprite-card' + (isArmed ? ' armed' : isVar ? ' variant' : '');
    c.id = `sprite-${k}-${i}`;
    c.title = label + ' — Shift-click for the variant brush';
    const url = spriteThumbURL(state.sheets[k], i);
    if (url) {
      const img = document.createElement('img');
      img.src = url;
      c.append(img);
    } else {
      const [w, h] = srcDims(k, i);
      const ph = document.createElement('div');
      ph.style.cssText = `width:${Math.max(8, w)}px;height:${Math.max(8, h)}px;background:#23262c`;
      c.append(ph);
    }
    c.onclick = e => (e.shiftKey ? toggleVariant(k, i) : armSource(k, i));
    box.append(c);
  };
  state.sheets.forEach((n, k) => {
    const t = rectsOf(n);
    if (!t) return;
    for (let i = 0; i * 4 < t.length; i++) {
      if (!t[i * 4 + 2]) continue; // tombstoned id
      const label = `${n}#${i}`;
      if (filter && !label.toLowerCase().includes(filter)) continue;
      card(k, i, label);
    }
  });
  armInfo();
}

function armInfo() {
  const a = state.arm;
  $('arm-info').textContent = a.k === -2 ? 'nothing armed — pick a sprite'
    : `${srcName(a.k, a.i)} ${srcDims(a.k, a.i).join('×')}`;
  $('arm-layer').textContent =
    `layer ${a.l}${layerName(a.l) ? ' · ' + layerName(a.l) : ''} · rate ${layerRate(a.l)}`;
  $('variant-info').textContent = state.variants.length
    ? `variant brush: ${state.variants.length + 1} sprites` : '';
}

// --- inspector ---
// The STRUCTURE is rebuilt only when the selection's shape changes; a drag
// updates the values in place, because replacing an input mid-gesture tears
// down the element the pointer is on.
function numberField(label, get, set, attrs = {}) {
  return { label, get, set, attrs };
}

function selFields() {
  const ixs = selStampIxs();
  if (ixs.length > 1) {
    // bulk: every field reads/writes the TOPMOST (last-drawn) member — x/y
    // shift the whole group by the same delta (like a nudge), fx sets every
    // member. Re-planing a marqueed run is the Layers panel's ⇥ button now,
    // because the plane is the layer.
    const t = state.stamps[topmostStamp(ixs)];
    return [
      numberField('x', () => t.x, v => { const d = (v | 0) - t.x; for (const i of ixs) state.stamps[i].x += d; }),
      numberField('y', () => t.y, v => { const d = (v | 0) - t.y; for (const i of ixs) state.stamps[i].y += d; }),
      numberField('fx', () => t.fx, v => { for (const i of ixs) state.stamps[i].fx = v ? 1 : 0; },
        { step: 1, min: 0, max: 1 }),
    ];
  }
  // A stamp has no rate and no depth to edit any more — its layer owns both,
  // and the Layers panel is where a stamp changes plane.
  const s = selStamp();
  if (s) return [
    numberField('x', () => s.x, v => s.x = v | 0),
    numberField('y', () => s.y, v => s.y = v | 0),
    numberField('fx', () => s.fx, v => s.fx = v ? 1 : 0, { step: 1, min: 0, max: 1 }),
  ];
  const as = selAabbIxs();
  if (as.length > 1) {
    const a = state.aabbs[as[0]];
    return [numberField('type', () => a.type, v => { for (const i of as) state.aabbs[i].type = v | 0; },
      { step: 1, min: 0, max: 255 })];
  }
  const a = selAabb();
  if (a) return ['type', 'x0', 'y0', 'x1', 'y1'].map(k =>
    numberField(k, () => a[k], v => a[k] = v | 0, { step: 1 }));
  const o = selObject();
  if (o) return [
    numberField('x', () => o.x, v => o.x = v | 0),
    numberField('y', () => o.y, v => o.y = v | 0),
    numberField('fx', () => o.fx, v => o.fx = v ? 1 : 0, { step: 1, min: 0, max: 1 }),
  ];
  return [];
}

let liveFields = [];

function rebuildInspector() {
  const box = $('inspector');
  box.replaceChildren();
  liveFields = [];
  const n = selCount();
  if (n > 1) {
    const note = document.createElement('div');
    note.className = 'hint';
    note.textContent = `${n} selected`;
    note.style.width = '100%';
    box.append(note);
  }
  let pushed = false;
  for (const f of selFields()) {
    const lbl = document.createElement('label');
    lbl.textContent = f.label;
    const inp = document.createElement('input');
    inp.id = 'insp-' + f.label;
    inp.type = 'number';
    Object.assign(inp, f.attrs);
    inp.value = f.get();
    const apply = v => {
      if (!pushed) { pushUndo(); pushed = true; }
      f.set(v);
      emit(D.CANVAS | D.BYTES | D.OVERVIEW);
    };
    inp.oninput = () => apply(+inp.value);
    inp.onchange = () => { pushed = false; };
    scrubbable(inp, f.attrs.step || 1, apply, {
      settle: () => { pushed = false; emit(D.LISTS | D.VALUES); },
      snapshot: () => { pushUndo(); pushed = true; },
    });
    lbl.append(inp);
    box.append(lbl);
    liveFields.push({ inp, f, written: String(inp.value) });
  }
  rebuildObjectPanel();
}

/** Update the inspector's numbers without touching its DOM — what a drag
 * does sixty times a second. */
function syncInspectorValues() {
  for (const rec of liveFields) {
    if (document.activeElement === rec.inp) continue;
    const v = String(rec.f.get());
    if (rec.written === v) continue;   // see `written` above: same reason
    rec.written = v;
    rec.inp.value = v;
  }
}

// Key/value table for the selected object — the same "the tool has zero
// opinion" contract world/scene entities use: keys are strings, values
// numbers, and the game decides what any of it means. Keys autocomplete from
// every key already used in the stage, because a typo in "pickup" is silent
// and fatal.
function rebuildObjectPanel() {
  const o = selObject();
  $('object-panel').style.display = o ? 'flex' : 'none';
  const table = $('object-kv');
  table.querySelectorAll('tr:not(:first-child)').forEach(tr => tr.remove());
  const dl = $('object-keys');
  dl.replaceChildren(...objectKeys().map(k => new Option(k, k)));
  const ps = $('preset-select');
  ps.replaceChildren(new Option('preset…', ''), ...presetNames().map(n => new Option(n, n)));
  if (!o) return;
  $('object-src-btn').textContent = o.k === -2 ? 'sprite…' : `sprite: ${srcName(o.k, o.i)}`;
  let pushed = false;
  o.kvs.forEach((pair, i) => {
    const tr = document.createElement('tr');
    const keyInp = document.createElement('input');
    keyInp.type = 'text';
    keyInp.setAttribute('list', 'object-keys');
    keyInp.value = pair[0];
    keyInp.oninput = () => {
      if (!pushed) { pushUndo(); pushed = true; }
      pair[0] = keyInp.value;
      state.dirty = true;
      emit(D.CANVAS | D.BYTES);
    };
    keyInp.onchange = () => { pushed = false; };
    const valInp = document.createElement('input');
    valInp.type = 'number';
    valInp.value = pair[1];
    valInp.oninput = () => {
      if (!pushed) { pushUndo(); pushed = true; }
      pair[1] = +valInp.value;
      state.dirty = true;
      emit(D.CANVAS | D.BYTES);
    };
    valInp.onchange = () => { pushed = false; };
    const x = document.createElement('button');
    x.textContent = '✕';
    x.onclick = () => commit(() => { o.kvs.splice(i, 1); });
    for (const el of [keyInp, valInp, x]) {
      const td = document.createElement('td');
      td.append(el);
      tr.append(td);
    }
    table.append(tr);
  });
}
$('object-kv-add').onclick = () => {
  const o = selObject();
  if (o) commit(() => { o.kvs.push(['', 0]); });
};
$('object-src-btn').onclick = () => {
  if (!selObject()) return;
  pendingObjectSrc = true;
  setStatus('click a sprite in the palette to give this object a visual');
  paletteSig = '';
  rebuildPalette();
};
$('object-src-clear').onclick = () => {
  const o = selObject();
  if (o) commit(() => { o.k = -2; o.i = 0; });
};
// programmatic twin of a palette click ("k:i"), for tests and scripting
$('object-src-select').onchange = () => {
  const v = $('object-src-select').value;
  if (!v) return;
  $('object-src-select').value = '';
  const [k, i] = v.split(':').map(Number);
  armSource(k, i);
};
$('preset-select').onchange = () => {
  const n = $('preset-select').value;
  $('preset-select').value = '';
  const o = selObject(), kvs = presetOf(n);
  if (!o || !kvs) return;
  commit(() => { o.kvs = kvs.map(p => [p[0], p[1]]); });
  setStatus(`applied preset ${n}`);
};
$('preset-save').onclick = () => {
  const o = selObject();
  if (!o || !o.kvs.length) return setStatus('nothing to save as a preset');
  const n = prompt('preset name', '')?.trim();
  if (!n) return;
  setPreset(n, o.kvs);
  rebuildObjectPanel();
  setStatus(`saved preset ${n}`);
};

// --- toolbar ---
const TOOLS = ['select', 'stamp', 'aabb', 'object', 'tile'];

// A panel field is only rewritten when the STATE behind it has moved since we
// last wrote it. Blindly pushing state into every input on every pass looks
// harmless — the value is usually the same — but the pass is asynchronous now,
// so it can land between "the field was set" and "its input handler ran" and
// put the old number back, silently discarding the edit. If the DOM value has
// drifted from what we wrote, the field belongs to whoever changed it; its own
// handler will settle it into the state.
const written = {};

function syncToolbar() {
  for (const t of TOOLS) $('tool-' + t).classList.toggle('active', state.tool === t);
  for (const p of document.querySelectorAll('.toolpanel'))
    p.style.display = p.dataset.tool === state.tool ? 'flex' : 'none';
  const set = (id, v) => {
    const el = $(id);
    if (document.activeElement === el || written[id] === v) return;
    written[id] = v;
    el.value = v;
  };
  $('arm-fx').checked = !!state.arm.fx;
  set('paint-spacing', state.paintSpacing);
  set('aabb-type', state.aabbType);
  set('aabb-type-name', typeName(state.aabbType));
  set('tile-size', [4, 8, 16, 32].includes(state.tile) ? state.tile : '');
  set('tile-size-custom', state.tile);
  set('tile-origin-x', state.tileOrigin[0]);
  set('tile-origin-y', state.tileOrigin[1]);
  set('tile-type', state.tileType);
  set('zoom', [0.25, 0.5, 1, 2, 3, 4].includes(state.zoom) ? state.zoom : '');
}

/** Forget what was last written, so the next sync pushes the state into every
 * field — how a REJECTED edit gets visibly reverted (see setTileGrid). */
function forceToolbar() {
  for (const k in written) delete written[k];
  syncToolbar();
}

export function setTool(t) {
  state.tool = t;
  if (t !== 'stamp') setGhost(null);
  emit();
}
for (const t of TOOLS) $('tool-' + t).onclick = () => setTool(t);

// Changing the cell size or origin re-keys nothing — cells already painted
// keep their cx,cy and simply land somewhere else in world space — so it's
// refused outright while the layer isn't empty, rather than silently
// reinterpreting what's already painted.
function setTileGrid(patch) {
  if (state.tiles.size) { setStatus('clear the tile layer first'); return forceToolbar(); }
  Object.assign(state, patch);
  emit();
}
$('tile-size').onchange = () => setTileGrid({ tile: Math.max(1, $('tile-size').value | 0) });
$('tile-size-custom').onchange = () => setTileGrid({ tile: Math.max(1, $('tile-size-custom').value | 0) });
$('tile-origin-x').onchange = () => setTileGrid({
  tileOrigin: [(($('tile-origin-x').value | 0) % state.tile + state.tile) % state.tile, state.tileOrigin[1]],
});
$('tile-origin-y').onchange = () => setTileGrid({
  tileOrigin: [state.tileOrigin[0], (($('tile-origin-y').value | 0) % state.tile + state.tile) % state.tile],
});
$('tile-type').oninput = () => { state.tileType = Math.max(0, $('tile-type').value | 0); };
$('tile-absorb').onclick = () => commit(() => absorbBoxes());

const setAabbType = () => {
  state.aabbType = Math.max(0, $('aabb-type').value | 0);
  $('aabb-type-name').value = typeName(state.aabbType);
};
$('arm-fx').onchange = () => { state.arm.fx = $('arm-fx').checked ? 1 : 0; };
$('paint-spacing').oninput = () => { state.paintSpacing = Math.max(0, $('paint-spacing').value | 0); };
$('aabb-type').oninput = setAabbType;
$('aabb-type-name').oninput = () => {
  setTypeName(state.aabbType, $('aabb-type-name').value);
  emit(D.CANVAS);
};
$('variants-clear').onclick = () => { state.variants = []; emit(D.LISTS | D.VALUES); };

scrubbable($('aabb-type'), 1, () => setAabbType(), { settle: () => emit(D.VALUES) });
// the ARMED LAYER's rate, edited in the Layers panel
const applyLayerRate = () => setArmedRate(+$('layer-rate').value);
$('layer-rate').oninput = applyLayerRate;
scrubbable($('layer-rate'), 0.05, applyLayerRate, { settle: () => emit(D_ALL) });
$('layer-split').oninput = () => setSplitAt($('layer-split').value | 0);
$('layer-add').onclick = newLayer;
$('layer-del').onclick = dropLayer;
$('layer-back').onclick = () => shiftLayer(-1);
$('layer-fwd').onclick = () => shiftLayer(1);

// --- playtest fields ---
for (const [id, key, step] of [['play-w', 'w', 1], ['play-h', 'h', 1],
  ['play-grav', 'grav', 0.05], ['play-jump', 'jump', 0.5],
  ['play-speed', 'speed', 0.25], ['play-type', 'type', 1]]) {
  const el = $(id);
  const apply = () => { play[key] = +el.value; };
  el.oninput = apply;
  scrubbable(el, step, apply);
}

// --- view ---
$('zoom').onchange = () => {
  const v = +$('zoom').value;
  if (!v) return;
  state.zoom = v;
  rebuildView();
  emit(D.VALUES | D.OVERVIEW);
};
$('snap').onchange = () => { state.snap = +$('snap').value; blit(); };
const layerFilter = () => {
  const n = state.layers.length;
  state.l0 = Math.max(0, Math.min(n, $('l0').value | 0));
  state.l1 = Math.max(state.l0, Math.min(n, $('l1').value | 0));
  $('l1').value = state.l1;
  blit();
};
$('l0').oninput = layerFilter;
$('l1').oninput = layerFilter;
const setLayerWindow = (a, b) => {
  $('l0').value = a;
  $('l1').value = b;
  layerFilter();
};
$('layer-below').onclick = () => setLayerWindow(0, splitAt());
$('layer-above').onclick = () => setLayerWindow(splitAt(), state.layers.length);
$('layer-all').onclick = () => setLayerWindow(0, state.layers.length);
$('dim-others').onchange = () => { state.dimOthers = $('dim-others').checked; blit(); };
$('show-aabbs').onchange = () => { state.showAabbs = $('show-aabbs').checked; emit(D.CANVAS | D.OVERVIEW); };
$('show-objects').onchange = () => { state.showObjects = $('show-objects').checked; emit(D.CANVAS | D.OVERVIEW); };
$('palette-search').oninput = () => { paletteSig = ''; rebuildPalette(); };
$('undo').onclick = undo;
$('redo').onclick = redo;
$('layers-all').onclick = showAllLayers;
$('help-btn').onclick = toggleShortcuts;
$('fit-stage').onclick = () => { if (!fitStage()) setStatus('nothing to fit'); emit(D.VALUES | D.OVERVIEW); };
$('fit-sel').onclick = () => { if (!frameSelection()) setStatus('nothing selected'); emit(D.VALUES | D.OVERVIEW); };
$('go-origin').onclick = () => { centerOn(0, 0); emit(D.VALUES | D.OVERVIEW); };

// --- arrange --- each of these mutates in place, so the undo snapshot has to
// be taken before the call, not around it
for (const edge of ['left', 'right', 'top', 'bottom', 'hcenter', 'vcenter'])
  $('al-' + edge).onclick = () => {
    pushUndo();
    const n = alignSelection(edge);
    if (!n) return setStatus('select two or more things first');
    emit();
    setStatus(`aligned ${n}`);
  };
for (const axis of ['x', 'y'])
  $('dist-' + axis).onclick = () => {
    pushUndo();
    const n = distributeSelection(axis);
    if (!n) return setStatus('select three or more things first');
    emit();
    setStatus(`spread ${n}`);
  };
$('rep-span').onclick = () => {
  const [w, h] = selSpan();
  $('rep-dx').value = w;
  $('rep-dy').value = 0;
  setStatus(`step set to the selection's ${w}×${h}`);
};
export function repeatSelection() {
  const n = Math.max(1, $('rep-n').value | 0);
  let dx = $('rep-dx').value | 0, dy = $('rep-dy').value | 0;
  // with no step typed, repeat along the last move — Ctrl+D right after
  // dragging a copy into place is the gesture this is for
  if (!dx && !dy) [dx, dy] = state.lastStep.map(Math.round);
  if (!dx && !dy) return setStatus('drag the selection once, or set dx/dy');
  pushUndo();
  const made = arraySelection(n, dx, dy);
  if (!made) return setStatus('nothing selected');
  emit();
  setStatus(`repeated ${made}`);
}
$('rep-go').onclick = repeatSelection;
for (const [id, mode] of [['sel-sprite', 'sprite'], ['sel-layer', 'layer']])
  $(id).onclick = () => {
    const ixs = similarStamps(mode);
    if (!ixs.length) return setStatus('select a stamp first');
    setMultiStamps(ixs);
    emit();
    setStatus(`${ixs.length} stamps with the same ${mode}`);
  };
// Draw order is list order now, so these four are the whole of "bring to
// front" — and the only way to change what covers what within one layer.
export function orderStamps(dir, end) {
  const ixs = selStampIxs();
  if (!ixs.length) return setStatus('select some stamps first');
  pushUndo();
  setMultiStamps(reorderStamps(ixs, dir, end));
  emit();
}
$('ord-back').onclick = () => orderStamps(-1, true);
$('ord-down').onclick = () => orderStamps(-1);
$('ord-up').onclick = () => orderStamps(1);
$('ord-front').onclick = () => orderStamps(1, true);

export function boxStamps() {
  pushUndo();
  const n = boxSelectedStamps();
  if (!n) return setStatus('select some stamps first');
  emit();
  setStatus(`${n} collision boxes at type ${state.aabbType}`);
}
$('box-stamps').onclick = boxStamps;

/** Tab: hide the panels and show exactly one screen at the camera, rendered
 * with the real rates and none of the editor's overlays. */
export function toggleRuntimeView() {
  state.runtimeView = !state.runtimeView;
  for (const id of ['left', 'right', 'divider', 'statusbar'])
    $(id).style.display = state.runtimeView ? 'none' : '';
  blit();
}

// --- new / save / load ---
async function refreshLists() {
  // one dead endpoint must not take down every picker — fall back to empty
  const names = url => fetch(url).then(r => r.json()).catch(() => []);
  const fill = async (id, label, url) => {
    const sel = $(id);
    sel.replaceChildren(new Option(label, ''));
    for (const n of await names(url)) sel.append(new Option(n, n));
  };
  await Promise.all([
    fill('load-select', 'load…', '/api/stages'),
    fill('sheet-select', 'sheet…', '/api/sheets'),
  ]);
}

export async function saveCurrentStage() {
  state.name = $('name').value.trim();
  const res = await fetch('/api/save-stage', {
    method: 'POST',
    body: JSON.stringify({
      name: state.name,
      sheets: state.sheets,
      layers: flatLayers(),
      aabbs: flatAabbs(),
      objects: flatObjects(),
    }),
  });
  const body = await res.text();
  setStatus(res.ok ? `saved ${state.name}.js (${JSON.parse(body).bytes} B)` : `save failed: ${body}`);
  if (res.ok) {
    state.dirty = false;
    usePrefs(state.name);
    syncReadouts();
    refreshLists();
  }
  return res.ok;
}
$('save').onclick = saveCurrentStage;

// Offer to save unsaved changes before an action that discards them. Never
// blocks the action itself — Cancel just proceeds without saving.
async function offerSave() {
  if (state.dirty && confirm(`save unsaved changes to "${state.name}" first?`))
    await saveCurrentStage();
}

// A closed tab used to take the stage with it, silently. The browser shows
// its own wording; all we control is whether it asks.
window.addEventListener('beforeunload', e => {
  if (!state.dirty) return;
  e.preventDefault();
  e.returnValue = '';
});

$('new').onclick = async () => {
  await offerSave();
  Object.assign(state, {
    name: 'untitled', sheets: [], layers: [{ rate: 1 }], stamps: [], aabbs: [],
    objects: [], sel: null, multi: [], multiA: [], multiO: [], locked: new Set(),
    cam: [0, 0], dirty: false, tiles: new Map(), arm: { ...state.arm, l: 0 },
    hiddenLayers: [], lockedLayers: [], soloLayer: null, variants: [],
    l0: 0, l1: 1e9,
  });
  clearUndo();
  usePrefs('untitled');
  $('name').value = state.name;
  bake();
  emit();
};
$('name').oninput = () => { state.name = $('name').value.trim(); };
$('name').onchange = () => { usePrefs(state.name); emit(D.LISTS | D.VALUES); };

$('load-select').onchange = async () => {
  const name = $('load-select').value;
  if (!name) return;
  $('load-select').value = '';
  await offerSave();
  try {
    await loadStage(name);
    setStatus(`loaded ${name}.js`);
  } catch (err) {
    setStatus(`load failed: ${err.message}`);
  }
};
$('sheet-select').onchange = async () => {
  const name = $('sheet-select').value;
  if (!name) return;
  $('sheet-select').value = '';
  await addSheet(name);
};

// --- thumbnail picker (adapted from the worldtool's openPicker) ---
export async function openPicker(mode) { // 'load' | 'sheet'
  await refreshLists();
  const api = { load: '/api/stages', sheet: '/api/sheets' }[mode];
  const names = await (await fetch(api)).json();
  const overlay = document.createElement('div');
  overlay.id = 'picker';
  const grid = document.createElement('div');
  grid.id = 'picker-grid';
  overlay.append(grid);
  const close = () => { overlay.remove(); window.removeEventListener('keydown', esc); };
  const esc = e => { if (e.key === 'Escape') close(); };
  window.addEventListener('keydown', esc);
  overlay.onclick = e => { if (e.target === overlay) close(); };
  for (const n of names) {
    const card = document.createElement('div');
    card.className = 'pick-card';
    const cap = document.createElement('div');
    cap.textContent = n;
    card.append(cap);
    card.onclick = () => {
      close();
      const sel = $(mode === 'load' ? 'load-select' : 'sheet-select');
      sel.value = n;
      sel.dispatchEvent(new Event('change'));
    };
    grid.append(card);
    // A sheet thumbnail is a real bake, so it fills in over a few frames
    // rather than appearing at once — the picture is raymarched, not stored.
    if (mode === 'sheet') {
      loadSheetData(n)
        .then(async s => {
          const art = ensureSheet(n, s);
          while (!art.done()) await new Promise(requestAnimationFrame);
          const c = sheetThumb(n);
          c.style.width = Math.min(160, Math.max(48, c.width)) + 'px';
          card.prepend(c);
        })
        .catch(() => { cap.textContent = n + ' (unreadable)'; });
    }
  }
  document.body.append(overlay);
}
$('load-btn').onclick = () => openPicker('load');
$('sheet-add-btn').onclick = () => openPicker('sheet');

// --- resizable sidebar ---
$('divider').onpointerdown = e => {
  const div = $('divider');
  div.setPointerCapture(e.pointerId);
  // the ResizeObserver below picks the new viewport size up
  div.onpointermove = ev => {
    $('right').style.width = Math.max(220, window.innerWidth - ev.clientX) + 'px';
  };
  div.onpointerup = () => { div.onpointermove = null; };
};

// The viewport follows the CENTER PANE's size, not the window's: a divider
// drag, a panel that grows a scrollbar and a window resize all change it, and
// state.origin (the centered camera pane) is computed from it. A stale origin
// puts the picture a few pixels away from the cursor.
let resizeTimer = 0;
const onResize = () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { rebuildView(); drawMap(); }, 150);
};
new ResizeObserver(onResize).observe($('center'));

// The play button starts at the middle of the camera; `P` starts at the
// cursor (input.js), which is the one you want when you are testing a
// specific jump.
$('tool-play').onclick = () => {
  if (playtest.active()) return playtest.stop();
  playtest.start(state.cam[0] + SCREEN_W / 2, state.cam[1] + SCREEN_H / 2);
};

export function initUI() {
  usePrefs(state.name);
  $('name').value = state.name;
  $('zoom').value = state.zoom;
  $('snap').value = state.snap;
  $('l0').value = state.l0;
  $('l1').value = Math.min(state.l1, state.layers.length);
  $('dim-others').checked = state.dimOthers;
  $('sprite-snap').checked = state.spriteSnap;
  $('show-aabbs').checked = state.showAabbs;
  $('show-objects').checked = state.showObjects;
  for (const [id, key] of [['play-w', 'w'], ['play-h', 'h'], ['play-grav', 'grav'],
    ['play-jump', 'jump'], ['play-speed', 'speed'], ['play-type', 'type']])
    $(id).value = play[key];
  refreshLists();
  render();
}
$('sprite-snap').onchange = () => { state.spriteSnap = $('sprite-snap').checked; };
