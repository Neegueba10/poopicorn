// Stage editor state. One continuous, unbounded world of parallaxed sprite
// stamps, collision AABBs and KV-tagged objects, drawn on a plain canvas from
// SDF sheets. encode() flattens to the shipped format — see
// src/js/core/stage.js:
//   [sheets, layers, aabbs, objects?]
//   layers  — [rate, ...stamps] each, in DRAW ORDER; stamps flat stride 5
//             [k, i, x, y, fx]
//   aabbs   — flat stride 5 [type, x0, y0, x1, y1], x1/y1 exclusive
//   objects — variable [x, y, k, i, fx, n, k0, v0, ...]
//
// THE RATE AND THE DRAW ORDER BELONG TO THE LAYER. They used to be two more
// numbers on every stamp — a `rate` and a `depth` — to say what a whole band
// of stamps always shared, and the file had to be kept sorted by depth or the
// runtime silently dropped stamps. Now draw order is simply the order things
// are in: layers in list order, stamps in list order within a layer. Nothing
// sorts anywhere.
//
// STAMPS ARE STILL ONE FLAT LIST HERE, with `l` naming the layer. Selection,
// locking and undo all address stamps by index, so a nested list would have
// meant a second coordinate everywhere for no gain. encode() groups by layer
// on the way out, which is also what makes the editor's list order the file's
// draw order.
//
// Adapted from tools/worldtool/state.js, which is the same document over the
// RetroBuffer stack. Two differences come straight from the host:
//
//   - EVERY SOURCE IS AN SDF SHEET. The worldtool's raw-drawing source (k =
//     -1) was a drawShape replay into an indexed buffer, which a canvas has
//     no equivalent for; the reason it existed — a backdrop too big for a RAM
//     page — went away with the pages.
//   - THERE IS NO SOURCE CAP. 8 atlases was 10 RAM pages minus the palette
//     page. A canvas has no page budget.
//
// Structured here, flat there: the editor keeps objects with named fields and
// flattens on encode, the same split tools/worldtool/state.js and
// tools/scenetool/state.js use (onChange/emit pub-sub, JSON undo stack,
// fileText() mirroring the server's codegen byte for byte).
//
// The tile grid (state.tiles) is an EDITOR-ONLY structure: an authoring grid
// that bakes down into ordinary AABBs (see bakeTiles below, tiles.js's
// meshCells). It never reaches encode()/fileText(), so an unused tile grid
// costs zero shipped bytes. Layer hiding, locking and naming are editor-only
// in the same way (see prefs.js).
import { meshCells } from './tiles.js';
import { rectsOf } from './bake.js';

export const SCREEN_W = 480, SCREEN_H = 270; // one game screen (camera preview)

// --- render dirty flags ---------------------------------------------------
// emit() used to mean "rebuild every panel", and a drag calls it on every
// pointer move — which rebuilt one canvas per sprite thumbnail, one DOM row
// per stamp and ran a deflate, sixty times a second. Each mutation now says
// what it actually changed, and ui.js coalesces the flags into one
// requestAnimationFrame pass. emit() with no argument still means everything,
// because the test hook calls it that way.
export const D = {
  CANVAS: 1,     // the picture only
  VALUES: 2,     // toolbar + inspector field values, in place
  LISTS: 4,      // sheet list, sprite palette, stamp list, layers panel
  INSPECT: 8,    // rebuild the inspector's structure (selection kind changed)
  BYTES: 16,     // the byte counter (debounced)
  OVERVIEW: 32,  // the overview map
};
export const D_ALL = 63;
// what a drag step needs: the picture, the numbers next to it, the counter
export const D_DRAG = D.CANVAS | D.VALUES | D.BYTES | D.OVERVIEW;

export const state = {
  name: 'untitled',
  sheets: [],        // SDF sheet names, in source order (a stamp's k indexes this)
  // Parallax layers, far to near, IN DRAW ORDER: [{ rate }, ...]. A layer is
  // the only thing that carries a parallax rate, and its position in this
  // list is the only thing that carries draw order.
  layers: [{ rate: 1 }],
  stamps: [],        // [{ k, i, x, y, fx, l }, ...]; `l` indexes layers, and
                      // the order WITHIN a layer is the order it draws in
  aabbs: [],         // [{ type, x0, y0, x1, y1 }, ...]
  objects: [],       // [{ x, y, k, i, fx, kvs: [[key, value], ...] }, ...]

  tool: 'select',    // 'select' | 'stamp' | 'aabb' | 'object' | 'tile'
  sel: null,         // { kind: 'stamp'|'aabb'|'object', ix } or null
  multi: [],         // stamp indices in the multi-selection (rubber band,
                      // shift-click/shift-range, or a single click); bulk
                      // edits and group moves/deletes apply to all of them
  multiA: [],        // aabb indices in the selection (marquee/shift-click)
  multiO: [],        // object indices in the selection
  // Indices of stamps that can't be clicked/drag-selected on the canvas or
  // the stamp list (a run of background tiles you keep bumping into while
  // placing everything around it, say) — pure editor bookkeeping, never
  // encoded into the shipped format and never saved, so a reload starts
  // every stamp unlocked again.
  locked: new Set(),
  spriteSnap: false, // stamp tool: snap placement to nearby stamps' edges/corners
  // armed stamp parameters — the LAYER is sticky across placements, so a run
  // of far-background pieces stays on its own plane without re-picking it
  arm: { k: -2, i: 0, fx: 0, l: 0 },
  // The variant brush: extra [k, i] sources the stamp tool picks from at
  // random, so a rubble field stops looking hand-tiled. Empty = place `arm`.
  variants: [],
  paintSpacing: 0,   // drag-paint gap in world px (0 = the sprite's own size)
  lastStep: [0, 0],  // the last move delta — what Ctrl+D repeats along
  aabbType: 0,
  cam: [0, 0],       // world position of the SCREEN's top-left at rate 1 —
                      // this is the real game camera, same value the runtime
                      // and the Tab preview use
  origin: [0, 0],    // pixel offset of the screen box within the (bigger)
                      // editor viewport, so the dotted camera preview sits
                      // centered instead of pinned to the viewport's corner —
                      // purely an editor rendering convenience, recomputed by
                      // canvas.js's rebuildView(); never touches state.cam
  zoom: 1,
  snap: 1,           // placement grid (1 = off)
  // --- layer view filters (editor-only) --- a hidden layer also stops taking
  // clicks, which is the point of hiding one.
  l0: 0, l1: 1e9,    // the layer window that draws normally
  dimOthers: true,   // draw out-of-window layers faintly instead of hiding
  hiddenLayers: [],  // layer indices that do not draw and cannot be picked
  lockedLayers: [],  // layer indices that draw but cannot be picked
  soloLayer: null,   // when set, only this layer draws
  showAabbs: true,   // the collision overlay (a busy stage needs it off)
  showObjects: true,
  runtimeView: false,
  dragBox: null,     // [x0, y0, x1, y1] rubber band (aabb tool / marquee)
  dirty: false,

  sheetData: new Map(), // sheet name -> [model, view, w, h] rows, as imported

  // --- collision tile grid (editor-only, never encoded — see bakeTiles) ---
  tiles: new Map(),    // 'cx,cy' -> type
  tile: 8,             // cell size in world px
  tileOrigin: [0, 0],  // world px of cell (0,0); each axis 0 <= v < tile
  tileType: 0,          // the type painted next (separate from aabbType)
};

