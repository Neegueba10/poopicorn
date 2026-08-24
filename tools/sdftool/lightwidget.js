/**
 * The two light widgets: a sun on a sphere around the model, dragged to aim.
 *
 * A LIGHT IS A DIRECTION, so it has two degrees of freedom and does not get the
 * part gizmo's three arms. It gets one glyph, and the glyph STAYS UNDER THE
 * POINTER — the same contract a part drag has, and for the same reason: the
 * camera is orthographic, so the screen-to-sphere mapping is exact.
 *
 * IT IS AN ARCBALL, not a plane drag. The pointer picks the point of the
 * sphere under it, and the light turns by the rotation that carries the point
 * grabbed to the point now under the pointer. Grabbing a sun slightly off
 * centre therefore keeps that offset instead of snapping, and a sun released
 * outside the silhouette rides the rim rather than flying off.
 *
 * THE HEMISPHERE IS HELD, NOT DERIVED. Two points of the sphere project to
 * every pixel — one in front and one behind — so a drag alone can never take a
 * light round the back; it would have to pass through the rim and pick the
 * other root, which reads as the light jumping. So a drag keeps the side the
 * light started on, and `flip` is how it changes sides: mirror through the
 * camera plane, same place on screen, other side of the model. That is the
 * gesture a rim light is made with.
 *
 * The glyph is DIMMED when the light is behind the model, which is how you see
 * at a glance that you have made a rim rather than a key.
 *
 * Geometry and drawing only — this module never touches the document.
 * canvas.js owns the pointer and writes the dials, because it owns undo.
 */
const TAU = Math.PI * 2;

/** How far out the marker sits, in bounding radii. Far enough to clear the
 * model, near enough to stay in the pane at a normal zoom. */
export const ORBIT = 1.45;
export const GRAB = 11;

/** A unit vector. Matches the renderer's own guard: three zeroes stay three
 * zeroes rather than becoming NaN. */
