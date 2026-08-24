/**
 * The 3D widget: move, rotate and scale the selected part by dragging it.
 *
 * IT DOES NOT USE THE RAY PICKER. A picker can only hit a SURFACE, so a
 * paint-only part — colour and no shape — would not be draggable at all. The
 * gizmo hangs off the part's numbers rather than off its geometry, so every
 * part is draggable whether or not it has a surface.
 *
 * IT WORKS IN THE PART'S OWN FRAME. A rotated capsule's Y handle runs along
 * the capsule, not along the world's up, because the numbers being edited —
 * `a b c`, the half-extents — are in that frame. A gizmo drawn in world axes
 * would move the handle you dragged and change a different number.
 *
 * SCALE IS NOT A TRANSFORM. The format has no scale, and giving it one would
 * cost the renderer a matrix per part in its hottest loop. So a scale handle
 * edits the dimension the primitive reads (see SCALE_COLS in state.js): the
 * cylinder's radius, the box's half-width, the sphere's radius.
 *
 * Geometry only — this module never touches the document. canvas.js owns the
 * pointer and applies the deltas, because it owns undo.
 */
import { STRIDE, SCALE_COLS } from './state.js';
import { partAxes } from './fit.js';

const TAU = Math.PI * 2;

/** Handle distances from the part's centre, in overlay pixels. */
export const ARM = 40, SCALE_ARM = 54, RING = 62, GRAB = 8;

/** Axis colours, the usual X/Y/Z red/green/blue. */
const AXIS_COL = ['#e5566a', '#6ad06a', '#5a9df5'];

/**
 * Everything the widget needs, in overlay pixels.
 *
 * @param {number[]} parts the model
 * @param {number} sel selected part index
 * @param {(x, y, z) => [number, number]} proj world point to overlay pixel
 * @param {number[]} fwd the camera's forward vector, for facing tests
 */
export function build(parts, sel, proj, fwd) {
  const i = sel * STRIDE;
  return buildAt([parts[i + 1], parts[i + 2], parts[i + 3]],
    partAxes(parts, i), proj, fwd, parts[i] & 31);
}

/** World axes. What a GROUP pivot turns about — a group is not a part and has
 * no frame of its own, so its rings are the world's. */
export const WORLD_AXES = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];

/**
 * The same widget at an arbitrary point, about arbitrary axes — the anim tab's
 * group pivot (tools/sdftool/rig.js). Everything below this line works off `c`
 * and `axes` and never asks which part it belongs to, which is why one gizmo
 * serves both.
 */
export function buildAt(c, axesWorld, proj, fwd, kind = 0) {
  const [sx, sy] = proj(c[0], c[1], c[2]);
  const axes = axesWorld.map((w, k) => {
    // A short step along the axis, projected: its length is the pixels-per-
    // world-unit for THIS axis, and its direction is where the handle goes.
    const [ex, ey] = proj(c[0] + w[0] * 0.1, c[1] + w[1] * 0.1, c[2] + w[2] * 0.1);
    const dx = ex - sx, dy = ey - sy;
    const len = Math.hypot(dx, dy);
    return {
      k,
      world: w,
      ppw: len / 0.1,                       // overlay pixels per world unit
      dir: len > 1e-6 ? [dx / len, dy / len] : [0, 0],
      // How edge-on the axis is. An axis pointing at the camera projects to
      // nothing, so dragging it would divide by almost zero: it is drawn faint
      // and refuses the grab rather than sending the part to infinity.
      flat: len / 0.1 < 12,
      away: w[0] * fwd[0] + w[1] * fwd[1] + w[2] * fwd[2] > 0,
    };
  });
  return { c, sx, sy, axes, proj, kind };
}

/** The handles for `mode`, as `{ type, axis, x, y }` in overlay pixels. */
export function handles(g, mode) {
  const out = [{ type: 'free', axis: -1, x: g.sx, y: g.sy }];
  if (mode === 'rotate') return out;                 // the rings are hit by radius
  const arm = mode === 'scale' ? SCALE_ARM : ARM;
  const cols = SCALE_COLS[g.kind] || [];
  for (const a of g.axes) {
    if (a.flat) continue;
    if (mode === 'scale' && cols[a.k] == null) continue;
    out.push({
      type: mode,
      axis: a.k,
      x: g.sx + a.dir[0] * arm,
      y: g.sy + a.dir[1] * arm,
    });
  }
  return out;
}

/** The handle under (x, y), or null. Nearest wins, so overlapping arms in a
 * foreshortened view still resolve to one. */
