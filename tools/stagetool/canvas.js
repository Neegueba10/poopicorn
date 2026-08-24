// Owns the viewport canvas and the display canvas. The stage is rendered
// THROUGH the real runtime: core/stage.js's drawStage does the culled,
// parallaxed drawImage calls at the editing camera, and the editor draws its
// overlays on top of that — never instead of it, so what you see can't drift
// from what the game draws.
//
// Adapted from tools/worldtool/canvas.js, with the RetroBuffer replaced by a
// plain offscreen canvas at world resolution that the display scales up.
// There is no buffer to reallocate, so a zoom change is a resize, not a
// rebuild — and no page to rebake, because a sheet's bake is cached by name
// (bake.js) and outlives every viewport change.
import { drawStage } from '/src/js/core/stage.js';
import {
  state, SCREEN_W, SCREEN_H, encode, objectStage, srcDims, emit,
  stampBounds, drawOrder, visible, layerHidden, layerLocked, layerRate,
  aabbHandles, selStampIxs, selAabbIxs, selObjIxs, effCam, cellRect,
  stageBounds, selBounds, stampScreenRect,
} from './state.js';
import { artOf, ensureArt, baking, progress } from './bake.js';
import { typeLabel } from './prefs.js';

export let view;        // offscreen canvas at world resolution
let vctx;
let ghost = null;       // [k, i, x, y, fx] tentative placement, or null
let tileHover = null;   // [cx, cy] hovered cell (tile tool), or null

const display = document.getElementById('display');
const dctx = display.getContext('2d');
const center = document.getElementById('center');

// Extra painters (the playtest body), run last so they sit over everything.
// A hook rather than an import, so playtest.js can depend on the canvas
// without the canvas depending on it.
const overlays = [];
export const addOverlay = fn => overlays.push(fn);

// stroke colors for AABB overlays, keyed by type (cycles past the end)
const AABB_COLORS = ['#4f4', '#f44', '#fd4', '#4df', '#f4f', '#fa4'];
export const aabbColor = t => AABB_COLORS[t % AABB_COLORS.length];

export function setup() {
  view = document.createElement('canvas');
  vctx = view.getContext('2d');
  rebuildView();
}

/**
 * (Re)size the viewport canvas to fill the center panel at the current zoom.
 * The viewport is the visible world region, in world pixels. Call after a
 * zoom change or a window resize.
 */
export function rebuildView() {
  const w = Math.max(320, Math.min(3072, Math.ceil((center.clientWidth - 4) / state.zoom)));
  const h = Math.max(180, Math.min(1728, Math.ceil((center.clientHeight - 4) / state.zoom)));
  view.width = w;
  view.height = h;
  vctx.imageSmoothingEnabled = false; // resizing resets the context
  // center the SCREEN_W x SCREEN_H camera pane in the (usually bigger) viewport
  state.origin = [(w - SCREEN_W) / 2, (h - SCREEN_H) / 2];
  blit();
}

/**
 * Point the camera so world rect [x0, y0, x1, y1] fills the viewport, with a
 * little margin. Used by fit-stage, frame-selection and the overview map.
 */
export function frameRect(x0, y0, x1, y1, maxZoom = 4) {
  const pad = 24;
  const cw = Math.max(64, center.clientWidth - 4), ch = Math.max(64, center.clientHeight - 4);
  const z = Math.min(maxZoom, Math.max(0.1,
    Math.min(cw / Math.max(1, x1 - x0 + pad), ch / Math.max(1, y1 - y0 + pad))));
  state.zoom = z >= 1 ? Math.floor(z) : Math.round(z * 100) / 100;
  rebuildView();
  centerOn((x0 + x1) / 2, (y0 + y1) / 2);
}

/** Put world point (wx, wy) in the middle of the viewport. */
export function centerOn(wx, wy) {
  state.cam[0] = Math.round(wx - view.width / 2 + state.origin[0]);
  state.cam[1] = Math.round(wy - view.height / 2 + state.origin[1]);
  blit();
}

export function fitStage() {
  const b = stageBounds();
  if (!b) return false;
  frameRect(...b, 2);
  return true;
}

export function frameSelection() {
  const b = selBounds();
  if (!b) return false;
  frameRect(...b, 4);
  return true;
}

/**
 * Start (or reuse) the bake of one sheet. While it marches, only the picture
 * is redrawn; the frame it finishes on rebuilds the panels too, because the
 * sprite thumbnails are copies and a thumbnail cut from an unfinished bake
 * would stay blank.
 */
