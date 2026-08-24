/**
 * sdf.js — signed-distance-field assets, rendered to palette indices.
 *
 * A model is a short list of primitives combined with smooth union and
 * subtraction. Rendering marches a ray per pixel until the field goes small,
 * then shades from the gradient. Why this rather than a rasteriser: ambient
 * occlusion is four extra
 * field evaluations here and is the single biggest reason a render reads as
 * pre-rendered.
 *
 * PORTABILITY CONTRACT, the same terms as noodle.js: this imports ONE sibling,
 * core/quant.js, and nothing else. No DOM, no assumed palette, no assumed
 * resolution. It runs in a Worker and in Node. Its whole input is
 * (w, h, paletteRGB, model, materials, view) and its whole output is a
 * Uint8Array of palette indices. Host adapters live elsewhere.
 *
 * THE SURFACE IS DELIBERATELY NOODLE'S — begin/step/done/col — so the worker,
 * the pool and the progressive boot bake drive either renderer without
 * knowing which they have.
 *
 * ORTHOGRAPHIC on purpose. Pre-rendered sprite art is orthographic, which is
 * most of why it reads as pre-rendered, and it costs less code than
 * perspective: one ray direction for the whole frame, no divide, no near
 * plane, no clipping.
 */
import { buildRgbLut, BAYER } from './quant.js';

const TAU = Math.PI * 2;

//==============================================================================
// THE MODEL FORMAT
//==============================================================================
/**
 * A model is a flat numeric array, STRIDE 13, one row per part:
 *
 *   [kind, x, y, z, rx, ry, rz, a, b, c, round, blend, mat]
 *
 *   kind    the primitive in the low 5 bits, plus flags:
 *             +32 SUBTRACT — remove this part from everything before it
 *             +64 PAINT    — colour only. Blends into the material field and
 *                            leaves the SHAPE untouched, so a volume can tint
 *                            part of a solid without denting it.
 *            +128 MIRROR   — fold the sample across x = 0 before evaluating,
 *                            so one row is a symmetric pair. See below.
 *            +256 SCATTER  — not a shape: a header that copies the row after it
 *                            N times with jittered numbers. See expand().
 *   x y z   centre
 *   rx ry rz  rotation about the part's own centre, in TURNS
 *   a b c   the primitive's dimensions — see PRIMS below, they differ per kind
 *   round   the radius that rounds it: a sphere's, a box's corner, a capsule's
 *   blend   smooth-union softness against everything before it; 0 is a hard
 *           join. For a PAINT part it is the distance its colour reaches.
 *   mat     index into the materials array of [r, g, b], 0..1
 *
 * Flat and numeric for the reason every format in this repo is: it packs, it
 * compresses, and needs no decoder.
 *
 * Order matters — parts blend against the accumulated field, not pairwise — so
 * a part's id is its row index and the tool owns it.
 *
 * WHY ONE SWITCH RATHER THAN IMPORTED PRIMITIVES. Tree-shaking them was
 * measured and rejected: a primitive costs 31 B gzipped as a switch case, so
 * the whole library is about 500 B, while dispatching through a table of
 * functions made a render 76-155% slower. One call site taking fourteen
 * different functions is megamorphic, and this runs about ten times per pixel
 * (the march, four normal taps, four occlusion taps). Cheap to ship, expensive
 * to dispatch — so they all ship.
 */
export const STRIDE = 13;

/** kind flags */
export const SUBTRACT = 32, PAINT = 64, MIRROR = 128, SCATTER = 256;

/**
 * MIRROR: `x -> |x|` before the part is evaluated. One row, two shapes.
 *
 * THE FOLD IS EXACT. `|x|` is an isometry on each half of space, so the result
 * is still a true signed distance and sphere tracing stays safe. That is why
 * symmetry is domain math here rather than a duplicated row: it costs one
 * operation per part per sample and no data at all.
 *
 * WHAT IT PRODUCES IS THE x >= 0 HALF, MIRRORED — not the union of the part
 * and its mirror image. The two differ only for a part that crosses the plane,
 * and the difference is the useful case: a leaning capsule centred on x = 0
 * folds into a chevron, which is a pair of horns from one row. The cost is that
 * an asymmetric part straddling the plane creases at it.
 *
 * The fold is in WORLD space, before the centre is subtracted and before the
 * part's own rotation — so the copy mirrors its rotation too, which is what
 * symmetry means. It also means a mirrored part with a negative x VANISHES:
 * its x >= 0 half is empty, so there is nothing to mirror. Taking |m[i + 1]|
 * as well would fix that and would put a second abs in the hottest loop in the
 * project, so the editor clamps x at 0 instead.
 */

/** A unit vector, as a plain array. A zero vector comes back unchanged rather
 * than as NaN — a scrubber in the editor can put three zeroes in a direction. */
function norm(x, y, z) {
  const l = Math.hypot(x, y, z) || 1;
  return [x / l, y / l, z / l];
}

/** Polynomial smooth minimum. k <= 0 is a plain union. */
function smin(a, b, k) {
  if (k <= 0) return a < b ? a : b;
  const h = Math.max(0, Math.min(1, 0.5 + 0.5 * (b - a) / k));
  return b * (1 - h) + a * h - k * h * (1 - h);
}

/**
 * The primitive library. `a b c` mean different things per kind, and the tool's
 * inspector labels them from this same list:
 *
 *   0  sphere       —              round = radius
 *   1  box          a b c = half extents,        round = corner
 *   2  capsule      a b c = half axis,           round = radius
 *   3  torus        a = major radius (XZ),       round = minor
 *   4  cylinder     a = radius, b = half height, round = corner
 *   5  cone         a = base radius, b = half height, c = top radius
 *   6  octahedron   a = size,                    round
 *   7  hex prism    a = radius, b = half depth,  round
 *   8  ellipsoid    a b c = radii
 *   9  link         a = half length, b = ring radius, round = tube
 *   10 pyramid      a = half base, b = height,   round
 *   11 capped torus a = major, b c = sin/cos of the cap angle, round = minor
 *   12 tri prism    a = size, b = half depth,    round
 *   13 plane        a b c = normal, round = distance from the centre
 *
 * Every one of these is a CONSERVATIVE distance — it never over-estimates —
 * because sphere tracing steps by whatever the field returns. An over-estimate
 * steps through the surface and the model grows holes. The ellipsoid and the
 * octahedron are bounds rather than exact distances for exactly that reason.
 *
 * Adapted from Inigo Quilez's catalogue: https://iquilezles.org/articles/distfunctions/
 */