// --- layers ---------------------------------------------------------------

export const layerCount = () => state.layers.length;

/** Parallax rate of layer `li` (1 for an index that does not exist, so a
 * half-migrated document still draws somewhere sane). */
export const layerRate = li => state.layers[li]?.rate ?? 1;

/** The rate the next placement lands on. */
export const armRate = () => layerRate(state.arm.l);

export const layerHidden = li =>
  state.hiddenLayers.includes(li)
  || (state.soloLayer != null && state.soloLayer !== li);
export const layerLocked = li => state.lockedLayers.includes(li);

const toggleIn = (list, v) => {
  const i = list.indexOf(v);
  if (i < 0) list.push(v); else list.splice(i, 1);
};
export const toggleLayerHidden = li => toggleIn(state.hiddenLayers, li);
export const toggleLayerLocked = li => toggleIn(state.lockedLayers, li);
export const toggleLayerSolo = li => {
  state.soloLayer = state.soloLayer === li ? null : li;
};

/** Stamp indices on layer `li`, in the order they draw. */
export const stampsOnLayer = li =>
  state.stamps.map((_, i) => i).filter(i => state.stamps[i].l === li);

/** Insert a new layer at `at` (default: after the armed one) and arm it. */
export function addLayer(rate = 1, at = state.arm.l + 1) {
  at = Math.max(0, Math.min(state.layers.length, at));
  state.layers.splice(at, 0, { rate });
  shiftLayerRefs(li => (li >= at ? li + 1 : li));
  state.arm.l = at;
  return at;
}

/** Remove layer `li`. Refused while it still holds stamps — the alternative
 * is silently deleting art or silently re-planing it. */
export function removeLayer(li) {
  if (state.layers.length < 2) return 'a stage needs one layer';
  if (stampsOnLayer(li).length) return 'that layer still has stamps';
  state.layers.splice(li, 1);
  shiftLayerRefs(x => (x === li ? 0 : x > li ? x - 1 : x));
  state.arm.l = Math.min(state.arm.l, state.layers.length - 1);
  return null;
}

/** Move layer `li` one place towards the front (dir 1) or the back (dir -1).
 * Draw order IS list order, so this is how a whole band changes places. */
export function moveLayer(li, dir) {
  const to = li + dir;
  if (to < 0 || to >= state.layers.length) return li;
  const [row] = state.layers.splice(li, 1);
  state.layers.splice(to, 0, row);
  shiftLayerRefs(x => (x === li ? to : x === to ? li : x));
  return to;
}

// Every editor structure that names a layer by index has to follow a splice.
// One place to do it, so adding a new one cannot forget.
function shiftLayerRefs(map) {
  for (const s of state.stamps) s.l = map(s.l);
  state.arm.l = map(state.arm.l);
  state.hiddenLayers = state.hiddenLayers.map(map);
  state.lockedLayers = state.lockedLayers.map(map);
  if (state.soloLayer != null) state.soloLayer = map(state.soloLayer);
}

/**
 * Move stamps onto layer `li`, adjusting each one's world position so it
 * stays put ON SCREEN at the CURRENT game camera (state.cam — not the
 * editor's viewport-centering origin, which the game never sees).
 * screenPos = worldPos - cam*rate, so holding screenPos fixed while the rate
 * changes means worldPos += cam*(newRate - oldRate); otherwise re-planing a
 * stamp would teleport it across the screen.
 *
 * The moved stamps go to the END of the target layer's order, which is the
 * only answer that does not need a second decision from the person doing it.
 */
export function moveStampsToLayer(ixs, li) {
  const [cx, cy] = state.cam;
  const rate = layerRate(li);
  return reseat(ixs, picked => {
    for (const s of picked) {
      const d = rate - layerRate(s.l);
      s.x += cx * d;
      s.y += cy * d;
      s.l = li;
    }
    return [...state.stamps.filter(s => !picked.includes(s)), ...picked];
  });
}

