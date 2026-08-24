// The overview map: the whole stage in one small canvas, with the viewport
// rectangle on it. The world is unbounded and the only other landmark is the
// origin cross, so this is what stops you getting lost in a 2,400 px level.
//
// IT IS A SCHEMATIC, NOT A SHRUNKEN PICTURE. drawStage blits 1:1 into a
// canvas at world resolution, so a real render of a wide stage would mean
// allocating a world-sized offscreen canvas every time the map refreshes.
// A map has to be cheap enough to redraw on a drag, and "which plane is that
// layer is that on" is a question a colour answers better than a 4 px sprite.
// Every position on it is still the position drawStage would draw at.
import {
  state, stageBounds, layerHidden, layerCount, stampScreenRect, selStampIxs,
} from './state.js';
import { aabbColor } from './canvas.js';

// far layers cool, the middle bright, near layers warm
const LAYER_COLORS = ['#3a4a6a', '#41608a', '#4a7fae', '#8ab6d6', '#d6c48a', '#d69a6a'];

/** The colour layer `li` draws with on the map and on its panel row. Keyed by
 * POSITION in the stack, not by rate: the stack order is what the map is
 * showing. */
export function layerColor(li) {
  const span = Math.max(1, layerCount() - 1);
  const t = Math.min(1, Math.max(0, li / span));
  return LAYER_COLORS[Math.min(LAYER_COLORS.length - 1, Math.round(t * (LAYER_COLORS.length - 1)))];
}

// World rect the map covers: the stage plus the camera, so the viewport box
// is always on the map even when you pan off the built area.
function mapBounds(vw, vh) {
  const b = stageBounds() || [0, 0, 64, 64];
  const [cx, cy] = state.cam;
  return [
    Math.min(b[0], cx) - 32, Math.min(b[1], cy) - 32,
    Math.max(b[2], cx + vw) + 32, Math.max(b[3], cy + vh) + 32,
  ];
}

/**
 * Draw the map into `c` (a canvas sized by CSS). `vw`/`vh` are the editor
 * viewport's world span, for the "you are here" rectangle. Returns the
 * transform, so a click can be turned back into a world point.
 */
export function drawOverview(c, vw, vh) {
  const ctx = c.getContext('2d');
  const w = c.width, h = c.height;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#141619';
  ctx.fillRect(0, 0, w, h);

  const [x0, y0, x1, y1] = mapBounds(vw, vh);
  const s = Math.min(w / Math.max(1, x1 - x0), h / Math.max(1, y1 - y0));
  const px = x => (x - x0) * s;
  const py = y => (y - y0) * s;
  const [cx, cy] = state.cam;

  // stamps, in draw order, where the camera actually puts them
  const sel = new Set(selStampIxs());
  const order = state.stamps.map((_, i) => i).sort((a, b) => state.stamps[a].l - state.stamps[b].l);
  for (const i of order) {
    const st = state.stamps[i];
    if (layerHidden(st.l)) continue;
    const [sx, sy, sw, sh] = stampScreenRect(st);
    if (!sw) continue;
    ctx.fillStyle = sel.has(i) ? '#4af' : layerColor(st.l);
    ctx.fillRect(px(sx), py(sy), Math.max(1, sw * s), Math.max(1, sh * s));
  }

  if (state.showAabbs) {
    ctx.globalAlpha = .5;
    for (const a of state.aabbs) {
      ctx.fillStyle = aabbColor(a.type);
      ctx.fillRect(px(a.x0), py(a.y0), Math.max(1, (a.x1 - a.x0) * s), Math.max(1, (a.y1 - a.y0) * s));
    }
    ctx.globalAlpha = 1;
  }

  if (state.showObjects) {
    ctx.fillStyle = '#f4f';
    for (const o of state.objects) ctx.fillRect(px(o.x) - 1, py(o.y) - 1, 3, 3);
  }

  // world origin
  ctx.strokeStyle = 'rgba(255,255,255,.2)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(px(0) + .5, 0); ctx.lineTo(px(0) + .5, h);
  ctx.moveTo(0, py(0) + .5); ctx.lineTo(w, py(0) + .5);
  ctx.stroke();

  // the editor viewport, and inside it the screen the game shows
  ctx.strokeStyle = '#4af';
  ctx.strokeRect(px(cx - state.origin[0]) + .5, py(cy - state.origin[1]) + .5,
    Math.max(2, vw * s), Math.max(2, vh * s));
  ctx.strokeStyle = 'rgba(255,255,255,.7)';
  ctx.strokeRect(px(cx) + .5, py(cy) + .5, Math.max(2, 480 * s), Math.max(2, 270 * s));

  return { x0, y0, s };
}

/** Map pixel -> world point, using the transform drawOverview returned. */
export const mapToWorld = (t, mx, my) => [t.x0 + mx / t.s, t.y0 + my / t.s];
