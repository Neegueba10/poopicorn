/**
 * The view widget: a small axis cross in the corner that says which way the
 * camera is looking, and turns or pans it when dragged.
 *
 * It is a CAMERA control, so it measures the hand rather than the canvas — the
 * same rate the orbit gesture and the noodletool use — while the pan handle in
 * the middle measures the canvas, because the model has to stay under the
 * pointer while you slide it. That is the same split the part drag makes, for
 * the same reason.
 *
 * Panning writes `vx`/`vy`, the view offset in src/js/core/sdf.js: the world
 * point the centre of the frame looks at. It is a real render parameter rather
 * than a tool-only convenience, which is what lets the sheet crop a sprite
 * tight around art that is not centred (see fit.js).
 */
const TAU = Math.PI * 2;
export const SIZE = 62;          // the widget's box, in overlay pixels
const PAD = 8;
const AXIS_COL = ['#e5566a', '#6ad06a', '#5a9df5'];

/** Where the widget sits in an overlay of `w` x `h`: bottom left, out of the
 * way of the part gizmo, which lives on the model in the middle. */
export const box = (w, h) => ({ x: PAD, y: h - SIZE - PAD, s: SIZE });

export const inside = (w, h, x, y) => {
  const b = box(w, h);
  return x >= b.x && x < b.x + b.s && y >= b.y && y < b.y + b.s;
};

/** True when the pointer is on the middle handle, which pans rather than
 * orbits. */
export function onPan(w, h, x, y) {
  const b = box(w, h);
  return Math.hypot(x - (b.x + b.s / 2), y - (b.y + b.s / 2)) < 9;
}

/**
 * Draw the cross. The three world axes are projected with the same camera the
 * render uses, so what it shows is what the picture is doing.
 */
export function draw(ctx, w, h, view) {
  const b = box(w, h);
  const cx = b.x + b.s / 2, cy = b.y + b.s / 2, r = b.s / 2 - 8;
  const { yaw = 0, pitch = 0 } = view;
  const cyaw = Math.cos(yaw * TAU), syaw = Math.sin(yaw * TAU);
  const cp = Math.cos(pitch * TAU), sp = Math.sin(pitch * TAU);
  const right = [cyaw, 0, -syaw], up = [syaw * sp, cp, cyaw * sp];
  const fwd = [syaw * cp, -sp, cyaw * cp];

  ctx.save();
  ctx.fillStyle = 'rgba(20,22,26,0.72)';
  ctx.strokeStyle = '#3a3f47';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.roundRect(b.x + 0.5, b.y + 0.5, b.s - 1, b.s - 1, 6);
  ctx.fill();
  ctx.stroke();

  const world = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  // Behind first, so a nearer axis is drawn over a further one and the cross
  // reads as a solid object rather than a flat diagram.
  const order = [0, 1, 2].sort((a, c) =>
    (world[c][0] * fwd[0] + world[c][1] * fwd[1] + world[c][2] * fwd[2])
    - (world[a][0] * fwd[0] + world[a][1] * fwd[1] + world[a][2] * fwd[2]));
  ctx.lineWidth = 2;
  for (const k of order) {
    const a = world[k];
    const sx = (a[0] * right[0] + a[1] * right[1] + a[2] * right[2]) * r;
    const sy = -(a[0] * up[0] + a[1] * up[1] + a[2] * up[2]) * r;
    ctx.strokeStyle = ctx.fillStyle = AXIS_COL[k];
    ctx.globalAlpha = (a[0] * fwd[0] + a[1] * fwd[1] + a[2] * fwd[2]) > 0 ? 0.4 : 1;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + sx, cy + sy);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx + sx, cy + sy, 3, 0, TAU);
    ctx.fill();
  }

  // The pan handle, in the middle where all three axes meet.
  ctx.globalAlpha = 1;
  ctx.strokeStyle = '#cfd3da';
  ctx.fillStyle = 'rgba(207,211,218,0.2)';
  ctx.beginPath();
  ctx.arc(cx, cy, 6, 0, TAU);
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}