/**
 * Move the selected stamps one place earlier (dir -1) or later (dir 1) in
 * their own layer's draw order, or all the way to one end (`end`). Draw order
 * is list order now, so this IS "bring to front".
 */
export function reorderStamps(ixs, dir, end = false) {
  if (!ixs.length) return ixs;
  const li = state.stamps[ixs[0]].l;
  return reseat(ixs, picked => {
    const set = new Set(picked);
    const inLayer = state.stamps.filter(s => s.l === li);
    const mine = inLayer.filter(s => set.has(s));
    const others = inLayer.filter(s => !set.has(s));
    if (!mine.length) return state.stamps;
    let at;
    if (end) at = dir > 0 ? others.length : 0;
    else {
      const first = inLayer.indexOf(mine[0]);
      const before = others.filter(s => inLayer.indexOf(s) < first).length;
      at = Math.max(0, Math.min(others.length, before + dir));
    }
    const seq = [...others.slice(0, at), ...mine, ...others.slice(at)];
    let n = 0;
    return state.stamps.map(s => (s.l === li ? seq[n++] : s));
  });
}

/**
 * Run a reordering of state.stamps and carry the index-keyed bookkeeping
 * across it. Selection and locks name stamps by POSITION, and every reorder
 * invalidates every position after the first change — so both are re-derived
 * from object identity afterwards. Returns the moved stamps' new indices.
 */
function reseat(ixs, fn) {
  const picked = ixs.map(i => state.stamps[i]).filter(Boolean);
  const lockedObjs = new Set([...state.locked].map(i => state.stamps[i]));
  state.stamps = fn(picked);
  const set = new Set(picked);
  const out = [];
  const locks = new Set();
  state.stamps.forEach((s, i) => {
    if (set.has(s)) out.push(i);
    if (lockedObjs.has(s)) locks.add(i);
  });
  state.locked = locks;
  return out;
}

/** Is stamp `s` currently visible under the layer filters? */
export const visible = s => s.l >= state.l0 && s.l < state.l1 && !layerHidden(s.l);

/** Can stamp index `ix` be picked up by a click or a marquee? */
export const pickable = ix => {
  const s = state.stamps[ix];
  return !!s && visible(s) && !state.locked.has(ix) && !layerLocked(s.l);
};

// --- geometry ---

/** Natural [w, h] of a stamp/object source (0x0 for an unknown source, a
 * tombstoned id or a marker, which makes it cull away rather than throw).
 * Sizes come from the BAKE's rect table, which exists from the moment a sheet
 * is added — sheetBaker packs before it marches. */
export function srcDims(k, i) {
  if (k < 0) return [0, 0];
  const t = rectsOf(state.sheets[k]);
  return t && t[i * 4 + 2] ? [t[i * 4 + 2], t[i * 4 + 3]] : [0, 0];
}

/** Human label for a source, for lists and the armed-stamp readout. */
export function srcName(k, i) {
  if (k < 0) return 'marker';
  return `${state.sheets[k] || '?'}#${i}`;
}

/** Exclusive world bounds [x0, y0, x1, y1] of stamp `s`. */
export const stampBounds = s => {
  const [w, h] = srcDims(s.k, s.i);
  return [s.x, s.y, s.x + w, s.y + h];
};

/**
 * Stamp indices in DRAW order: by layer, then by list position within it.
 * Array#sort is stable, so the second half of that is free.
 */
export const drawOrder = () => state.stamps.map((_, i) => i)
  .sort((a, b) => state.stamps[a].l - state.stamps[b].l);

/** World position that renders at the editor viewport's pixel (0, 0) — cam
 * shifted back by the centering origin (see state.origin). Every conversion
 * between a viewport pixel and a world point (hit-testing here, plus
 * canvas.js's overlay/mouse math) goes through this, so the dotted camera
 * pane can sit centered in the viewport without state.cam itself changing
 * meaning (it stays the real game camera, same value the runtime uses). */
export const effCam = () => [state.cam[0] - state.origin[0], state.cam[1] - state.origin[1]];

/**
 * Topmost visible stamp under viewport pixel (vx, vy), or -1. Hit testing
 * happens in VIEWPORT space, not world space: two stamps at the same world
 * position but on layers of different rates are drawn in different places, so
 * the pointer is the only common frame of reference.
 */
export function stampAtView(vx, vy) {
  const [cx, cy] = effCam();
  const order = drawOrder();
  for (let j = order.length - 1; j >= 0; j--) {
    const s = state.stamps[order[j]];
    if (!pickable(order[j])) continue;
    const [w, h] = srcDims(s.k, s.i);
    const rate = layerRate(s.l);
    const x = s.x - cx * rate, y = s.y - cy * rate;
    if (vx >= x && vx < x + w && vy >= y && vy < y + h) return order[j];
  }
  return -1;
}

/** Topmost object under world (wx, wy) — objects live on the gameplay plane
 * — or -1. A marker (k = -2) gets a small fixed hit box. */
export function objectAt(wx, wy) {
  if (!state.showObjects) return -1;
  for (let i = state.objects.length - 1; i >= 0; i--) {
    const o = state.objects[i];
    const [w, h] = srcDims(o.k, o.i);
    if (o.k === -2 || !w) {
      if (Math.abs(wx - o.x) <= 4 && Math.abs(wy - o.y) <= 4) return i;
    } else if (wx >= o.x && wx < o.x + w && wy >= o.y && wy < o.y + h) return i;
  }
  return -1;
}

/**
 * Topmost AABB whose EDGE passes within `slop` px of world (x, y) — the
 * interior belongs to stamps, so a room-sized collision box doesn't swallow
 * every click (same rule as the worldtool's).
 */