export function unit(v) {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

/**
 * The camera basis sdf.js's begin() builds, from a view's `yaw` and `pitch`.
 */
export function camBasis({ yaw = 0, pitch = 0 } = {}) {
  const cy = Math.cos(yaw * TAU), sy = Math.sin(yaw * TAU);
  const cp = Math.cos(pitch * TAU), sp = Math.sin(pitch * TAU);
  return { r: [cy, 0, -sy], u: [sy * sp, cp, cy * sp], f: [sy * cp, -sp, cy * cp] };
}

/**
 * A CAMERA-SPACE light direction in world space, and back.
 *
 * Under the view's `lcam` the dials are aimed against the screen — x right, y
 * up, z toward the viewer — so the sun stays where you put it while you orbit,
 * and a facing set is lit from one side. The widgets work in world space
 * throughout, so `toWorld` is what they read a dial through and `toCam` is what
 * they write one back through. Both are the identity while `lcam` is off, which
 * is what keeps every model authored before it unchanged.
 */
export const toWorld = (d, view) => {
  if (!view || !view.lcam) return d;
  const { r, u, f } = camBasis(view);
  return r.map((v, i) => v * d[0] + u[i] * d[1] + f[i] * d[2]);
};

export const toCam = (d, view) => {
  if (!view || !view.lcam) return d;
  const b = camBasis(view);
  return [b.r, b.u, b.f].map(a => a[0] * d[0] + a[1] * d[1] + a[2] * d[2]);
};

/**
 * Where a light's glyph is, in overlay pixels.
 *
 * @param {number[]} dir the light direction, toward the light
 * @param {number} br the model's bounding radius
 * @param {(x, y, z) => [number, number]} proj world point to overlay pixel
 * @param {number[]} fwd the camera's forward vector
 */
export function place(dir, br, proj, fwd) {
  const d = unit(dir);
  const r = br * ORBIT;
  const [x, y] = proj(d[0] * r, d[1] * r, d[2] * r);
  const [cx, cy] = proj(0, 0, 0);
  // The light is behind the model when its direction runs away from the camera.
  return { x, y, cx, cy, dir: d, behind: d[0] * fwd[0] + d[1] * fwd[1] + d[2] * fwd[2] > 0 };
}

/** True when (x, y) grabs this glyph. */
export const hit = (g, x, y) => (g.x - x) ** 2 + (g.y - y) ** 2 <= GRAB * GRAB;

/**
 * The unit direction of the sphere point under the pointer.
 *
 * @param {number[]} o the world point under the pointer on the camera's own
 *   plane through the origin — orthographic, so this is exact
 * @param {number[]} f the camera's forward vector
 * @param {number} r the sphere's radius
 * @param {number} sign +1 for the far root, -1 for the near one. Held across a
 *   drag; see the note at the top.
 *
 * Outside the silhouette there is no root at all, and the honest answer is the
 * rim: the direction stays under the pointer as far as the sphere reaches, and
 * a wild drag parks the light on the edge instead of somewhere arbitrary.
 */
export function onSphere(o, f, r, sign) {
  const d2 = o[0] * o[0] + o[1] * o[1] + o[2] * o[2];
  if (d2 >= r * r || d2 < 1e-12) return unit(d2 < 1e-12 ? f.map(v => -v) : o);
  const w = Math.sqrt(r * r - d2) * sign;
  return unit([o[0] + f[0] * w, o[1] + f[1] * w, o[2] + f[2] * w]);
}

/** Which root of the sphere a direction is on: +1 behind, -1 in front. */
export const sideOf = (dir, f) =>
  (dir[0] * f[0] + dir[1] * f[1] + dir[2] * f[2]) >= 0 ? 1 : -1;

/**
 * `dir`, turned by the rotation that carries `a` onto `b`.
 *
 * This is what keeps the grab offset: the light is not moved TO the pointer, it
 * is turned by the same amount the pointer turned. `fine` scales the angle, so
 * shift-drag is a slower turn rather than a different gesture.
 */
export function turn(dir, a, b, fine = 1) {
  const d = unit(dir);
  let ax = a[1] * b[2] - a[2] * b[1];
  let ay = a[2] * b[0] - a[0] * b[2];
  let az = a[0] * b[1] - a[1] * b[0];
  const s = Math.hypot(ax, ay, az), c = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  if (s < 1e-9) return c >= 0 ? d : [-d[0], -d[1], -d[2]];
  ax /= s; ay /= s; az /= s;
  const ang = Math.atan2(s, c) * fine;
  const ca = Math.cos(ang), sa = Math.sin(ang);
  // Rodrigues: v cos + (k x v) sin + k (k·v)(1 - cos).
  const kx = ay * d[2] - az * d[1];
  const ky = az * d[0] - ax * d[2];
  const kz = ax * d[1] - ay * d[0];
  const kd = (ax * d[0] + ay * d[1] + az * d[2]) * (1 - ca);
  return unit([
    d[0] * ca + kx * sa + ax * kd,
    d[1] * ca + ky * sa + ay * kd,
    d[2] * ca + kz * sa + az * kd,
  ]);
}

/**
 * The same place on screen, the other side of the model.
 *
 * A mirror through the camera plane, which under an orthographic camera leaves
 * the projection exactly where it was and only changes the depth. Aim the light
 * where you want it and flip it: that is a rim.
 */
export function flip(dir, f) {
  const d = unit(dir);
  const k = d[0] * f[0] + d[1] * f[1] + d[2] * f[2];
  // EDGE-ON HAS NO SIDE TO MIRROR, and a light parked on the rim by a long drag
  // is exactly where you reach for this button. Mirroring there is the identity
  // and reads as a dead control, so take "flip" at its word and push it behind.
  // The next press mirrors normally and brings it back.
  if (Math.abs(k) < 0.02) return unit([d[0] + f[0] * 0.06, d[1] + f[1] * 0.06, d[2] + f[2] * 0.06]);
  return unit([d[0] - 2 * k * f[0], d[1] - 2 * k * f[1], d[2] - 2 * k * f[2]]);
}

/**
 * Draw one sun. `col` is the light's own colour as [r, g, b] 0..1, so the
 * viewport says what colour the light is where the light is. `lit` is whether
 * this light has any strength left — a light turned down to nothing is drawn
 * hollow and without rays, so it is still there to grab and clearly doing
 * nothing.
 */
export function draw(ctx, g, col, lit, active) {
  const rgb = `rgb(${col.map(v => Math.round(Math.max(0, Math.min(1, v)) * 255)).join(',')})`;
  const alpha = active ? 1 : g.behind ? 0.4 : 0.85;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = lit ? '#fff' : '#8b939e';
  ctx.fillStyle = lit ? rgb : 'rgba(40,44,50,0.8)';

  // A line back to the model, so a glyph near the edge still reads as a
  // direction rather than as a stray dot.
  ctx.globalAlpha = alpha * 0.35;
  ctx.beginPath();
  ctx.moveTo(g.x, g.y);
  ctx.lineTo(g.cx, g.cy);
  ctx.stroke();
  ctx.globalAlpha = alpha;

  ctx.beginPath();
  ctx.arc(g.x, g.y, 6, 0, TAU);
  ctx.fill();
  ctx.stroke();
  // Rays only while the light has strength left. A light turned down to nothing
  // is drawn hollow: still there to grab, and clearly doing nothing.
  if (lit) {
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * TAU;
      ctx.beginPath();
      ctx.moveTo(g.x + Math.cos(a) * 8, g.y + Math.sin(a) * 8);
      ctx.lineTo(g.x + Math.cos(a) * 11, g.y + Math.sin(a) * 11);
      ctx.stroke();
    }
  }
  ctx.restore();
}