function prim(kind, px, py, pz, a, b, c, r) {
  switch (kind) {
    case 0:
      return Math.sqrt(px * px + py * py + pz * pz) - r;
    case 1: {
      const qx = Math.abs(px) - a, qy = Math.abs(py) - b, qz = Math.abs(pz) - c;
      const ox = qx > 0 ? qx : 0, oy = qy > 0 ? qy : 0, oz = qz > 0 ? qz : 0;
      return Math.sqrt(ox * ox + oy * oy + oz * oz)
        + Math.min(Math.max(qx, Math.max(qy, qz)), 0) - r;
    }
    case 2: {
      // Segment from -(a,b,c) to +(a,b,c) about the centre.
      const hh = a * a + b * b + c * c;
      let t = hh > 0 ? (px * a + py * b + pz * c) / hh : 0;
      t = t < -1 ? -1 : t > 1 ? 1 : t;
      const dx = px - a * t, dy = py - b * t, dz = pz - c * t;
      return Math.sqrt(dx * dx + dy * dy + dz * dz) - r;
    }
    case 3: {
      const q = Math.sqrt(px * px + pz * pz) - a;
      return Math.sqrt(q * q + py * py) - r;
    }
    case 4: {
      const dx = Math.sqrt(px * px + pz * pz) - a, dy = Math.abs(py) - b;
      const ox = dx > 0 ? dx : 0, oy = dy > 0 ? dy : 0;
      return Math.min(Math.max(dx, dy), 0) + Math.sqrt(ox * ox + oy * oy) - r;
    }
    case 5: {
      // Capped cone: radius a at the bottom, c at the top, half height b. c = 0
      // is a point, c = a is a cylinder — one primitive covers the family.
      const qx = Math.sqrt(px * px + pz * pz), qy = py;
      const k1x = c, k1y = b;
      const k2x = c - a, k2y = 2 * b;
      const cax = qx - Math.min(qx, qy < 0 ? a : c), cay = Math.abs(qy) - b;
      const dk = k2x * k2x + k2y * k2y;
      let t = dk > 0 ? ((k1x - qx) * k2x + (k1y - qy) * k2y) / dk : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const cbx = qx - k1x + k2x * t, cby = qy - k1y + k2y * t;
      const sgn = (cbx < 0 && cay < 0) ? -1 : 1;
      return sgn * Math.sqrt(Math.min(cax * cax + cay * cay, cbx * cbx + cby * cby)) - r;
    }
    case 6:
      return (Math.abs(px) + Math.abs(py) + Math.abs(pz) - a) * 0.57735027 - r;
    case 7: {
      const qx = Math.abs(px), qy = Math.abs(py), qz = Math.abs(pz);
      const d1 = Math.max(qx * 0.8660254 + qz * 0.5, qz) - a;
      const d2 = qy - b;
      const o1 = d1 > 0 ? d1 : 0, o2 = d2 > 0 ? d2 : 0;
      return Math.min(Math.max(d1, d2), 0) + Math.sqrt(o1 * o1 + o2 * o2) - r;
    }
    case 8: {
      // A bound, not an exact distance, and it under-estimates — safe to march.
      const k0 = Math.sqrt((px / a) ** 2 + (py / b) ** 2 + (pz / c) ** 2);
      if (k0 < 1e-9) return -Math.min(a, Math.min(b, c));
      const k1 = Math.sqrt((px / (a * a)) ** 2 + (py / (b * b)) ** 2 + (pz / (c * c)) ** 2);
      return k0 * (k0 - 1) / k1;
    }
    case 9: {
      const qy = Math.max(Math.abs(py) - a, 0);
      const q = Math.sqrt(px * px + qy * qy) - b;
      return Math.sqrt(q * q + pz * pz) - r;
    }
    case 10: {
      // Square base of half-width a, apex b above the centre.
      const qx = Math.abs(px), qz = Math.abs(pz);
      const m2 = Math.max(qx, qz) - a;
      const side = (m2 * b + (py + b) * a) / Math.sqrt(a * a + b * b);
      return Math.max(Math.max(side, -py - b), 0)
        + Math.min(Math.max(side, -py - b), 0) - r;
    }
    case 11: {
      // b and c are the sine and cosine of the cap angle, so they have to be a
      // UNIT pair — normalised here rather than trusted, because a scrubber in
      // the editor can put any two numbers in those slots, and an unnormalised
      // pair makes this over-estimate the distance. Sphere tracing then steps
      // straight through the surface and the shape fills with holes.
      const l = Math.hypot(b, c) || 1;
      const sn = b / l, cs = c / l;
      const qx = Math.abs(px);
      const k = (cs * qx > sn * py) ? (qx * sn + py * cs) : Math.sqrt(px * px + py * py);
      return Math.sqrt(Math.max(0, px * px + py * py + pz * pz + a * a - 2 * a * k)) - r;
    }
    case 12: {
      const qx = Math.abs(px), qy = Math.abs(py), qz = Math.abs(pz);
      return Math.max(qz - b, Math.max(qx * 0.8660254 + py * 0.5, -py) - a * 0.5) - r;
    }
    default: {
      // Infinite half-space. Useful for slicing a flat face off anything, and
      // the one primitive with no bounded extent — see bound().
      const l = Math.hypot(a, b, c) || 1;
      return (px * a + py * b + pz * c) / l - r;
    }
  }
}

/**
 * Distance from (x, y, z) to `m`.
 *
 * THE HOT LOOP of the whole renderer: once per march step, four times per lit
 * pixel for the normal, four more for occlusion. Nothing about colour happens
 * here — PAINT parts are skipped and materials are resolved once per hit pixel
 * by `shade()` — which is what lets material blending cost nothing.
 *
 * `rot` is the packed rotation matrices from `prepRot`, or null when no part is
 * rotated. Passed rather than held in module scope so a caller with a slice of
 * one part (the editor's hit test) can pass its own.
 */