export function aabbEdgeAt(x, y, slop = 3) {
  if (!state.showAabbs) return -1;
  for (let i = state.aabbs.length - 1; i >= 0; i--) {
    const { x0, y0, x1, y1 } = state.aabbs[i];
    const nearX = x >= x0 - slop && x <= x1 - 1 + slop;
    const nearY = y >= y0 - slop && y <= y1 - 1 + slop;
    const onV = Math.abs(x - x0) <= slop || Math.abs(x - (x1 - 1)) <= slop;
    const onH = Math.abs(y - y0) <= slop || Math.abs(y - (y1 - 1)) <= slop;
    if ((onV && nearY) || (onH && nearX)) return i;
  }
  return -1;
}

/** Where stamp `s` draws, in gameplay-plane coordinates at the current
 * camera — what the marquee, the overview map and the fit both measure. */
export function stampScreenRect(s) {
  const [w, h] = srcDims(s.k, s.i);
  const [cx, cy] = state.cam;
  const rate = layerRate(s.l);
  return [s.x - cx * rate + cx, s.y - cy * rate + cy, w, h];
}

/**
 * Exclusive world bounds of everything in the stage, at rate 1 — what a
 * fit-to-stage zoom and the overview map frame. Stamps are measured where
 * they DRAW at the current camera, so a far-layer backdrop lands where the
 * eye expects it rather than at its raw world coordinate. Null when empty.
 */
export function stageBounds() {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const add = (a, b, c, d) => {
    x0 = Math.min(x0, a); y0 = Math.min(y0, b);
    x1 = Math.max(x1, c); y1 = Math.max(y1, d);
  };
  for (const s of state.stamps) {
    const [sx, sy, w, h] = stampScreenRect(s);
    add(sx, sy, sx + w, sy + h);
  }
  for (const a of state.aabbs) add(a.x0, a.y0, a.x1, a.y1);
  for (const o of state.objects) {
    const [w, h] = srcDims(o.k, o.i);
    add(o.x, o.y, o.x + Math.max(w, 8), o.y + Math.max(h, 8));
  }
  return x0 === Infinity ? null : [x0, y0, x1, y1];
}

/** Exclusive world bounds of the current selection, or null. */
export function selBounds() {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const add = (a, b, c, d) => {
    x0 = Math.min(x0, a); y0 = Math.min(y0, b);
    x1 = Math.max(x1, c); y1 = Math.max(y1, d);
  };
  for (const i of selStampIxs()) {
    const [sx, sy, w, h] = stampScreenRect(state.stamps[i]);
    add(sx, sy, sx + w, sy + h);
  }
  for (const i of selAabbIxs()) {
    const a = state.aabbs[i];
    add(a.x0, a.y0, a.x1, a.y1);
  }
  for (const i of selObjIxs()) {
    const o = state.objects[i];
    const [w, h] = srcDims(o.k, o.i);
    add(o.x, o.y, o.x + Math.max(w, 8), o.y + Math.max(h, 8));
  }
  return x0 === Infinity ? null : [x0, y0, x1, y1];
}

/** World point (wx, wy) -> its tile cell [cx, cy], flooring against
 * tileOrigin so the grid can start at any arbitrary offset. */
export function cellOf(wx, wy) {
  const [ox, oy] = state.tileOrigin;
  return [Math.floor((wx - ox) / state.tile), Math.floor((wy - oy) / state.tile)];
}

/** Cell [cx, cy] -> its exclusive world rect [x0, y0, x1, y1]. */
export function cellRect(cx, cy) {
  const [ox, oy] = state.tileOrigin;
  const x0 = ox + cx * state.tile, y0 = oy + cy * state.tile;
  return [x0, y0, x0 + state.tile, y0 + state.tile];
}

export const paintCell = (cx, cy, type) => { state.tiles.set(`${cx},${cy}`, type); };
export const eraseCell = (cx, cy) => { state.tiles.delete(`${cx},${cy}`); };

/**
 * Flood fill the empty region containing cell (cx, cy), stopping at painted
 * cells and at `limit` cells — the grid is unbounded, so an open region would
 * otherwise fill forever. Returns the number of cells painted.
 */
export function fillCells(cx, cy, type, limit = 4096) {
  if (state.tiles.has(`${cx},${cy}`)) return 0;
  const seen = new Set([`${cx},${cy}`]);
  const queue = [[cx, cy]];
  let n = 0;
  while (queue.length && n < limit) {
    const [x, y] = queue.shift();
    paintCell(x, y, type);
    n++;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const k = `${x + dx},${y + dy}`;
      if (seen.has(k) || state.tiles.has(k)) continue;
      seen.add(k);
      queue.push([x + dx, y + dy]);
    }
  }
  return n;
}

const tileSettingsKey = name => `stagetool:tiles:${name}`;

/** Remember this stage's tile grid settings, so a reload can auto-absorb
 * (ui.js's loadStage). Only recorded once the grid is actually painted —
 * an untouched stage has nothing worth remembering. */
function persistTileSettings() {
  if (typeof localStorage === 'undefined' || !state.tiles.size) return;
  localStorage.setItem(tileSettingsKey(state.name), JSON.stringify({ tile: state.tile, origin: state.tileOrigin }));
}

/** Load this stage's remembered tile grid settings, or null. */
export function loadTileSettings(name) {
  if (typeof localStorage === 'undefined') return null;
  const rec = localStorage.getItem(tileSettingsKey(name));
  return rec ? JSON.parse(rec) : null;
}

