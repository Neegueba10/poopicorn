/**
 * Fit: the smallest frame that still holds the whole model, at a given view.
 *
 * A sprite is square by default because the frame is square, not because the
 * art is. A lamp post, a plank, a coin on edge — each wastes most of its rect,
 * and a sheet of them wastes most of its page and most of its bake time (cost
 * is per pixel, including the empty ones).
 *
 * TWO NUMBERS MAKE IT POSSIBLE, and only one of them is new. `w` and `h` were
 * always independent; what was missing is that the frame always looked at the
 * model's ORIGIN, so cropping tight around art that sits off-centre cropped the
 * art. `vx`/`vy` in src/js/core/sdf.js move what the centre of the frame looks
 * at, and this file works out where that should be.
 *
 * IT IS ANALYTIC, NOT MEASURED. The bounds come from each part's own box,
 * rotated and projected onto the camera's right and up vectors, rather than
 * from rendering and scanning for ink. That makes it instant, deterministic,
 * and available before a single ray has been marched.
 *
 * THE RENDERER'S OWN `bound()` IS NO USE HERE, and the reason is the whole
 * point of the feature: it unions bounding SPHERES, so a capsule 0.16 wide and
 * 2 tall bounds to a 2x2 square and fits to a square sprite — the exact case
 * this exists to fix. So each primitive's box is written out below. That
 * duplicates knowledge from `prim()` in src/js/core/sdf.js and can drift from
 * it, which is why tests/sdftool/test-fit.mjs renders every primitive and
 * asserts no ink falls outside the box predicted for it. Change one, run that.
 */
import { STRIDE, PAINT, MIRROR } from './state.js';
// Resolves to /src/js/core/sdf.js in the browser and to the file on disk in
// Node, so this module stays usable from the pure-Node fit suite.
import { expand } from '../../src/js/core/sdf.js';

const TAU = Math.PI * 2;

/** The camera's right and up vectors, matching sdf.js's begin() exactly. */
export function camera(view = {}) {
  const { yaw = 0, pitch = 0 } = view;
  const cy = Math.cos(yaw * TAU), sy = Math.sin(yaw * TAU);
  const cp = Math.cos(pitch * TAU), sp = Math.sin(pitch * TAU);
  return { r: [cy, 0, -sy], u: [sy * sp, cp, cy * sp] };
}

/**
 * How far the part reaches from its own origin along the unit direction `d`,
 * in its OWN frame — the shape's support function.
 *
 * A SUPPORT FUNCTION, NOT A BOX, and the difference is the feature. A box
 * around a sphere is a cube, and a cube seen corner-on is 1.7x wider than the
 * sphere in it, so box-based bounds fatten every round shape at most angles.
 * Every primitive here is a simple core — a point, a segment, a ring, a
 * polygon — dilated by `r`, so the exact support is the core's plus `r`, and
 * that is both tighter and no harder to write.
 *
 * It is also naturally ASYMMETRIC, which two primitives need: the pyramid
 * grows from a base below its origin toward an apex at it, and the triangular
 * prism's apex is further out than its base. The caller asks along +d and -d.
 */
export function supportLocal(kind, a, b, c, r, d) {
  const [x, y, z] = d;
  const ax = Math.abs(x), ay = Math.abs(y), az = Math.abs(z);
  const hxz = Math.hypot(x, z);       // in-plane length, for the XZ shapes
  switch (kind) {
    case 0: return r;                                       // sphere: a point
    case 1: return a * ax + b * ay + c * az + r;            // box
    case 2: return Math.abs(a * x + b * y + c * z) + r;     // capsule: a segment
    case 3: return a * hxz + r;                             // torus: a ring in XZ
    case 4: return a * hxz + b * ay + r;                    // cylinder: disc x segment
    // Cone: the hull of two circles, radius a at y = -b and c at y = +b.
    case 5: return Math.max(a * hxz - b * y, c * hxz + b * y) + r;
    // Octahedron: its r rounds the PLANE distance, so the vertices sit at
    // a + r*sqrt(3) on the axes rather than a + r.
    case 6: return (a + r * 1.7320508) * Math.max(ax, ay, az);
    // Hex prism: a hexagon in XZ with apothem a — corners at a/cos(30) on x —
    // times a segment in Y.
    case 7: return Math.max(1.1547005 * a * ax, 0.5773503 * a * ax + a * az)
      + b * ay + r;
    case 8: return Math.hypot(a * x, b * y, c * z);         // ellipsoid: the radii
    case 9: return b * Math.hypot(x, y) + a * ay + r;       // link: a ring stretched in Y
    // Pyramid: the hull of a square base of half-width a at y = -b and an apex
    // at the origin. The max with 0 IS the apex.
    case 10: return Math.max(0, a * ax + a * az - b * y) + r;
    // Capped torus: an ARC of a ring in XY, centred on +Y and spanning +/- the
    // cap angle, whose sine and cosine are b and c. Bounding the whole ring
    // instead would be correct and twice too big on a short arc — which is the
    // shape anyone reaches for this primitive to make.
    case 11: {
      const l = Math.hypot(b, c) || 1;                      // the pair may be unnormalised
      const cap = Math.atan2(Math.abs(b) / l, c / l);
      const t = Math.atan2(x, y);                           // where the unconstrained max is
      const at = Math.abs(t) <= cap ? Math.abs(t) : cap;
      const sgn = t < 0 ? -1 : 1;
      return a * (Math.sin(sgn * at) * x + Math.cos(at) * y) + r;
    }
    // Triangular prism: a triangle in XY, apex at y = a, base at y = -a/2,
    // times a segment in Z.
    case 12: return Math.max(a * y, 0.8660254 * a * ax - 0.5 * a * y)
      + b * az + r;
    default: return null;                                   // plane: infinite
  }
}