export function map(m, x, y, z, rot) {
  let d = 1e9;
  for (let i = 0, p = 0; i < m.length; i += STRIDE, p++) {
    const kind = m[i];
    if (kind & PAINT) continue;              // colour only: no shape
    // The mirror fold, before everything else. See MIRROR above.
    let px = (kind & MIRROR ? Math.abs(x) : x) - m[i + 1];
    let py = y - m[i + 2], pz = z - m[i + 3];
    if (rot && rot[p * 10 + 9]) {
      const o = p * 10;
      const tx = px, ty = py, tz = pz;
      px = rot[o] * tx + rot[o + 1] * ty + rot[o + 2] * tz;
      py = rot[o + 3] * tx + rot[o + 4] * ty + rot[o + 5] * tz;
      pz = rot[o + 6] * tx + rot[o + 7] * ty + rot[o + 8] * tz;
    }
    // THE FOUR COMMON PRIMITIVES ARE INLINED HERE, and the other ten are a
    // call. That is not a style choice, it is the second-largest speed lever in
    // the file. `prim` has fourteen cases and is far too big for V8 to inline,
    // so routing every evaluation through it made a render 2.3x slower — and
    // this runs about ten times per pixel. Measured, at 96x96:
    //
    //   all through prim()      26.4 ms   3,321 B
    //   whole switch inlined    11.9 ms   3,847 B
    //   these four inlined      11.5 ms   3,489 B   <- this
    //
    // Duplicating four primitives buys back all of the speed for a third of the
    // bytes, and a model built from exotic shapes pays the call — which is the
    // right place for the cost. Keep these four in step with `prim`.
    const a = m[i + 7], b = m[i + 8], c = m[i + 9], r = m[i + 10];
    const kk = kind & 31;
    let s;
    if (kk === 0) s = Math.sqrt(px * px + py * py + pz * pz) - r;
    else if (kk === 1) {
      const qx = Math.abs(px) - a, qy = Math.abs(py) - b, qz = Math.abs(pz) - c;
      const ox = qx > 0 ? qx : 0, oy = qy > 0 ? qy : 0, oz = qz > 0 ? qz : 0;
      s = Math.sqrt(ox * ox + oy * oy + oz * oz)
        + Math.min(Math.max(qx, Math.max(qy, qz)), 0) - r;
    } else if (kk === 2) {
      const hh = a * a + b * b + c * c;
      let t = hh > 0 ? (px * a + py * b + pz * c) / hh : 0;
      t = t < -1 ? -1 : t > 1 ? 1 : t;
      const dx = px - a * t, dy = py - b * t, dz = pz - c * t;
      s = Math.sqrt(dx * dx + dy * dy + dz * dz) - r;
    } else if (kk === 3) {
      const q = Math.sqrt(px * px + pz * pz) - a;
      s = Math.sqrt(q * q + py * py) - r;
    } else s = prim(kk, px, py, pz, a, b, c, r);

    const k = m[i + 11];
    if (kind & SUBTRACT) {
      // Subtract: the smooth max of what we have against -s.
      //
      // The mix arguments are mix(d, -s, h) and NOT mix(-s, d, h). Writing
      // them the other way round inverts the operation so the CUT becomes the
      // object: every ray then hits on its first step and the sprite is a full
      // frame of flat colour. It renders, it is fast, and only looking at it
      // catches it.
      if (k > 0) {
        const h = Math.max(0, Math.min(1, 0.5 - 0.5 * (d + s) / k));
        d = d * (1 - h) + (-s) * h + k * h * (1 - h);
      } else {
        d = d > -s ? d : -s;
      }
    } else {
      d = smin(d, s, k);
    }
  }
  return d;
}

/**
 * The blended material colour at (x, y, z), into `out` as [r, g, b].
 *
 * Materials melt together exactly as the shapes do: a part's colour is mixed in
 * with the SAME weight the smooth minimum gives its distance, so wherever two
 * parts merge into one surface their colours merge across the same seam. A
 * nearest-part rule puts a hard colour edge across a soft geometric join, and
 * it looks like a decal.
 *
 * Called ONCE per lit pixel rather than per march step, which is why it can
 * afford to do this at all.
 */
export function shade(m, mats, x, y, z, rot, out) {
  let d = 1e9, r = 1, g = 1, b = 1, first = 1;
  for (let i = 0, p = 0; i < m.length; i += STRIDE, p++) {
    const kind = m[i];
    // The same fold map() applies, or the mirrored half takes its colour from
    // the wrong side of the model and the material seam lands off the shape.
    let px = (kind & MIRROR ? Math.abs(x) : x) - m[i + 1];
    let py = y - m[i + 2], pz = z - m[i + 3];
    if (rot && rot[p * 10 + 9]) {
      const o = p * 10;
      const tx = px, ty = py, tz = pz;
      px = rot[o] * tx + rot[o + 1] * ty + rot[o + 2] * tz;
      py = rot[o + 3] * tx + rot[o + 4] * ty + rot[o + 5] * tz;
      pz = rot[o + 6] * tx + rot[o + 7] * ty + rot[o + 8] * tz;
    }
    const s = prim(kind & 31, px, py, pz, m[i + 7], m[i + 8], m[i + 9], m[i + 10]);
    const k = m[i + 11];
    const c3 = mats[m[i + 12]] || [1, 1, 1];

    if (kind & PAINT) {
      // Reaches `blend` beyond its own surface, at full strength inside it.
      const w = k > 0 ? Math.max(0, Math.min(1, 1 - s / k)) : (s <= 0 ? 1 : 0);
      if (w > 0) {
        r += (c3[0] - r) * w;
        g += (c3[1] - g) * w;
        b += (c3[2] - b) * w;
      }
      continue;
    }
    if (kind & SUBTRACT) {
      // A cut removes material; it does not paint. Keeping the distance in step
      // with map() matters, or later parts blend against the wrong field.
      if (k > 0) {
        const h = Math.max(0, Math.min(1, 0.5 - 0.5 * (d + s) / k));
        d = d * (1 - h) + (-s) * h + k * h * (1 - h);
      } else {
        d = d > -s ? d : -s;
      }
      continue;
    }
    // `h` is smin's own weight: 1 means the accumulated field wins, 0 means
    // this part does. So the new colour comes in at (1 - h).
    const h = first ? 0
      : k > 0 ? Math.max(0, Math.min(1, 0.5 + 0.5 * (s - d) / k))
        : (s < d ? 0 : 1);
    const w = 1 - h;
    r += (c3[0] - r) * w;
    g += (c3[1] - g) * w;
    b += (c3[2] - b) * w;
    d = first ? s : smin(d, s, k);
    first = 0;
  }
  out[0] = r;
  out[1] = g;
  out[2] = b;
}