export const ensureSheet = (name, sheet) =>
  ensureArt(name, sheet, more => {
    if (more) return blit();
    clearThumbs();
    emit();
  });

/** Make sure every sheet of the stage is baking (or baked), then redraw. A
 * bake is cached by name, so this is free once it has run. */
export function bake() {
  for (const n of state.sheets) {
    const s = state.sheetData.get(n);
    if (s) ensureSheet(n, s);
  }
  refresh();
}

/** The bakers behind the stage's sources, in source order — drawStage's
 * `srcs`. A sheet that has not been asked for yet draws nothing. */
const srcs = () => state.sheets.map(artOf);

/** A copy of sheet `name`'s whole baked canvas — picker thumbnails. Copied
 * rather than handed over, because the live one is what the editor draws
 * from and a DOM node can only be in one place. */
export function sheetThumb(name) {
  const a = artOf(name);
  const c = document.createElement('canvas');
  c.width = Math.max(8, a ? a.canvas.width : 8);
  c.height = Math.max(8, a ? a.canvas.height : 8);
  if (a) c.getContext('2d').drawImage(a.canvas, 0, 0);
  return c;
}

/** A canvas showing sprite `id` of sheet `name`, at most `max` px on a side. */
export function spriteThumb(name, id, max = 48) {
  const a = artOf(name);
  const t = a && a.rects, j = id * 4;
  const w = t ? t[j + 2] : 0, h = t ? t[j + 3] : 0;
  const z = w && h ? Math.max(1, Math.min(4, Math.floor(max / Math.max(w, h)))) : 1;
  const c = document.createElement('canvas');
  c.width = Math.max(8, w * z);
  c.height = Math.max(8, h * z);
  if (w) {
    const ctx = c.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(a.canvas, t[j], t[j + 1], w, h, 0, 0, w * z, h * z);
  }
  return c;
}

// Thumbnails used to be re-cut, into a freshly allocated canvas, on every
// panel rebuild — which a drag did sixty times a second. The pixels only
// change when a sheet is rebaked, so they are cut once and kept as data URLs
// (an <img> can be rebuilt for nothing; a canvas node cannot be in two
// places). ensureSheet clears this when a bake lands, and ui.js clears it
// when a sheet is dropped.
const thumbCache = new Map();
let thumbGen = 0;
/** Bumped every time the thumbnails are dropped, so the sprite palette can
 * tell "same sheets, new pixels" from "nothing changed". */
export const thumbVersion = () => thumbGen;
export const clearThumbs = () => { thumbCache.clear(); thumbGen++; };

/** Cached data URL of sprite `id` in sheet `name`, or '' while unbaked. */
export function spriteThumbURL(name, id, max = 48) {
  const key = `${name}#${id}#${max}`;
  const hit = thumbCache.get(key);
  if (hit != null) return hit;
  const a = artOf(name);
  if (!a || !a.rects || !a.rects[id * 4 + 2]) return '';
  const url = spriteThumb(name, id, max).toDataURL();
  thumbCache.set(key, url);
  return url;
}

/** Tentative placement drawn over the stage ([k, i, x, y, fx]); null clears. */
export function setGhost(g) {
  ghost = g;
  blit();
}

/** Cell under the cursor while the tile tool is active ([cx, cy]); null clears. */
export function setTileHover(c) {
  tileHover = c;
  blit();
}

/** Viewport pixel of a world point at parallax `rate`, relative to the
 * centered camera pane (see state.origin / effCam). */
const vx = (x, rate = 1) => x - effCam()[0] * rate;
const vy = (y, rate = 1) => y - effCam()[1] * rate;

/** The stamp filter the editor draws with: the layer WINDOW is applied by
 * drawStage itself (it takes a layer range), so this covers hide/solo only. */
const layerKeep = () => {
  if (state.runtimeView) return undefined;
  if (!state.hiddenLayers.length && state.soloLayer == null) return undefined;
  return s => !layerHidden(s.l);
};

/**
 * Draw everything: the stage through drawStage (dim pass for stamps outside
 * the depth filter, then the in-window pass, then objects and the placement
 * ghost — all four share the one viewport canvas, so each pass has to reach
 * the display before the next overwrites it), then the editor overlays.
 */