/**
 * Rebuild state.aabbs' baked boxes (t: 1) from the tile grid: drop every
 * box this function previously emitted, mesh the grid per type (see
 * tiles.js's meshCells), and push the fresh boxes. The grid is the source
 * of truth; hand-drawn boxes (no `t`) are left untouched.
 */
export function bakeTiles() {
  state.aabbs = state.aabbs.filter(a => !a.t);
  for (const b of meshCells(state.tiles)) state.aabbs.push({ ...b, t: 1 });
  persistTileSettings();
}

/**
 * Absorb every AABB whose four edges lie exactly on the tile grid into
 * `tiles`, removing it, then bake. Non-aligned boxes (and boxes already
 * baked from the grid) are left untouched. Idempotent: rasterize then mesh
 * covers the same area, possibly with fewer boxes than the hand-drawn set.
 */
export function absorbBoxes() {
  const { tile, tileOrigin: [ox, oy] } = state;
  const aligned = a => (a.x0 - ox) % tile === 0 && (a.y0 - oy) % tile === 0
    && (a.x1 - ox) % tile === 0 && (a.y1 - oy) % tile === 0;
  const keep = [];
  for (const a of state.aabbs) {
    if (a.t || !aligned(a)) { keep.push(a); continue; }
    const [cx0, cy0] = cellOf(a.x0, a.y0);
    const [cx1, cy1] = cellOf(a.x1, a.y1);
    for (let cy = cy0; cy < cy1; cy++)
      for (let cx = cx0; cx < cx1; cx++)
        state.tiles.set(`${cx},${cy}`, a.type);
  }
  state.aabbs = keep;
  bakeTiles();
}

export const selStamp = () => state.sel?.kind === 'stamp' ? state.stamps[state.sel.ix] : null;
export const selAabb = () => state.sel?.kind === 'aabb' ? state.aabbs[state.sel.ix] : null;
export const selObject = () => state.sel?.kind === 'object' ? state.objects[state.sel.ix] : null;

/** Every selected stamp index (the multi-selection, or the single selection). */
export function selStampIxs() {
  if (state.multi.length) return state.multi;
  return state.sel?.kind === 'stamp' ? [state.sel.ix] : [];
}
export function selAabbIxs() {
  if (state.multiA.length) return state.multiA;
  return state.sel?.kind === 'aabb' ? [state.sel.ix] : [];
}
export function selObjIxs() {
  if (state.multiO.length) return state.multiO;
  return state.sel?.kind === 'object' ? [state.sel.ix] : [];
}
/** How many things of every kind are selected. */
export const selCount = () =>
  selStampIxs().length + selAabbIxs().length + selObjIxs().length;

/** Replace the stamp selection with exactly `ixs` (empty clears it). Keeps
 * `state.sel` in lockstep so the single-stamp inspector fields (which read
 * `state.sel`, not `state.multi`) still work when exactly one is selected. */
export function setMultiStamps(ixs) {
  state.multi = ixs;
  state.sel = ixs.length ? { kind: 'stamp', ix: ixs[0] } : null;
}

/** Replace the whole selection: stamps, boxes and objects at once (the
 * select tool's marquee, which collects everything it covers). `sel` points
 * at the first stamp if there is one, so the inspector keeps its old
 * single-stamp behaviour. */
export function setSelection(stamps, aabbs = [], objects = []) {
  state.multi = stamps;
  state.multiA = aabbs;
  state.multiO = objects;
  state.sel = stamps.length ? { kind: 'stamp', ix: stamps[0] }
    : aabbs.length ? { kind: 'aabb', ix: aabbs[0] }
      : objects.length ? { kind: 'object', ix: objects[0] } : null;
}

export const clearSelection = () => setSelection([], [], []);

/** Toggle stamp `ix`'s membership in the current selection (shift-click, on
 * the canvas or in the stamp list). */
export function toggleMultiStamp(ix) {
  const s = new Set(selStampIxs());
  s.has(ix) ? s.delete(ix) : s.add(ix);
  setMultiStamps([...s].sort((a, b) => a - b));
}

/** Every stamp index sharing the selected stamp's sprite, layer, or both. */
export function similarStamps(mode) {
  const ixs = selStampIxs();
  if (!ixs.length) return [];
  const t = state.stamps[ixs[0]];
  return state.stamps.map((_, i) => i).filter(i => {
    const s = state.stamps[i];
    if (!pickable(i)) return false;
    if (mode === 'sprite') return s.k === t.k && s.i === t.i;
    if (mode === 'layer') return s.l === t.l;
    return s.k === t.k && s.i === t.i && s.l === t.l;
  });
}

// --- encode / decode (kept adjacent so they stay in sync) ---

/**
 * The layers as the file stores them: [rate, ...stride-5 stamps] each, in
 * draw order. `keep` filters stamps for the editor's view toggles (the saved
 * file never filters). An EMPTY layer is still emitted — its position is what
 * every later layer index means, to the game's split as much as to the file.
 */
export function flatLayers(keep = () => true) {
  return state.layers.map((L, li) => {
    const out = [L.rate];
    for (const s of state.stamps)
      if (s.l === li && keep(s)) out.push(s.k, s.i, s.x, s.y, s.fx);
    return out;
  });
}

export const flatAabbs = () =>
  state.aabbs.flatMap(a => [a.type, a.x0, a.y0, a.x1, a.y1]);

export const flatObjects = () => state.objects.flatMap(
  o => [o.x, o.y, o.k, o.i, o.fx, o.kvs.length, ...o.kvs.flat()]);

/**
 * Replayable stage data — exactly what the runtime and the generated file
 * see, so the editor renders through core/stage.js.
 */