/**
 * Pack every part's rotation as the matrix that takes a world offset into the
 * part's own frame, plus a flag saying whether it is worth applying.
 *
 * Ten floats a part — nine for the matrix, one flag — built ONCE per render
 * rather than per sample. Rotation is three sines and three cosines; doing that
 * inside the hot loop would cost more than every primitive put together.
 *
 * @returns {Float64Array|null} null when no part is rotated at all
 */
export function prepRot(m) {
  let any = 0;
  for (let i = 0; i < m.length; i += STRIDE) if (m[i + 4] || m[i + 5] || m[i + 6]) any = 1;
  if (!any) return null;
  const n = m.length / STRIDE;
  const out = new Float64Array(n * 10);
  for (let p = 0; p < n; p++) {
    const i = p * STRIDE, o = p * 10;
    const rx = m[i + 4], ry = m[i + 5], rz = m[i + 6];
    if (!rx && !ry && !rz) continue;
    const sx = Math.sin(rx * TAU), cx = Math.cos(rx * TAU);
    const sy = Math.sin(ry * TAU), cy = Math.cos(ry * TAU);
    const sz = Math.sin(rz * TAU), cz = Math.cos(rz * TAU);
    // R = Rz * Ry * Rx, then TRANSPOSED — a world point enters the part's frame
    // through the inverse, and for a rotation the inverse is the transpose.
    const m00 = cz * cy, m01 = cz * sy * sx - sz * cx, m02 = cz * sy * cx + sz * sx;
    const m10 = sz * cy, m11 = sz * sy * sx + cz * cx, m12 = sz * sy * cx - cz * sx;
    const m20 = -sy, m21 = cy * sx, m22 = cy * cx;
    out[o] = m00; out[o + 1] = m10; out[o + 2] = m20;
    out[o + 3] = m01; out[o + 4] = m11; out[o + 5] = m21;
    out[o + 6] = m02; out[o + 7] = m12; out[o + 8] = m22;
    out[o + 9] = 1;
  }
  return out;
}

/**
 * Bounding-sphere radius of `m` about the origin.
 *
 * A PAINT part has no shape to bound, and a PLANE is infinite — neither may
 * grow the sphere, or a model with a slicing plane would render its whole
 * bounding volume.
 *
 * A MIRRORED part needs nothing here: its copy sits at -x, the same distance
 * from the origin, so the sphere this measures already covers both.
 */
export function bound(m) {
  let br = 0;
  for (let i = 0; i < m.length; i += STRIDE) {
    if ((m[i] & PAINT) || (m[i] & 31) === 13) continue;
    const c = Math.hypot(m[i + 1], m[i + 2], m[i + 3]);
    const ext = Math.hypot(m[i + 7], m[i + 8], m[i + 9]) + m[i + 10] + m[i + 11];
    if (c + ext > br) br = c + ext;
  }
  return br + 0.05;
}

/**
 * Grow the SCATTER headers into real rows. Called ONCE per render, by begin().
 *
 * WHY NOT IN THE HOT LOOP. A mass of small parts could in principle be domain
 * math the way MIRROR is — but random per-instance numbers need a hash at every
 * sample, which costs more than the parts it saves and breaks the conservative
 * distance the march depends on. So a scatter pays once per render instead, and
 * `map` never learns it exists: an instance is an ordinary part row.
 *
 * A SCATTER IS TWO ROWS. The header carries the seed, the count and one spread
 * per column; the row after it is the TEMPLATE each instance is a jittered copy
 * of. The template is not drawn by itself, and its own flags — subtract, paint,
 * mirror — carry to every instance. That is where the composition comes from: a
 * mirrored template is a symmetric mass, a subtracted one is a field of pits.
 *
 *   header  [SCATTER, seed, count, sx, sy, sz, srot, sa, sb, sc, sround,
 *            sblend, smat]
 *
 *   seed    1..2147483646. Rerolling it changes the arrangement and nothing else
 *   count   how many instances. The SIGN picks the distribution: + a box,
 *           − an ellipsoid, which is the drawtool's own convention (op 5) and
 *           reads as an organic clump rather than a filled rectangle
 *   sx sy sz   position spread about the template's centre, half-extents
 *   srot    rotation spread in turns, rolled independently on all three axes.
 *           One number for three, because random rotation is one decision and
 *           the freed slot is what lets smat exist
 *   sa..sblend  ± spread on each dimension
 *   smat    choose from smat + 1 materials, starting at the template's own
 *
 * ONE ROW OF THIRTEEN NUMBERS REPLACES UP TO SIXTY. That is the whole feature:
 * a forty-piece rubble field costs 26 numbers rather than 520, and it is the
 * size playbook's "procedural generation beats stored assets" applied to
 * geometry rather than to pixels.
 *
 * The PRNG is the plain Lehmer generator, inlined rather than imported: the
 * portability contract allows one import and it is spent on quant.js. The tool
 * and the game run this same code, so an arrangement is identical in both.
 *
 * Anything that reads a parts array WITHOUT going through begin() — a host's
 * own bound(), a hit test — has to expand first, or it sees a header as a stray
 * sphere.
 */