/** The part's rotation as local->world, columns first: `[colX, colY, colZ]`.
 * The transpose of what prepRot packs, which is world->local. */
export function partAxes(parts, i) {
  const rx = parts[i + 4], ry = parts[i + 5], rz = parts[i + 6];
  if (!rx && !ry && !rz) return [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  const sx = Math.sin(rx * TAU), cx = Math.cos(rx * TAU);
  const sy = Math.sin(ry * TAU), cy = Math.cos(ry * TAU);
  const sz = Math.sin(rz * TAU), cz = Math.cos(rz * TAU);
  return [
    [cz * cy, sz * cy, -sy],
    [cz * sy * sx - sz * cx, sz * sy * sx + cz * cx, cy * sx],
    [cz * sy * cx + sz * sx, sz * sy * cx - cz * sx, cy * cx],
  ];
}

const dot = (p, q) => p[0] * q[0] + p[1] * q[1] + p[2] * q[2];

/**
 * The model's extent in camera space: `[minU, maxU, minV, maxV]` in world
 * units, or null when there is nothing to bound.
 *
 * PAINT parts and planes are skipped for the same reasons `bound()` skips
 * them: paint has no silhouette, and a plane is infinite.
 */
export function projectedBounds(parts, view) {
  // A SCATTER header is not a shape and its instances are not rows yet, so the
  // frame is measured against what the renderer will actually march. Fitting
  // the authored rows would crop a mass to its template.
  parts = expand(parts);
  const { r, u } = camera(view);
  let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
  for (let i = 0; i < parts.length; i += STRIDE) {
    if (parts[i] & PAINT) continue;
    const kind = parts[i] & 31;
    const a = parts[i + 7], b = parts[i + 8], c = parts[i + 9];
    // The rounding, plus the blend: a smooth union pushes the surface out by
    // roughly its softness, and that is the allowance bound() makes too.
    const rr = parts[i + 10] + Math.max(0, parts[i + 11]);
    if (supportLocal(kind, a, b, c, rr, [1, 0, 0]) == null) continue;   // a plane
    const ax = partAxes(parts, i);
    const cw = [parts[i + 1], parts[i + 2], parts[i + 3]];
    // The camera direction, taken into the part's own frame — a rotation's
    // inverse is its transpose, so this is a dot with each column.
    const reach = d => {
      const dl = [dot(ax[0], d), dot(ax[1], d), dot(ax[2], d)];
      return supportLocal(kind, a, b, c, rr, dl);
    };
    const span = d => {
      const cd = dot(cw, d);
      return [cd - reach([-d[0], -d[1], -d[2]]), cd + reach(d)];
    };
    const eat = (d, horiz) => {
      const [lo, hi] = span(d);
      if (horiz) {
        if (lo < minU) minU = lo;
        if (hi > maxU) maxU = hi;
      } else {
        if (lo < minV) minV = lo;
        if (hi > maxV) maxV = hi;
      }
    };
    eat(r, 1);
    eat(u, 0);
    // A MIRRORED part is two shapes, and the second one is measured for free.
    // The copy is the original reflected by M = diag(-1, 1, 1), and the support
    // of a reflected shape along `d` is the original's support along `Md` — so
    // the copy's extent is this part's own, computed with x negated. Without it
    // a symmetric model fits to half of itself and the sheet crops the art off.
    if (parts[i] & MIRROR) {
      eat([-r[0], r[1], r[2]], 1);
      eat([-u[0], u[1], u[2]], 0);
    }
  }
  return minU === Infinity ? null : [minU, maxU, minV, maxV];
}

/**
 * The frame that wraps `parts` at `view`, with the longest side `max` pixels.
 *
 * Returns `{ w, h, scale, vx, vy }` — everything a sheet slot needs, including
 * `scale`, because the renderer reads scale as world units across the SHORT
 * axis and that meaning moves when the aspect does.
 *
 * @param {number[]} parts
 * @param {object} view
 * @param {object} [opts]
 * @param {number} [opts.max] longest side, in pixels
 * @param {number} [opts.pad] pixels of margin on every side
 * @param {number} [opts.grid] round both sides up to a multiple of this
 */
export function fitFrame(parts, view, opts = {}) {
  const b = projectedBounds(parts, view);
  return b && frameFor(b, opts);
}

/**
 * The same, from bounds someone else worked out — so several sprites can share
 * one frame by unioning their bounds first (see fitSlots in sheet.js).
 */
export function frameFor(bounds, opts = {}) {
  const max = Math.max(1, opts.max ?? 48);
  const pad = opts.pad ?? 1;
  const grid = Math.max(1, opts.grid ?? 1);
  const [minU, maxU, minV, maxV] = bounds;
  const extU = Math.max(maxU - minU, 1e-6), extV = Math.max(maxV - minV, 1e-6);

  // World units per pixel, chosen so the longer side lands on `max` pixels
  // INCLUDING the padding — `max` is the sprite you asked for, not the art
  // inside it.
  const d = Math.max(extU, extV) / Math.max(1, max - pad * 2);
  const up = n => Math.ceil(n / grid) * grid;
  const w = Math.max(grid, up(Math.ceil(extU / d) + pad * 2));
  const h = Math.max(grid, up(Math.ceil(extV / d) + pad * 2));

  return {
    w,
    h,
    // The renderer divides by min(w, h), so this is what keeps the density at
    // `d` whichever way round the frame ends up.
    scale: +(d * Math.min(w, h)).toFixed(4),
    vx: +((minU + maxU) / 2).toFixed(4),
    vy: +((minV + maxV) / 2).toFixed(4),
  };
}