export function hit(g, mode, x, y) {
  let best = null, bd = GRAB * GRAB;
  for (const h of handles(g, mode)) {
    const d = (h.x - x) ** 2 + (h.y - y) ** 2;
    if (d <= bd) { bd = d; best = h; }
  }
  if (best) return best;
  if (mode !== 'rotate') return null;
  // A ring is grabbed by its rim: the nearest point on the projected circle.
  for (const a of g.axes) {
    const pts = ringPoints(g, a);
    for (let i = 0; i < pts.length; i++) {
      const d = (pts[i][0] - x) ** 2 + (pts[i][1] - y) ** 2;
      if (d <= bd) { bd = d; best = { type: 'rotate', axis: a.k, x, y }; }
    }
  }
  return best;
}

/**
 * The projected circle for one rotation ring: a real 3D circle in the plane
 * the axis is normal to, so it reads as an orientation rather than as a
 * flat disc drawn on the screen.
 */
function ringPoints(g, a) {
  const au = g.axes[(a.k + 1) % 3], av = g.axes[(a.k + 2) % 3];
  const u = au.world, v = av.world;
  // The radius is wanted in PIXELS, so it converts through the two axes that
  // span the ring rather than through the one it turns about — that one may be
  // pointing at the camera and have no scale at all.
  const r = RING / Math.max((au.ppw + av.ppw) / 2, 1e-6);
  const pts = [];
  for (let s = 0; s <= 48; s++) {
    const t = (s / 48) * TAU;
    const ct = Math.cos(t) * r, st = Math.sin(t) * r;
    pts.push(g.proj(
      g.c[0] + u[0] * ct + v[0] * st,
      g.c[1] + u[1] * ct + v[1] * st,
      g.c[2] + u[2] * ct + v[2] * st));
  }
  return pts;
}

/** The projected ring for one axis. Exported for the suite, which presses on
 * a ring the way a person does rather than faking an angle. */
export const ringPointsFor = (g, axis) => ringPoints(g, g.axes[axis]);

/** Draw the widget. `active` is the handle being dragged, if any. */
export function draw(ctx, g, mode, active) {
  ctx.save();
  ctx.lineWidth = 1.5;
  ctx.lineJoin = 'round';

  if (mode === 'rotate') {
    for (const a of g.axes) {
      const pts = ringPoints(g, a);
      ctx.strokeStyle = AXIS_COL[a.k];
      ctx.globalAlpha = active && active.axis === a.k ? 1 : a.away ? 0.35 : 0.8;
      ctx.beginPath();
      pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.stroke();
    }
  } else {
    for (const h of handles(g, mode)) {
      if (h.type === 'free') continue;
      const a = g.axes[h.axis];
      ctx.strokeStyle = ctx.fillStyle = AXIS_COL[h.axis];
      ctx.globalAlpha = active && active.axis === h.axis ? 1 : a.away ? 0.5 : 0.9;
      ctx.beginPath();
      ctx.moveTo(g.sx, g.sy);
      ctx.lineTo(h.x, h.y);
      ctx.stroke();
      if (mode === 'scale') {
        // A box for scale, a head for move: the handle says what it does
        // before you drag it.
        ctx.fillRect(h.x - 4, h.y - 4, 8, 8);
      } else {
        const [dx, dy] = a.dir;
        ctx.beginPath();
        ctx.moveTo(h.x + dx * 7, h.y + dy * 7);
        ctx.lineTo(h.x - dy * 4, h.y + dx * 4);
        ctx.lineTo(h.x + dy * 4, h.y - dx * 4);
        ctx.closePath();
        ctx.fill();
      }
    }
  }

  // The centre: drag it to move in the plane facing you. This is the handle a
  // paint-only part is moved by, since it has no surface to click.
  ctx.globalAlpha = 1;
  ctx.strokeStyle = '#fff';
  ctx.fillStyle = 'rgba(255,255,255,0.25)';
  ctx.beginPath();
  ctx.arc(g.sx, g.sy, 5, 0, TAU);
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

/**
 * How far a drag moved along the handle's axis, in WORLD units.
 *
 * The screen delta is projected onto the axis's own screen direction, then
 * divided by that axis's pixels-per-unit — so the part tracks the pointer
 * along the axis and ignores movement across it.
 */
export function axisDelta(g, axis, dx, dy) {
  const a = g.axes[axis];
  return (dx * a.dir[0] + dy * a.dir[1]) / Math.max(a.ppw, 1e-6);
}

/**
 * The turn swept between two pointer positions, about the ring's centre.
 *
 * Negated when the axis points away from the camera, or the ring on the far
 * side of the part would turn the wrong way under the hand.
 */
export function ringDelta(g, axis, x0, y0, x1, y1) {
  const a0 = Math.atan2(y0 - g.sy, x0 - g.sx);
  const a1 = Math.atan2(y1 - g.sy, x1 - g.sx);
  let d = a1 - a0;
  while (d > Math.PI) d -= TAU;
  while (d < -Math.PI) d += TAU;
  return (g.axes[axis].away ? -d : d) / TAU;
}