export function expand(m) {
  // The common case is no scatter at all, and it must cost one pass and no
  // allocation: this runs on every restart while a part is being dragged.
  let any = 0;
  for (let i = 0; i < m.length; i += STRIDE) if (m[i] & SCATTER) { any = 1; break; }
  if (!any) return m;

  const out = [];
  for (let i = 0; i < m.length; i += STRIDE) {
    if (!(m[i] & SCATTER)) {
      for (let c = 0; c < STRIDE; c++) out.push(m[i + c]);
      continue;
    }
    const t = i + STRIDE;
    if (t >= m.length) break;            // a header with nothing to copy
    let s = (m[i + 1] | 0) || 1;         // seed 0 degenerates the generator
    const rnd = () => (s = s * 16807 % 2147483647) / 2147483647;
    const j = () => rnd() * 2 - 1;
    const n = Math.abs(m[i + 2]) | 0, ball = m[i + 2] < 0;
    const mir = m[t] & MIRROR;
    const nmat = (m[i + 12] | 0) + 1;
    // A value that starts positive stays positive — a negative half-extent is a
    // shape turned inside out and the march fills the frame. A value that starts
    // negative is a signed vector component (a capsule's axis, a plane's normal)
    // and keeps its own sign. The same rule the editor's scale handles follow.
    const dim = (v, sp) => (v >= 0 ? Math.max(0, v + j() * sp) : Math.min(0, v + j() * sp));
    for (let k = 0; k < n; k++) {
      let dx, dy, dz;
      // Rejection, not a formula: it stays deterministic, it is three lines, and
      // it gives the honest uniform ball rather than one bunched at the centre.
      do {
        dx = j(); dy = j(); dz = j();
      } while (ball && dx * dx + dy * dy + dz * dz > 1);
      const x = m[t + 1] + dx * m[i + 3];
      out.push(
        m[t],
        // A mirrored template folds x -> |x|, so an instance rolled to the far
        // side would have no half left to mirror and would vanish. Half of them
        // would, which is the difference between a symmetric mass and a bug.
        mir ? Math.abs(x) : x,
        m[t + 2] + dy * m[i + 4],
        m[t + 3] + dz * m[i + 5],
        m[t + 4] + j() * m[i + 6],
        m[t + 5] + j() * m[i + 6],
        m[t + 6] + j() * m[i + 6],
        dim(m[t + 7], m[i + 7]),
        dim(m[t + 8], m[i + 8]),
        dim(m[t + 9], m[i + 9]),
        dim(m[t + 10], m[i + 10]),
        dim(m[t + 11], m[i + 11]),
        m[t + 12] + (nmat > 1 ? Math.floor(rnd() * nmat) : 0),
      );
    }
    i = t;                               // the template is never drawn alone
  }
  return out;
}

//==============================================================================
// THE RENDERER
//==============================================================================

export default class SDF {
  /**
   * @param {number} w
   * @param {number} h
   * @param {Uint8Array} pal palette RGB, 3 bytes per entry
   * @param {object} [opts]
   * @param {number} [opts.lo] first palette index the quantiser may use.
   *   Pass 1 when index 0 is the transparent entry, or dark pixels dither into
   *   holes.
   * @param {number} [opts.hi] last usable index.
   * @param {number} [opts.ditherAmt] ordered-dither amplitude — how far a
   *   colour is nudged before the lookup, in units of the palette's own
   *   lightness step.
   *
   *   THE DEFAULT IS A CONSTANT ON PURPOSE, and it is the one place this
   *   module knowingly gives up generality for bytes. noodle.js derives it
   *   from the palette with quant.js's `lightnessStep`, which is the right
   *   answer for any palette and costs the whole HSL path — about 400 B
   *   compressed for a number. Measured, that number is 0.040 for this repo's
   *   authored palette and 0.031 for the generated one, so 0.035 is within a
   *   dither step of both. A tool that cares, or a project on a sparse
   *   palette, imports `lightnessStep` itself and passes the product; a game
   *   ships the constant and pays nothing.
   * @param {number} [opts.carry] scanline error carry, 0..1.
   *
   * THESE TWO DEFAULTS ARE WHAT THE SDFTOOL SHOWS, and that is the whole reason
   * they are worth pinning: the tool previews with them, so a game that passes
   * its own pair ships art that does not look like the art it was authored
   * against. `delve.js` passed `{ carry: 0, ditherAmt: 0.015 }` and its sprites
   * came out about four times less dithered than the editor's picture of the
   * same model. **A game should pass neither.** If a bake needs different
   * numbers, change them here so the editor changes with it.
   */
  constructor(w, h, pal, opts = {}) {
    this.pal = pal;
    this.nCol = (pal.length / 3) | 0;
    this.lo = opts.lo ?? 0;
    this.hi = opts.hi ?? this.nCol - 1;
    this.lut = buildRgbLut(pal, this.lo, this.hi);
    // Not a table any more — just the claim that the palette is N ramps of
    // `rampSize`, dark to light. The outline pass needs it and nothing else
    // does; see outline().
    this.rampSize = opts.rampSize | 0;
    this.damt = opts.ditherAmt ?? 0.035;
    this.carry = opts.carry ?? 0.8;
    this.setSize(w, h);
  }

  setSize(w, h) {
    this.w = w;
    this.h = h;
    this.rgb = [0, 0, 0];               // scratch for shade(), reused per pixel
    this.col = new Uint8Array(w * h);   // the output: palette indices
    this.zb = new Float32Array(w * h);  // 0 where nothing was hit, else 0..1 near
    this.row = 0;                       // rows finished, for the resumable render
  }