export function encode(keep) {
  return [
    state.sheets.map(n => state.sheetData.get(n)),
    flatLayers(keep),
    flatAabbs(),
    flatObjects(),
  ];
}

/** A stage whose one layer is the objects' visuals, so the editor can draw
 * objects through drawStage too instead of re-implementing the blit. */
export function objectStage() {
  return [
    state.sheets.map(n => state.sheetData.get(n)),
    [[1, ...state.objects.filter(o => o.k > -2).flatMap(o => [o.k, o.i, o.x, o.y, o.fx])]],
    [], [],
  ];
}

/**
 * Rebuild the editor lists from a loaded stage module. `names` are the sheet
 * names parsed off the file's import lines.
 */
export function decode(w, sheetNames) {
  const [, ls = [], ab = [], ob = []] = w;
  const layers = [];
  const stamps = [];
  ls.forEach((L, li) => {
    layers.push({ rate: L[0] });
    for (let i = 1; i < L.length; i += 5)
      stamps.push({ k: L[i], i: L[i + 1], x: L[i + 2], y: L[i + 3], fx: L[i + 4], l: li });
  });
  if (!layers.length) layers.push({ rate: 1 });
  const aabbs = [];
  for (let i = 0; i < ab.length; i += 5)
    aabbs.push({ type: ab[i], x0: ab[i + 1], y0: ab[i + 2], x1: ab[i + 3], y1: ab[i + 4] });
  const objects = [];
  for (let i = 0; i < ob.length;) {
    const n = ob[i + 5];
    const kvs = [];
    for (let j = 0; j < n; j++) kvs.push([ob[i + 6 + j * 2], ob[i + 7 + j * 2]]);
    objects.push({ x: ob[i], y: ob[i + 1], k: ob[i + 2], i: ob[i + 3], fx: ob[i + 4], kvs });
    i += 6 + n * 2;
  }
  return { sheets: sheetNames, layers, stamps, aabbs, objects };
}

/** Mirrors the server's generated stage file (saveStage in
 * tools/drawtool/server.js) so the byte counter is honest; keep in sync. */
export function fileText() {
  const lit = v => typeof v === 'string' ? JSON.stringify(v) : v;
  const objects = flatObjects();
  return state.sheets.map((n, i) => `import _${i} from '../sheets/${n}.js';\n`).join('')
    + `const S=[${state.sheets.map((_, i) => '_' + i).join(',')}];\n`
    + `export default [S,[${flatLayers().map(L => `[${L.join(',')}]`).join(',')}],[${flatAabbs().join(',')}]`
    + `${objects.length ? `,[${objects.map(lit).join(',')}]` : ''}];\n`;
}

// --- mutation ---

export const snapTo = v => state.snap > 1 ? Math.round(v / state.snap) * state.snap : Math.round(v);

/** The source the next placement uses: the armed one, or a random member of
 * the variant brush when one is loaded. */
export function brushSource() {
  if (!state.variants.length) return [state.arm.k, state.arm.i];
  const pool = [[state.arm.k, state.arm.i], ...state.variants];
  return pool[Math.floor(Math.random() * pool.length)];
}

/** Place a stamp with its top-left at (x, y) on the armed layer, and select
 * it. `src` overrides the armed source (the variant brush passes one in). */
export function addStamp(x, y, src) {
  const a = state.arm;
  const [k, i] = src || [a.k, a.i];
  state.stamps.push({ k, i, x, y, fx: a.fx, l: a.l });
  state.sel = { kind: 'stamp', ix: state.stamps.length - 1 };
  state.multi = [];
  state.multiA = [];
  state.multiO = [];
  return state.stamps.length - 1;
}

export function addAabb(x0, y0, x1, y1) {
  state.aabbs.push({ type: state.aabbType, x0, y0, x1, y1 });
  state.sel = { kind: 'aabb', ix: state.aabbs.length - 1 };
  state.multi = [];
  state.multiA = [];
  state.multiO = [];
}

export function addObject(x, y) {
  state.objects.push({ x, y, k: -2, i: 0, fx: 0, kvs: [] });
  state.sel = { kind: 'object', ix: state.objects.length - 1 };
  state.multi = [];
  state.multiA = [];
  state.multiO = [];
}

/** A collision box at the selected stamps' exact bounds — delve's ground
 * draws its own collision, so "box this stamp" is the motion that level made
 * most. One box per stamp, at the CURRENT aabb type. */
export function boxSelectedStamps() {
  const ixs = selStampIxs();
  const made = [];
  for (const i of ixs) {
    const [x0, y0, x1, y1] = stampBounds(state.stamps[i]);
    if (x1 <= x0 || y1 <= y0) continue;
    state.aabbs.push({ type: state.aabbType, x0, y0, x1, y1 });
    made.push(state.aabbs.length - 1);
  }
  return made.length;
}

/** Adopt a placed stamp's source, flip AND layer into the stamp tool — the
 * eyedropper, which is what makes a big parallaxed stage editable without
 * re-picking the plane every time. */
export function eyedrop(ix) {
  const s = state.stamps[ix];
  if (!s) return;
  state.arm = { k: s.k, i: s.i, fx: s.fx, l: s.l };
  state.variants = [];
}

export function offsetSel(dx, dy) {
  for (const i of selStampIxs()) { state.stamps[i].x += dx; state.stamps[i].y += dy; }
  for (const i of selAabbIxs()) {
    const a = state.aabbs[i];
    a.x0 += dx; a.x1 += dx; a.y0 += dy; a.y1 += dy;
  }
  for (const i of selObjIxs()) {
    const o = state.objects[i];
    o.x += dx; o.y += dy;
  }
}

/** The selected stamp drawn last (topmost on screen) — what the inspector
 * shows/edits for a multi-selection, since "the group" has no single x/y/fx
 * of its own. */