export function blit() {
  const { zoom } = state;
  const stage = encode(layerKeep());
  const nL = state.layers.length;
  const w0 = Math.max(0, state.l0), w1 = Math.min(nL, state.l1);
  const art = srcs();
  const clear = () => vctx.clearRect(0, 0, view.width, view.height);

  // --- camera preview (Tab): exactly one screen at the camera, no overlays
  if (state.runtimeView) {
    const z = Math.max(1, Math.round(zoom));
    display.width = SCREEN_W * z;
    display.height = SCREEN_H * z;
    // assigning width/height resets the 2d context (imageSmoothingEnabled
    // included) — must be re-set after, or every drawImage below blurs
    dctx.imageSmoothingEnabled = false;
    dctx.fillStyle = '#000';
    dctx.fillRect(0, 0, display.width, display.height);
    clear();
    drawStage(vctx, stage, art, state.cam[0], state.cam[1], view.width, view.height, 0, 256);
    // the viewport is bigger than a screen: crop to what the game shows
    dctx.drawImage(view, 0, 0, SCREEN_W, SCREEN_H, 0, 0, display.width, display.height);
    for (const fn of overlays) fn(dctx, z, true);
    return;
  }

  display.width = Math.round(view.width * zoom);
  display.height = Math.round(view.height * zoom);
  dctx.imageSmoothingEnabled = false; // same reset-on-resize gotcha as above
  dctx.fillStyle = '#101216';
  dctx.fillRect(0, 0, display.width, display.height);

  // content renders at effCam so the camera pane lands at state.origin
  // instead of the viewport's corner — a pure viewport-window choice, so it
  // doesn't distort parallax (see effCam's doc comment in state.js)
  const [cx, cy] = effCam();

  // out-of-window layers, faint, so a layer filter still shows its context
  if (state.dimOthers && (w0 > 0 || w1 < nL)) {
    clear();
    drawStage(vctx, stage, art, cx, cy, view.width, view.height, 0, w0);
    drawStage(vctx, stage, art, cx, cy, view.width, view.height, w1, nL);
    dctx.globalAlpha = .22;
    dctx.drawImage(view, 0, 0, display.width, display.height);
    dctx.globalAlpha = 1;
  }

  clear();
  drawStage(vctx, stage, art, cx, cy, view.width, view.height, w0, w1);
  if (state.showObjects)
    drawStage(vctx, objectStage(), art, cx, cy, view.width, view.height, 0, 256);
  if (ghost) {
    const g = [stage[0],
      [[layerRate(state.arm.l), ghost[0], ghost[1], ghost[2], ghost[3], ghost[4]]], [], []];
    drawStage(vctx, g, art, cx, cy, view.width, view.height, 0, 256);
  }
  dctx.drawImage(view, 0, 0, display.width, display.height);

  if (state.snap > 1 && state.snap * zoom >= 8) {
    dctx.strokeStyle = 'rgba(255,255,255,.06)';
    dctx.lineWidth = 1;
    dctx.beginPath();
    const x0 = Math.ceil(cx / state.snap) * state.snap;
    const y0 = Math.ceil(cy / state.snap) * state.snap;
    for (let x = x0; vx(x) < view.width; x += state.snap) {
      dctx.moveTo(vx(x) * zoom + .5, 0);
      dctx.lineTo(vx(x) * zoom + .5, display.height);
    }
    for (let y = y0; vy(y) < view.height; y += state.snap) {
      dctx.moveTo(0, vy(y) * zoom + .5);
      dctx.lineTo(display.width, vy(y) * zoom + .5);
    }
    dctx.stroke();
  }

  // world origin: the only fixed landmark in an unbounded stage
  dctx.strokeStyle = 'rgba(255,255,255,.25)';
  dctx.beginPath();
  dctx.moveTo(vx(0) * zoom, 0);
  dctx.lineTo(vx(0) * zoom, display.height);
  dctx.moveTo(0, vy(0) * zoom);
  dctx.lineTo(display.width, vy(0) * zoom);
  dctx.stroke();

  dctx.font = `${Math.max(10, Math.min(16, 5 * zoom))}px monospace`;
  dctx.textBaseline = 'top';

  // tile layer: grid lines, painted cells (25% fill, so the baked box
  // outline drawn on top of them still reads), and the hovered cell —
  // only while the tile tool is active, the live view of the mesh
  if (state.tool === 'tile') {
    const { tile, tiles } = state;
    if (tile * zoom >= 4) {
      dctx.strokeStyle = 'rgba(255,255,255,.15)';
      dctx.lineWidth = 1;
      dctx.beginPath();
      const [ox, oy] = state.tileOrigin;
      const gx0 = Math.floor((cx - ox) / tile) * tile + ox;
      const gy0 = Math.floor((cy - oy) / tile) * tile + oy;
      for (let x = gx0; vx(x) < view.width; x += tile) {
        dctx.moveTo(vx(x) * zoom + .5, 0);
        dctx.lineTo(vx(x) * zoom + .5, display.height);
      }
      for (let y = gy0; vy(y) < view.height; y += tile) {
        dctx.moveTo(0, vy(y) * zoom + .5);
        dctx.lineTo(display.width, vy(y) * zoom + .5);
      }
      dctx.stroke();
    }
    dctx.globalAlpha = .25;
    for (const [key, t] of tiles) {
      const [ccx, ccy] = key.split(',').map(Number);
      const [x0, y0, x1, y1] = cellRect(ccx, ccy);
      dctx.fillStyle = aabbColor(t);
      dctx.fillRect(vx(x0) * zoom, vy(y0) * zoom, (x1 - x0) * zoom, (y1 - y0) * zoom);
    }
    dctx.globalAlpha = 1;
    if (tileHover) {
      const [x0, y0, x1, y1] = cellRect(...tileHover);
      dctx.strokeStyle = '#fff';
      dctx.lineWidth = 1;
      dctx.strokeRect(vx(x0) * zoom + .5, vy(y0) * zoom + .5, (x1 - x0) * zoom - 1, (y1 - y0) * zoom - 1);
    }
  }

  // AABBs: a plain box outline per collision rect, labelled with the type's
  // name when it has one ("solid" reads; "0" does not)
  if (state.showAabbs) {
    const selA = new Set(selAabbIxs());
    state.aabbs.forEach((a, i) => {
      const sel = selA.has(i);
      const x0 = vx(a.x0) * zoom, y0 = vy(a.y0) * zoom;
      const x1 = vx(a.x1) * zoom, y1 = vy(a.y1) * zoom;
      dctx.strokeStyle = aabbColor(a.type);
      dctx.lineWidth = sel ? 3 : 1;
      dctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
      // zoomed out, one label per box is a smear of overlapping text
      if (zoom >= 0.75) {
        dctx.fillStyle = aabbColor(a.type);
        dctx.fillText(typeLabel(a.type), x0 + 3, y0 + 2);
      }
    });
  }

  // objects: markers get a diamond, everything else already drawn above; the
  // KV pairs are LABELLED, because a magenta count cannot tell a spawn from
  // a trigger
  if (state.showObjects) {
    const selO = new Set(selObjIxs());
    state.objects.forEach((o, i) => {
      const sel = selO.has(i);
      const [w, h] = srcDims(o.k, o.i);
      const ox = vx(o.x) * zoom, oy = vy(o.y) * zoom;
      if (o.k === -2 || !w) {
        const r = 5;
        dctx.fillStyle = sel ? '#4af' : '#f4f';
        dctx.beginPath();
        dctx.moveTo(ox, oy - r);
        dctx.lineTo(ox + r, oy);
        dctx.lineTo(ox, oy + r);
        dctx.lineTo(ox - r, oy);
        dctx.closePath();
        dctx.fill();
      } else if (sel) {
        dctx.strokeStyle = '#4af';
        dctx.lineWidth = 2;
        dctx.strokeRect(ox, oy, w * zoom, h * zoom);
      }
      if (o.kvs.length && zoom >= 0.75) {
        const label = o.kvs.map(([k, v]) => `${k}:${v}`).join(' ');
        dctx.font = '10px monospace';
        dctx.fillStyle = 'rgba(0,0,0,.6)';
        dctx.fillRect(ox + 6, oy - 5, dctx.measureText(label).width + 4, 12);
        dctx.fillStyle = '#f8f';
        dctx.fillText(label, ox + 8, oy - 4);
        dctx.font = `${Math.max(10, Math.min(16, 5 * zoom))}px monospace`;
      }
    });
  }

  // locked stamps, and stamps on a locked plane: a dashed grey outline while
  // the select tool is up, so "why can't I grab that" has an answer on screen
  if (state.tool === 'select') {
    dctx.strokeStyle = 'rgba(200,200,210,.35)';
    dctx.lineWidth = 1;
    dctx.setLineDash([3, 3]);
    state.stamps.forEach((s, i) => {
      if (!visible(s) || (!state.locked.has(i) && !layerLocked(s.l))) return;
      const [bx0, by0, bx1, by1] = stampBounds(s);
      const r = layerRate(s.l);
      dctx.strokeRect(vx(bx0, r) * zoom + .5, vy(by0, r) * zoom + .5,
        (bx1 - bx0) * zoom - 1, (by1 - by0) * zoom - 1);
    });
    dctx.setLineDash([]);
  }

  // selected stamps
  for (const i of new Set(selStampIxs())) {
    const s = state.stamps[i];
    if (!s) continue;
    const [bx0, by0, bx1, by1] = stampBounds(s);
    const r = layerRate(s.l);
    dctx.strokeStyle = '#4af';
    dctx.lineWidth = 2;
    dctx.strokeRect(vx(bx0, r) * zoom, vy(by0, r) * zoom,
      (bx1 - bx0) * zoom, (by1 - by0) * zoom);
  }

  // AABB resize handles
  if (state.sel?.kind === 'aabb' && state.showAabbs) {
    for (const hnd of aabbHandles()) {
      const [hx, hy] = hnd.get();
      const hcx = (vx(hx) + .5) * zoom, hcy = (vy(hy) + .5) * zoom;
      dctx.fillStyle = '#fff';
      dctx.strokeStyle = '#036';
      dctx.lineWidth = 1;
      dctx.fillRect(hcx - 4, hcy - 4, 8, 8);
      dctx.strokeRect(hcx - 4, hcy - 4, 8, 8);
    }
  }

  if (state.dragBox) {
    const [dx0, dy0, dx1, dy1] = state.dragBox;
    dctx.strokeStyle = state.tool === 'aabb' ? aabbColor(state.aabbType)
      : state.tool === 'tile' ? aabbColor(state.tileType) : '#4af';
    dctx.lineWidth = 1;
    dctx.setLineDash([4, 3]);
    dctx.strokeRect(vx(dx0) * zoom + .5, vy(dy0) * zoom + .5,
      (dx1 - dx0 + 1) * zoom - 1, (dy1 - dy0 + 1) * zoom - 1);
    dctx.setLineDash([]);
  }

  // the screen the game shows at this camera, centered in the viewport
  dctx.strokeStyle = 'rgba(255,255,255,.6)';
  dctx.lineWidth = 1;
  dctx.setLineDash([6, 4]);
  dctx.strokeRect(state.origin[0] * zoom + .5, state.origin[1] * zoom + .5,
    SCREEN_W * zoom - 1, SCREEN_H * zoom - 1);
  dctx.setLineDash([]);

  // a bake in progress is the one thing the picture cannot show by itself
  if (baking()) {
    dctx.fillStyle = '#4af';
    dctx.fillRect(0, display.height - 3, display.width * progress(), 3);
  }

  for (const fn of overlays) fn(dctx, zoom, false);
}