  /**
   * Set up a render. Nothing is drawn yet — step() does the work — so a boot
   * bake can spread one asset over several frames.
   *
   * @param {number[]} model stride-13 parts, SCATTER headers and all
   * @param {number[][]} mats [r, g, b] 0..1 per material index
   * @param {object} [o] the view:
   *   `yaw`, `pitch` — camera, in TURNS
   *   `scale` — world units across the short axis
   *   `vx`, `vy` — the world point the CENTRE of the frame looks at, in world
   *     units along the camera's own right and up. Both 0 means the model's
   *     origin, which is what a square sprite of a centred model wants. It is
   *     what lets a frame be cropped tight around art that is not centred —
   *     see the sdftool's fit, which is the only thing expected to write it
   *   `lx`, `ly`, `lz` — the key light's direction. It is a DIRECTION, not a
   *     place: a directional light costs nothing per pixel, which is what lets
   *     this afford two of them
   *   `lcam` — read both light directions in CAMERA space instead of world:
   *     x right, y up, z toward the viewer, so the light keeps its place on the
   *     screen as `yaw` and `pitch` turn. THIS IS WHAT A FACING SET WANTS — one
   *     light lights all eight rows, instead of three numbers per row. Off by
   *     default, and at yaw 0 pitch 0 the two spaces are the same, so turning it
   *     on there changes nothing
   *   `lr`, `lg`, `lb` — the key's colour, and `li` its strength
   *   `lw` — the key's wrap: 0 is lambert, 1 is the half-lambert `0.5 + 0.5 n·l`
   *   `l2x`, `l2y`, `l2z` — the second light's direction. UNSET means opposite
   *     the key, which is the wrap fill this renderer always had. Set one and
   *     it stops following
   *   `l2r`, `l2g`, `l2b`, `l2i`, `l2w` — the same five for the second light.
   *     `l2i` of 0 turns it off; `l2w` of 0 aimed away from the camera is a rim
   *   `amb` — ambient, the term neither light reaches
   *   `fog` — depth haze, 0..1, mixed in BEFORE the dither so it lands in the
   *     palette rather than on top of it; `fogr`, `fogg`, `fogb` its colour
   *   `ao` — occlusion strength; 1 by default, and worth every millisecond
   *   `spec` — highlight strength, screened in so it cannot clip
   *   `exposure` — overall gain; `amb + li + l2i` sums to 1 by default, and
   *     that headroom is why nothing clips
   *   `outline` — darken the silhouette by N ramp steps. 0 by default; see
   *     outline() for why 1 is the most it should usually be
   *   `shadow` — cast a soft shadow ray. 0 by default: it costs 45% more time
   *     for something occlusion already implies at sprite sizes
   *   `bg` — background palette index
   */
  begin(model, mats, o = {}) {
    // SCATTER headers become real rows HERE, once, alongside the other work
    // that must not happen per sample — the camera basis, the bounds, the
    // rotation matrices. Everything below reads `this.m` and not `model`.
    this.m = expand(model);
    this.mats = mats;
    this.o = o;
    this.col.fill(o.bg ?? 0);
    this.zb.fill(0);
    this.row = 0;
    this.px = 0;
    this.outlined = 0;

    // Camera basis. Yaw then pitch, in turns, so the numbers read the way the
    // noodletool's orbit writes them.
    const cy = Math.cos((o.yaw ?? 0) * TAU), sy = Math.sin((o.yaw ?? 0) * TAU);
    const cp = Math.cos((o.pitch ?? 0) * TAU), sp = Math.sin((o.pitch ?? 0) * TAU);
    this.f = [sy * cp, -sp, cy * cp];         // forward: the way rays travel
    this.r = [cy, 0, -sy];                    // right
    this.u = [sy * sp, cp, cy * sp];          // up

    // World units across the SHORTER axis, so a wide frame reveals more rather
    // than squashing it — the rule noodle uses, for the same reason.
    this.scale = (o.scale ?? 3) / Math.min(this.w, this.h);
    this.br = bound(this.m);
    // Once per render, never per sample. See prepRot.
    this.rot = prepRot(this.m);
    this.eps = 0.5 * this.scale;              // one pixel: no point resolving finer

    // THE TWO LIGHTS. The second one starts as the wrap fill this renderer has
    // always had — opposite the key, a tenth as strong, fully wrapped — because
    // that fill WAS a second light with its direction, weight and wrap nailed
    // shut. Unnailing them buys a coloured fill or a rim for a few bytes, and
    // the defaults render what they rendered before, pixel for pixel.
    //
    // `lcam` TURNS THE DIRECTIONS WITH THE CAMERA. A world-space light is right
    // for a lamp and wrong for a facing set: orbit for the next facing and the
    // key slides round the character. Under `lcam` the dials are read against
    // the camera's own right, up and forward, so one aim lights every yaw. The
    // basis is orthonormal, so this is a rotation and nothing renormalises.
    const cam = o.lcam
      ? d => this.r.map((v, i) => v * d[0] + this.u[i] * d[1] + this.f[i] * d[2])
      : d => d;
    const l1 = cam(norm(o.lx ?? 0.6, o.ly ?? 0.7, o.lz ?? -0.4));
    this.l1 = l1;
    // Unset means "follow the key". Writing one of these unlinks the fill,
    // which is exactly what the tool's widget does on its first drag. Negating
    // the resolved key is the same as negating it before `cam`: it is linear.
    this.l2 = o.l2x == null && o.l2y == null && o.l2z == null
      ? [-l1[0], -l1[1], -l1[2]]
      : cam(norm(o.l2x ?? 0, o.l2y ?? 0, o.l2z ?? 0));

    // Wrap as a scale and a bias, so a pixel pays one multiply and one add
    // rather than a divide: t = n·l * s + b. w = 0 gives s 1, b 0 — plain
    // lambert. w = 1 gives 0.5, 0.5 — the half-lambert fill, bit for bit,
    // because 0.5 is exact and addition commutes.
    const w1 = o.lw ?? 0, w2 = o.l2w ?? 1;
    this.s1 = 1 / (1 + w1); this.b1 = w1 / (1 + w1);
    this.s2 = 1 / (1 + w2); this.b2 = w2 / (1 + w2);

    // Colour times strength, once per render. `kc` stays raw: the specular is a
    // highlight OF the key, not a share of its energy, so dimming the key must
    // not dim the highlight.
    const i2 = o.l2i ?? 0.1;
    this.kc = [o.lr ?? 1, o.lg ?? 1, o.lb ?? 1];
    this.k1 = this.kc.map(v => v * (o.li ?? 0.74));
    this.k2 = [(o.l2r ?? 1) * i2, (o.l2g ?? 1) * i2, (o.l2b ?? 1) * i2];

    // Fog, and the ambient it tints. The haze is the sky and the sky is what
    // fills the shadows, so the ambient leans toward the fog colour as the fog
    // comes up — no dial of its own, and most of what reads as "outdoors".
    //
    // Depth is the march parameter at the hit: the camera is orthographic and
    // the ray origin is perpendicular to forward, so `t` IS the world depth
    // along the view axis. `zb` is not that — it divides by each ray's own
    // chord — so fog must never be taken from it.
    const fog = this.fog = o.fog ?? 0;
    this.fc = [o.fogr ?? 0, o.fogg ?? 0, o.fogb ?? 0];
    const amb = o.amb ?? 0.16;
    this.am = this.fc.map(v => amb * (1 + (v - 1) * fog));
    // Normalised by the bounding radius, so `fog` means the same on a crate and
    // on a tree: 0 at the front of the sphere, `fog` at the back.
    this.fh = fog * 0.5;
    this.fk = fog / (2 * this.br);
  }