export function topmostStamp(ixs) {
  const order = drawOrder();
  for (let j = order.length - 1; j >= 0; j--) if (ixs.includes(order[j])) return order[j];
  return ixs[0];
}

/**
 * Move every selected stamp by a drag delta (dx, dy) expressed in RATE-1
 * world units (== screen px at zoom 1 — worldFromEvent's units). A stamp's
 * OWN world-position change always equals its own screen-position change,
 * regardless of rate (rate only governs how a stamp reacts to the CAMERA
 * moving) — so applying the same flat delta to every selected stamp would
 * drag them all in screen lockstep no matter how far apart their layers are.
 * Scaling each member's delta by ITS LAYER'S rate instead simulates what a
 * `dx,dy` CAMERA pan would do to it: a gameplay-plane member (rate 1) still
 * tracks the cursor exactly, like the stamp tool, but anything nearer or
 * farther ends up offset from it, honoring the group's relative depth instead
 * of moving everything together as if it were flat.
 */
export function dragOffsetStamps(dx, dy, ixs = selStampIxs()) {
  for (const i of ixs) {
    const s = state.stamps[i];
    const rate = layerRate(s.l);
    s.x += dx * rate;
    s.y += dy * rate;
  }
}

// --- clipboard --- module-level, not part of the document, so copying and
// switching to another loaded stage (or reloading) can still paste; a stamp
// clone carries its layer index, so a paste lands on the same plane as long
// as that layer still exists. Boxes and objects travel with it, which is what
// makes a whole platform — art, collision and its pickup — one unit.
let clipboard = { stamps: [], aabbs: [], objects: [] };
let pasteN = 0;

export function copySelection() {
  const stamps = selStampIxs().map(i => structuredClone(state.stamps[i]));
  const aabbs = selAabbIxs().map(i => structuredClone(state.aabbs[i]));
  const objects = selObjIxs().map(i => structuredClone(state.objects[i]));
  if (!stamps.length && !aabbs.length && !objects.length) return 0;
  clipboard = { stamps, aabbs, objects };
  // a pasted box must be hand-drawn, never a tile-grid bake (bakeTiles would
  // delete it on the next stroke)
  for (const a of clipboard.aabbs) delete a.t;
  pasteN = 0;
  return stamps.length + aabbs.length + objects.length;
}

export const clipboardSize = () =>
  clipboard.stamps.length + clipboard.aabbs.length + clipboard.objects.length;

// Each paste offsets a bit further from the source than the last, so
// repeated Ctrl+V casts a visible cascade instead of stacking copies
// exactly on top of each other; a fresh copy resets the cascade.
export function pasteClipboard(dx, dy) {
  if (!clipboardSize()) return;
  pasteN++;
  const ox = dx ?? pasteN * 8, oy = dy ?? pasteN * 8;
  const s0 = state.stamps.length, a0 = state.aabbs.length, o0 = state.objects.length;
  const top = state.layers.length - 1;
  for (const s of clipboard.stamps)
    state.stamps.push({ ...structuredClone(s), x: s.x + ox, y: s.y + oy, l: Math.min(s.l, top) });
  for (const a of clipboard.aabbs)
    state.aabbs.push({ ...structuredClone(a), x0: a.x0 + ox, x1: a.x1 + ox, y0: a.y0 + oy, y1: a.y1 + oy });
  for (const o of clipboard.objects)
    state.objects.push({ ...structuredClone(o), x: o.x + ox, y: o.y + oy });
  setSelection(
    clipboard.stamps.map((_, i) => s0 + i),
    clipboard.aabbs.map((_, i) => a0 + i),
    clipboard.objects.map((_, i) => o0 + i));
}

/**
 * Duplicate the selection `count` times, each copy `dx`/`dy` further along —
 * a 20-tile corridor in one operation. The last copy ends up selected, so a
 * repeat of the repeat continues the run.
 */
export function arraySelection(count, dx, dy) {
  const stamps = selStampIxs().map(i => structuredClone(state.stamps[i]));
  const aabbs = selAabbIxs().map(i => structuredClone(state.aabbs[i]));
  const objects = selObjIxs().map(i => structuredClone(state.objects[i]));
  if (!stamps.length && !aabbs.length && !objects.length) return 0;
  let ls = [], la = [], lo = [];
  for (let n = 1; n <= count; n++) {
    const ox = dx * n, oy = dy * n;
    ls = stamps.map(s => (state.stamps.push({ ...s, x: s.x + ox, y: s.y + oy }), state.stamps.length - 1));
    la = aabbs.map(a => {
      const c = { ...a, x0: a.x0 + ox, x1: a.x1 + ox, y0: a.y0 + oy, y1: a.y1 + oy };
      delete c.t;
      state.aabbs.push(c);
      return state.aabbs.length - 1;
    });
    lo = objects.map(o => (state.objects.push({ ...o, x: o.x + ox, y: o.y + oy }), state.objects.length - 1));
  }
  setSelection(ls, la, lo);
  return count * (stamps.length + aabbs.length + objects.length);
}

/**
 * Snap a tentative w×h stamp placement at (px, py) to the nearest edge or
 * corner of an existing stamp ON THE SAME LAYER within `tol` world px, per
 * axis independently — smart-guide alignment for tile-map-like placement
 * without an actual tilemap. Either return value is null when nothing on that
 * axis was close enough, so the caller can fall back to grid snap.
 */