// Nothing is cached between frames — every blit re-renders through the
// runtime — so "refresh" and "blit" are the same operation here. Kept as a
// separate name so the call sites read like the other tools'.
export const refresh = blit;

/** Display event -> fractional viewport pixel coords. */
export function viewFromEvent(e) {
  const rect = display.getBoundingClientRect();
  return [(e.clientX - rect.left) / state.zoom, (e.clientY - rect.top) / state.zoom];
}

/** Display event -> gameplay-plane (rate 1) world pixel coords. */
export function worldFromEvent(e) {
  const [x, y] = viewFromEvent(e);
  const [cx, cy] = effCam();
  return [Math.floor(x + cx), Math.floor(y + cy)];
}

/** Where the armed stamp would land: the cursor in the ARMED RATE's world
 * space, so a placement lands under the cursor exactly as previewed. */
export function placeFromEvent(e) {
  const [x, y] = viewFromEvent(e);
  const [cx, cy] = effCam();
  const rate = layerRate(state.arm.l);
  return [Math.floor(x + cx * rate), Math.floor(y + cy * rate)];
}

/** Stamp indices whose bounds fall inside a world-space marquee (rate 1
 * coordinates — the marquee selects what it visually covers). */
export function stampsInBox(x0, y0, x1, y1) {
  return drawOrder().filter(i => {
    const s = state.stamps[i];
    if (!visible(s) || state.locked.has(i) || layerLocked(s.l)) return false;
    const [sx, sy, w, h] = stampScreenRect(s);
    return w && sx < x1 && x0 < sx + w && sy < y1 && y0 < sy + h;
  });
}

/** AABB indices overlapping a world-space marquee. */
export const aabbsInBox = (x0, y0, x1, y1) => state.showAabbs
  ? state.aabbs.map((_, i) => i).filter(i => {
    const a = state.aabbs[i];
    return a.x0 < x1 && x0 < a.x1 && a.y0 < y1 && y0 < a.y1;
  })
  : [];

/** Object indices inside a world-space marquee. */
export const objectsInBox = (x0, y0, x1, y1) => state.showObjects
  ? state.objects.map((_, i) => i).filter(i => {
    const o = state.objects[i];
    return o.x >= x0 && o.x < x1 && o.y >= y0 && o.y < y1;
  })
  : [];

export { display };