  /** True once every row has been rendered. */
  done() {
    return this.row >= this.h;
  }

  /**
   * Render for at most `ms` milliseconds, a scanline at a time, and return how
   * many rows were finished.
   *
   * The clock is only READ — it decides when to stop, never what gets drawn —
   * so a render split across frames is identical to one done in a single call.
   * That is what lets a Worker reproduce a main-thread bake byte for byte.
   */
  step(ms = 8) {
    const t0 = Date.now();
    let n = 0;
    while (this.row < this.h) {
      if (n && !(n & 7) && Date.now() - t0 >= ms) break;
      this.scanline(this.row++);
      n++;
    }
    if (this.row >= this.h && !this.outlined) {
      this.outlined = 1;
      this.outline();
    }
    return n;
  }

  /**
   * Darken the silhouette's inner rim, so a sprite reads against a background
   * of any colour.
   *
   * COSTS NO DATA AT ALL, given a ramp-structured palette. This one is 32 ramps
   * of 8 ordered dark to light, so "darker, same hue" is arithmetic —
   * `(c & ~7) | max((c & 7) - n, 0)` — rather than the hand-authored table the
   * Picotron port called its most load-bearing piece of data. Pass `rampSize`
   * to say the palette is laid out that way; without it there is no safe way to
   * darken and the pass is skipped.
   *
   * A whole-frame pass, so it runs once when the last scanline lands rather
   * than per row: an edge is only an edge once its neighbours exist.
   *
   * KEEP IT AT 1. Darkening inside a ramp assumes the pixel's ramp is the
   * surface's ramp, and the dither breaks that assumption at the margins: a
   * pixel the quantiser placed in a neighbouring ramp darkens toward THAT
   * ramp's dark end, which on a grey model is a coloured speck. One step is
   * under the threshold where that reads; two or three make a rim you can see
   * and a fringe you can also see. Off is a legitimate default — occlusion
   * already separates a sprite from most backgrounds.
   */
  outline() {
    const n = this.o.outline | 0;
    if (!n || this.rampSize !== 8) return;
    const w = this.w, h = this.h, zb = this.zb, col = this.col;
    const edge = [];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (!zb[i]) continue;
        // Off the edge of the frame counts as background: a sprite cropped by
        // its own rect should still be outlined where it was cut.
        if (x === 0 || y === 0 || x === w - 1 || y === h - 1
          || !zb[i - 1] || !zb[i + 1] || !zb[i - w] || !zb[i + w]) edge.push(i);
      }
    }
    for (const i of edge) {
      const c = col[i], s = c & 7;
      col[i] = (c & ~7) | (s > n ? s - n : 0);
    }
  }

  /** Render to completion and return the index buffer. */
  render(model, mats, o) {
    this.begin(model, mats, o);
    while (!this.done()) this.step(1e9);
    return this.col;
  }

  /** One row. Everything expensive lives here. */
  scanline(py) {
    const w = this.w, h = this.h, m = this.m, o = this.o;
    const [fx, fy, fz] = this.f, [rx, ry, rz] = this.r, [ux, uy, uz] = this.u;
    const [lx, ly, lz] = this.l1, [l2x, l2y, l2z] = this.l2;
    const [k1r, k1g, k1b] = this.k1, [k2r, k2g, k2b] = this.k2;
    const [ar, ag, ab] = this.am, [fcr, fcg, fcb] = this.fc;
    const [kcr, kcg, kcb] = this.kc;
    const s1 = this.s1, b1 = this.b1, s2 = this.s2, b2 = this.b2;
    const fog = this.fog, fh = this.fh, fk = this.fk;
    const scale = this.scale, br = this.br, eps = this.eps, br2 = br * br;
    const ao = o.ao ?? 1, spec = o.spec ?? 0;
    const shadow = o.shadow ?? 0, exposure = o.exposure ?? 1;
    // SCREEN Y GROWS DOWN AND WORLD Y GROWS UP, so this subtraction is the
    // right way round and the obvious `py - h / 2` is not: with that, row 0 —
    // the top of the image — samples the bottom of the model and every asset
    // renders upside down. Models are authored +Y up, and it is worth keeping
    // them that way rather than flipping the models to suit the renderer.
    const sv = (h / 2 - py - 0.5) * scale + (o.vy ?? 0);

    // Error carried along the scanline. Reset per row: carrying across the
    // wrap would smear the right edge into the left.
    let er = 0, eg = 0, eb = 0;

    for (let px = 0; px < w; px++) {
      const su = (px - w / 2 + 0.5) * scale + (o.vx ?? 0);
      const ox = rx * su + ux * sv, oy = ry * su + uy * sv, oz = rz * su + uz * sv;

      // Orthographic, so the ray's distance from the model centre is just the
      // perpendicular component — one test skips most of a sprite's frame.
      const perp = ox * ox + oy * oy + oz * oz;
      if (perp > br2) continue;
      const half = Math.sqrt(br2 - perp);

      const rot = this.rot;
      let t = -half, hit = 0;
      while (t < half) {
        const d = map(m, ox + fx * t, oy + fy * t, oz + fz * t, rot);
        if (d < eps) { hit = 1; break; }
        t += d;
      }
      if (!hit) continue;

      const hx = ox + fx * t, hy = oy + fy * t, hz = oz + fz * t;

      // Normal by tetrahedral gradient: four evaluations rather than six.
      const e = eps * 0.5;
      const d1 = map(m, hx + e, hy - e, hz - e, rot);
      const d2 = map(m, hx - e, hy - e, hz + e, rot);
      const d3 = map(m, hx - e, hy + e, hz - e, rot);
      const d4 = map(m, hx + e, hy + e, hz + e, rot);
      let nx = d1 - d2 - d3 + d4, ny = -d1 - d2 + d3 + d4, nz = -d1 + d2 - d3 + d4;
      const nl = Math.hypot(nx, ny, nz) || 1;
      nx /= nl; ny /= nl; nz /= nl;

      // Ambient occlusion: step out along the normal and compare the distance
      // we should have gained against what is actually there. Four taps, and
      // the single cheapest thing that makes a render look pre-rendered.
      let occ = 1;
      if (ao) {
        let sum = 0, sc = 1;
        for (let k = 1; k <= 4; k++) {
          const hgt = 0.06 * k;
          sum += (hgt - map(m, hx + nx * hgt, hy + ny * hgt, hz + nz * hgt, rot)) * sc;
          sc *= 0.7;
        }
        occ = Math.max(0, Math.min(1, 1 - 2.2 * ao * sum));
      }

      let dif = (nx * lx + ny * ly + nz * lz) * s1 + b1;
      if (dif < 0) dif = 0;

      // A shadow ray toward the light. Off by default — see the note on
      // `shadow` in the constructor.
      if (shadow && dif > 0) {
        let st = eps * 3, sh = 1;
        while (st < 3) {
          const d = map(m, hx + lx * st, hy + ly * st, hz + lz * st, rot);
          if (d < eps * 0.5) { sh = 0; break; }
          // Soft: the closer the ray passes to a surface, the more it dims.
          const k = 8 * d / st;
          if (k < sh) sh = k;
          st += Math.max(d, eps);
        }
        dif *= Math.max(0, Math.min(1, sh));
      }

      // The second light. By default it faces the key and wraps all the way
      // round, which keeps the dark side reading as material rather than as a
      // hole — what a studio render does, and the difference between "3D" and
      // "3D asset". Steered, it is a coloured fill or a rim.
      //
      // IT IS OCCLUDED AND THE KEY IS NOT. The key has the shadow ray when one
      // is wanted; a fill and a rim are wide soft sources, and occlusion is the
      // cheap stand-in for their shadowing.
      let fill = (nx * l2x + ny * l2y + nz * l2z) * s2 + b2;
      if (fill < 0) fill = 0;

      // Blended across every part that reaches this point, including PAINT
      // volumes — one call, at the hit, which is what makes it affordable.
      shade(m, this.mats, hx, hy, hz, rot, this.rgb);
      const c3 = this.rgb;
      // THE WEIGHTS SUM TO ONE on purpose: a sum over 1 clips a pale material
      // to flat white across the whole lit side. The dials can break that sum,
      // and the tool says so rather than clamping.
      let r = c3[0] * ((ar * occ + k2r * fill * occ + k1r * dif) * exposure);
      let g = c3[1] * ((ag * occ + k2g * fill * occ + k1g * dif) * exposure);
      let b = c3[2] * ((ab * occ + k2b * fill * occ + k1b * dif) * exposure);

      if (spec) {
        const hlx = lx - fx, hly = ly - fy, hlz = lz - fz;
        const hln = Math.hypot(hlx, hly, hlz) || 1;
        let sd = (nx * hlx + ny * hly + nz * hlz) / hln;
        if (sd > 0) {
          sd *= sd; sd *= sd; sd *= sd;          // ^8, without pow
          const sp = spec * sd * occ;
          // SCREENED IN, not added on: `x + s(1 - x)` cannot exceed 1, so a
          // highlight brightens what is there instead of clipping it away.
          //
          // It takes the key's COLOUR and not its strength: a warm light leaves
          // a warm highlight, but turning the key down must not put the gloss
          // out with it.
          r += sp * kcr * (1 - r);
          g += sp * kcg * (1 - g);
          b += sp * kcb * (1 - b);
        }
      }

      // Depth haze, after the light and BEFORE the dither, which is the whole
      // point: the atmosphere lands in the palette rather than on top of it.
      // `t` is the hit's world depth along the view axis (see begin), so this
      // is a lerp and nothing else.
      if (fog) {
        const f = fh + t * fk;
        r += (fcr - r) * f;
        g += (fcg - g) * f;
        b += (fcb - b) * f;
      }

      // Ordered offset to break banding, then the scanline carry to spread the
      // residual — the same pair noodle uses, and the reason 256 colours reads
      // as smooth shading rather than as bands.
      const bay = BAYER[(py & 3) * 4 + (px & 3)] * this.damt;
      r += er + bay; g += eg + bay; b += eb + bay;
      const ri = r < 0 ? 0 : r > 1 ? 31 : (r * 31) | 0;
      const gi = g < 0 ? 0 : g > 1 ? 31 : (g * 31) | 0;
      const bi = b < 0 ? 0 : b > 1 ? 31 : (b * 31) | 0;
      const c = this.lut[(ri << 10) | (gi << 5) | bi];
      er = (r - this.pal[c * 3] / 255) * this.carry;
      eg = (g - this.pal[c * 3 + 1] / 255) * this.carry;
      eb = (b - this.pal[c * 3 + 2] / 255) * this.carry;

      const i = py * w + px;
      this.col[i] = c;
      this.zb[i] = 1 - (t + half) / (2 * half || 1);
      this.px++;
    }
  }

  /** Copy the indices out as RGBA, for hosts with no indexed surface. Index 0
   * comes back transparent, which is what gives a baked sprite its alpha. */
  toRGBA(out) {
    const n = this.w * this.h;
    out = out || new Uint8ClampedArray(n * 4);
    for (let i = 0; i < n; i++) {
      const c = this.col[i] * 3;
      out[i * 4] = this.pal[c];
      out[i * 4 + 1] = this.pal[c + 1];
      out[i * 4 + 2] = this.pal[c + 2];
      out[i * 4 + 3] = this.col[i] ? 255 : 0;
    }
    return out;
  }
}