export function snapToSprites(px, py, w, h, li, tol) {
  let bx = null, bxd = tol, by = null, byd = tol;
  for (const s of state.stamps) {
    if (s.l !== li) continue;
    const [x0, y0, x1, y1] = stampBounds(s);
    for (const tx of [x0, x1, x0 - w, x1 - w]) {
      const d = Math.abs(px - tx);
      if (d <= bxd) { bxd = d; bx = tx; }
    }
    for (const ty of [y0, y1, y0 - h, y1 - h]) {
      const d = Math.abs(py - ty);
      if (d <= byd) { byd = d; by = ty; }
    }
  }
  return [bx, by];
}

// state.locked after removing the stamps at indices in `gone` (a Set) — each
// surviving locked index shifts down by however many removed indices
// preceded it, kept in lockstep with the stamps filter below so a locked
// stamp stays locked after stamps ahead of it are deleted.
function remapLocked(gone) {
  const next = new Set();
  let shift = 0;
  for (let i = 0; i < state.stamps.length; i++) {
    if (gone.has(i)) { shift++; continue; }
    if (state.locked.has(i)) next.add(i - shift);
  }
  return next;
}

export function deleteSel() {
  const ixs = selStampIxs();
  if (ixs.length) {
    const gone = new Set(ixs);
    state.locked = remapLocked(gone);
    state.stamps = state.stamps.filter((_, i) => !gone.has(i));
  }
  const ga = new Set(selAabbIxs());
  if (ga.size) state.aabbs = state.aabbs.filter((_, i) => !ga.has(i));
  const go = new Set(selObjIxs());
  if (go.size) state.objects = state.objects.filter((_, i) => !go.has(i));
  clearSelection();
}

/** Lock/unlock a single stamp by index — it drops out of the selection the
 * moment it locks (a locked stamp can never be selected, so it can't stay
 * in state.multi/state.sel), and a click/drag-select can no longer pick it
 * back up either, on the canvas or in the stamp list. */
export function toggleLock(ix) {
  if (state.locked.has(ix)) state.locked.delete(ix);
  else {
    state.locked.add(ix);
    setMultiStamps(selStampIxs().filter(i => i !== ix));
  }
}

/** Resize handles of the selected AABB: [x0,y0] and the inclusive [x1-1,y1-1]
 * corner, kept non-degenerate (a box always covers at least one pixel). */
export function aabbHandles() {
  const a = selAabb();
  if (!a) return [];
  return [
    { get: () => [a.x0, a.y0], set: (x, y) => { a.x0 = Math.min(x, a.x1 - 1); a.y0 = Math.min(y, a.y1 - 1); } },
    { get: () => [a.x1 - 1, a.y0], set: (x, y) => { a.x1 = Math.max(x + 1, a.x0 + 1); a.y0 = Math.min(y, a.y1 - 1); } },
    { get: () => [a.x1 - 1, a.y1 - 1], set: (x, y) => { a.x1 = Math.max(x + 1, a.x0 + 1); a.y1 = Math.max(y + 1, a.y0 + 1); } },
    { get: () => [a.x0, a.y1 - 1], set: (x, y) => { a.x0 = Math.min(x, a.x1 - 1); a.y1 = Math.max(y + 1, a.y0 + 1); } },
  ];
}

/** Document counts, for the stats readout. */
export function stats() {
  return {
    stamps: state.stamps.length, aabbs: state.aabbs.length,
    objects: state.objects.length, sheets: state.sheets.length,
    layers: state.layers.length,
  };
}

/** Every KV key used anywhere in the stage — the object panel's
 * autocomplete, because a typo in "pickup" is silent and fatal. */
export function objectKeys() {
  const s = new Set();
  for (const o of state.objects) for (const [k] of o.kvs) if (k) s.add(k);
  return [...s].sort();
}

// --- undo / redo --- (JSON snapshots of the document, cap 100)
let undoStack = [];
let redoStack = [];

const snapshot = () => JSON.stringify({
  sheets: state.sheets, layers: state.layers,
  stamps: state.stamps, aabbs: state.aabbs, objects: state.objects,
  tiles: [...state.tiles], tile: state.tile, tileOrigin: state.tileOrigin,
});

function restore(str) {
  const s = JSON.parse(str);
  s.tiles = new Map(s.tiles); // a plain array doesn't survive JSON.stringify as a Map
  Object.assign(state, s);
  state.sel = null;      // may point at something the snapshot doesn't have
  state.multi = [];
  state.multiA = [];
  state.multiO = [];
  state.locked = new Set([...state.locked].filter(i => i < state.stamps.length));
  state.arm.l = Math.min(state.arm.l, state.layers.length - 1);
}

export function pushUndo() {
  state.dirty = true;
  undoStack.push(snapshot());
  if (undoStack.length > 100) undoStack.shift();
  redoStack = [];   // a new edit forks the history
}
export function undo() {
  if (!undoStack.length) return;
  redoStack.push(snapshot());
  restore(undoStack.pop());
  emit();
}
export function redo() {
  if (!redoStack.length) return;
  undoStack.push(snapshot());
  restore(redoStack.pop());
  emit();
}
export const undoDepth = () => undoStack.length;
export const redoDepth = () => redoStack.length;
export function clearUndo() { undoStack = []; redoStack = []; }

// commit(fn): snapshot, mutate, notify. Pass snapshot=false when the undo
// point was already pushed (e.g. once per drag), and `what` to say which
// panels the mutation can possibly have changed — a drag step passes D_DRAG
// so it never rebuilds the sprite palette or the stamp list.
export function commit(fn, snapshot = true, what = D_ALL) {
  if (snapshot) pushUndo();
  fn();
  emit(what);
}

// --- change notification ---
const listeners = [];
export const onChange = fn => listeners.push(fn);
export const emit = (what = D_ALL) => listeners.forEach(fn => fn(what));
