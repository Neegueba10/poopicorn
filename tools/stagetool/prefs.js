// Per-stage EDITOR preferences: layer names, collision type names, camera
// bookmarks, the player-split marker and object KV presets.
//
// None of this reaches the file. A stage stores which sprite, not what the
// editor called it, so every name here lives in localStorage keyed by the
// stage name — the same trick the tile grid settings already use (see
// loadTileSettings in state.js). An unnamed plane simply shows its rate.
//
// Writes are debounced: renaming a plane types one character at a time and
// localStorage is synchronous.

const KEY = name => `stagetool:prefs:${name}`;
const EMPTY = () => ({ layers: [], types: {}, marks: {}, presets: {}, split: 0 });

let name = '';
let cur = EMPTY();
let timer = 0;

const has = () => typeof localStorage !== 'undefined';

function flush() {
  timer = 0;
  if (!has() || !name) return;
  const empty = !cur.split && ['layers', 'types', 'marks', 'presets']
    .every(k => !Object.keys(cur[k]).length);
  if (empty) localStorage.removeItem(KEY(name));
  else localStorage.setItem(KEY(name), JSON.stringify(cur));
}

function touch() {
  if (timer) return;
  timer = setTimeout(flush, 400);
}

/** Point the prefs at a stage. Call on load/new/rename. */
export function usePrefs(stageName) {
  if (timer) { clearTimeout(timer); flush(); }
  name = stageName;
  cur = EMPTY();
  if (!has() || !name) return cur;
  try { Object.assign(cur, JSON.parse(localStorage.getItem(KEY(name)) || '{}')); } catch {}
  for (const k of ['types', 'marks', 'presets']) cur[k] ||= {};
  cur.layers ||= [];
  cur.split ||= 0;
  return cur;
}

// --- layer names --- by INDEX, because that is what a layer is now. Every
// splice in state.js has to move these with it (see moveLayerName).
export const layerName = li => cur.layers[li] || '';
export function setLayerName(li, label) {
  cur.layers[li] = label.trim();
  touch();
}
/** Follow a layer splice: insert a hole at `at`, or move/remove one. */
export function spliceLayerNames(at, remove, insert) {
  cur.layers.splice(at, remove, ...(insert ? [''] : []));
  touch();
}
export function swapLayerNames(a, b) {
  const t = cur.layers[a] || '';
  cur.layers[a] = cur.layers[b] || '';
  cur.layers[b] = t;
  touch();
}

// --- the player split --- the layer index the GAME draws its actors at, so
// the editor can show the line and filter either side of it. Editor-only: a
// game passes the number to drawStage itself.
export const splitAt = () => cur.split | 0;
export function setSplit(li) {
  cur.split = Math.max(0, li | 0);
  touch();
}

// --- collision type names --- "0" reading as `solid` is the whole point.
export const typeName = t => cur.types[t] || '';
export function setTypeName(t, label) {
  label = label.trim();
  if (label) cur.types[t] = label; else delete cur.types[t];
  touch();
}
/** `solid` or, with no name, `0` — the canvas and panel label. */
export const typeLabel = t => cur.types[t] || String(t);

// --- camera bookmarks --- slot 1-9, [x, y, zoom].
export const markOf = slot => cur.marks[slot] || null;
export function setMark(slot, x, y, zoom) {
  cur.marks[slot] = [Math.round(x), Math.round(y), zoom];
  touch();
}

// --- object KV presets --- a named [[key, value], ...] set.
export const presetNames = () => Object.keys(cur.presets);
export const presetOf = n => cur.presets[n] || null;
export function setPreset(n, kvs) {
  if (kvs) cur.presets[n] = kvs.map(p => [p[0], p[1]]);
  else delete cur.presets[n];
  touch();
}
