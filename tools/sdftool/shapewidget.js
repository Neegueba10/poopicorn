/**
 * The part's own cage: the box its shape actually fills, in its own frame.
 *
 * WHY A CAGE AT ALL. Two kinds of part are edited blind today. A PAINT part is
 * colour with no surface, so it is a row in the list and nothing on screen. A
 * SUBTRACTED part is the same problem from the other side: you see the hole and
 * never the cutter. Both are placed by dragging numbers at a shape you cannot
 * look at. The cage is that shape.
 *
 * IT IS MEASURED WITH `supportLocal`, NOT WITH A BOX PER KIND. That function
 * (tools/sdftool/fit.js) is the exact support of every primitive — how far it
 * reaches along a direction — and it is what crops sprites in the sheet tab. So
 * the cage cannot disagree with the crop, and a box drawn round a sphere is a
 * cube rather than something 1.7x too wide at the corners.
 *
 * IT IS ASYMMETRIC, because two primitives are: a pyramid grows from a base
 * below its origin up to an apex at it, and a triangular prism's apex is
 * further out than its base. Each axis is measured both ways.
 *
 * Geometry only — this module never touches the document and never reads the
 * camera. The same contract gizmo.js, lightwidget.js and rig.js keep.
 */
import { STRIDE, PAINT } from './state.js';
import { supportLocal, partAxes } from './fit.js';
import { map } from '../../src/js/core/sdf.js';

/** The eight corners of a box, as sign triples: bit 0 is x, 1 is y, 2 is z. */
const CORNERS = [0, 1, 2, 3, 4, 5, 6, 7];
/** The twelve edges, as pairs of corner indices — one bit apart. */
export const EDGES = [[0, 1], [0, 2], [0, 4], [1, 3], [1, 5], [2, 3],
  [2, 6], [3, 7], [4, 5], [4, 6], [5, 7], [6, 7]];

/**
 * The cage of part `row`, or null when it has no bounded extent.
 *
 * @returns {{c: number[], axes: number[][], lo: number[], hi: number[],
 *            corners: number[][]}}
 *   `c` the part's centre in world, `axes` its local→world columns, `lo`/`hi`
 *   the local box in the part's own frame, `corners` the eight world points.
 */
export function cage(parts, row) {
  const i = row * STRIDE;
  if (i < 0 || i + STRIDE > parts.length) return null;
  const kind = parts[i] & 31;
  const a = parts[i + 7], b = parts[i + 8], c = parts[i + 9];
  // A PAINT part's reach IS its blend: `shade()` mixes its colour in for
  // `blend` past its own surface, and nothing else about it is visible. For a
  // part with a surface the blend is how it JOINS its neighbours, not how far
  // it goes, so the cage stays on the shape.
  const r = parts[i + 10] + ((parts[i] & PAINT) ? Math.max(0, parts[i + 11]) : 0);
  // A plane is a half-space. There is no box that means anything.
  if (supportLocal(kind, a, b, c, r, [1, 0, 0]) == null) return null;

  const axes = partAxes(parts, i);
  const cw = [parts[i + 1], parts[i + 2], parts[i + 3]];
  // A REACH MAY BE NEGATIVE, and clamping it to zero is what makes a cage
  // loose. A capped torus is an arc about +Y: its support along -Y is -0.077,
  // meaning the shape stops 0.077 ABOVE the part's own origin. Clamped, the
  // cage ran down to the origin and its bottom face bounded empty space —
  // which is a face a handle would later hang off, nowhere near the shape.
  const reach = d => supportLocal(kind, a, b, c, r, d);
  const hi = [reach([1, 0, 0]), reach([0, 1, 0]), reach([0, 0, 1])];
  const lo = [reach([-1, 0, 0]), reach([0, -1, 0]), reach([0, 0, -1])];
  // An empty span is a part with no extent on that axis — a degenerate row, not
  // a shape. Give it a hair of width rather than an inside-out box.
  for (let k = 0; k < 3; k++) {
    if (hi[k] + lo[k] > 1e-6) continue;
    const mid = (hi[k] - lo[k]) / 2;
    hi[k] = mid + 1e-3;
    lo[k] = 1e-3 - mid;
  }

  const corners = CORNERS.map(k => {
    const l = [k & 1 ? hi[0] : -lo[0], k & 2 ? hi[1] : -lo[1], k & 4 ? hi[2] : -lo[2]];
    return [0, 1, 2].map(w => cw[w] + axes[0][w] * l[0] + axes[1][w] * l[1] + axes[2][w] * l[2]);
  });
  return { c: cw, axes, lo, hi, corners };
}

/** A local point in the part's frame, in world. */
export const toWorld = (cg, l) => [0, 1, 2].map(w =>
  cg.c[w] + cg.axes[0][w] * l[0] + cg.axes[1][w] * l[1] + cg.axes[2][w] * l[2]);

/** A local direction in the part's frame, in world. */
export const dirToWorld = (cg, l) => [0, 1, 2].map(w =>
  cg.axes[0][w] * l[0] + cg.axes[1][w] * l[1] + cg.axes[2][w] * l[2]);

/** Grab radius in overlay pixels — gizmo.js's, so every handle on this pane
 * feels the same size. */
export const GRAB = 8;

/**
 * Where to put the `round` handle on each primitive, in its own frame.
 *
 * `round` is a DILATION: every primitive that has one returns `core(p) − round`,
 * so the shape is a core swept by a ball of that radius. One handle serves all
 * of them, and this table only says which corner of each shape to hang it on —
 * the corner where the fillet is most visible.
 *
 * `null` is a kind whose `round` some other handle already writes (see
 * SCALE_COLS in state.js: a sphere's radius, a torus's minor, a link's tube, a
 * capped torus's minor are all on the scale arms), or which has no `round` at
 * all, or the plane — whose `round` is an OFFSET, not a dilation, and gets its
 * own handle.
 *
 * The direction need not point at anything in particular: the anchor is the
 * shape's support point along it, so the handle lands on real geometry whatever
 * is written here.
 */
const DILATE = [
  null,             // sphere: round IS the radius — the arms have it
  [1, 1, 1],        // box: the corner sphere
  null,             // capsule: perpendicular to its own axis, computed below
  null,             // torus: the arms write the minor radius
  [1, 1, 0],        // cylinder: the rim fillet
  [1, -1, 0],       // cone: the base rim, which is the wider one
  [1, 0, 0],        // octahedron: a vertex
  [1, 1, 0],        // hex prism: a rim corner
  null,             // ellipsoid: has no round
  null,             // link: the arms write the tube radius
  [1, -1, 0],       // pyramid: a base corner
  null,             // capped torus: the arms write the minor radius
  [1, -1, 1],       // tri prism: a base corner
  null,             // plane: an offset, not a dilation
];

/**
 * Which faces of the cage can be dragged, per kind, and what each one writes.
 *
 * NOT SIX FACES FOR EVERYONE. A cage is drawn round every primitive, but only
 * some primitives are PARAMETERISED as a centre and half-extents, and only
 * those have a face that can move on its own. A cylinder has two end caps and
 * one radius — its x and z "faces" are the same number, so dragging one would
 * drag the other pair off the shape. A sphere's six faces are one radius. A
 * torus's cage touches it at four points that mean nothing. Offering a handle
 * there would be a control that lies about what it does.
 *
 *   axis    which local axis the face is on
 *   col     the dimension column that face's position comes from
 *   signs   which ends are grabbable
 *   centre  whether an asymmetric drag may move the part's centre. False on
 *           the pyramid, whose apex is pinned at its own origin by the format:
 *           growing its height already moves the base and nothing else.
 */
const FACES = [
  [],                                                       // sphere
  [{ axis: 0, col: 7 }, { axis: 1, col: 8 }, { axis: 2, col: 9 }],   // box
  [],                                                       // capsule: its ENDS
  [],                                                       // torus
  [{ axis: 1, col: 8 }],                                    // cylinder: the caps
  [{ axis: 1, col: 8 }],                                    // cone: the caps
  [],                                                       // octahedron
  [{ axis: 1, col: 8 }],                                    // hex prism: the caps
  [{ axis: 0, col: 7 }, { axis: 1, col: 8 }, { axis: 2, col: 9 }],   // ellipsoid
  [],                                                       // link
  [{ axis: 1, col: 8, signs: [-1], centre: false }],        // pyramid: its base
  [],                                                       // capped torus
  // Tri prism: its caps are on Z, but its half depth is column `b`, not `c` —
  // the axis a dimension lies along and the column it is stored in are not the
  // same question. SCALE_COLS[12] says the same thing.
  [{ axis: 2, col: 8 }],                                    // tri prism: the caps
  [],                                                       // plane
];

const len3 = v => Math.hypot(v[0], v[1], v[2]);
const norm = v => {
  const l = len3(v);
  return l > 1e-9 ? [v[0] / l, v[1] / l, v[2] / l] : [1, 0, 0];
};

/**
 * A unit vector perpendicular to `v`, chosen the same way every time.
 *
 * The capsule's `round` is its RADIUS, so its handle has to stand out sideways
 * from the axis — and the axis is a different local direction for every
 * capsule. Crossing with whichever world axis `v` leans on least keeps the
 * result stable: a perpendicular that flipped as the axis crossed an octant
 * would send the handle jumping across the shape mid-drag.
 */
function perp(v) {
  if (len3(v) < 1e-9) return [1, 0, 0];
  const ax = [Math.abs(v[0]), Math.abs(v[1]), Math.abs(v[2])];
  const k = ax[0] <= ax[1] && ax[0] <= ax[2] ? 0 : ax[1] <= ax[2] ? 1 : 2;
  const e = [0, 0, 0];
  e[k] = 1;
  return norm([v[1] * e[2] - v[2] * e[1], v[2] * e[0] - v[0] * e[2],
    v[0] * e[1] - v[1] * e[0]]);
}

/**
 * Slide `p` along `d` until it is on the part's own surface.
 *
 * A one-row model at the origin with no rotation makes `map` evaluate exactly
 * the primitive, in its own frame — so this asks the renderer where its surface
 * is rather than trusting an algebraic guess. Bisection rather than Newton
 * because `d` is a chosen direction, not the surface normal, and on a chamfered
 * edge the two are 76° apart: a Newton step scaled by that cosine crawls, while
 * a bracket cannot fail to converge.
 */
function onSurface(kind, a, b, c, r, d, p) {
  const m = [kind, 0, 0, 0, 0, 0, 0, a, b, c, r, 0, 0];
  const at = t => map(m, p[0] + d[0] * t, p[1] + d[1] * t, p[2] + d[2] * t, null);
  let lo = 0, hi = 0;
  const d0 = at(0);
  if (Math.abs(d0) < 1e-9) return p;
  // Bracket: walk the way the sign says, in steps of the distance itself, which
  // is how far it is safe to move.
  const step = d0 > 0 ? -1 : 1;
  for (let i = 0; i < 24; i++) {
    hi += step * Math.max(Math.abs(at(hi)), 1e-4);
    if (at(hi) * d0 <= 0) break;
    lo = hi;
  }
  if (at(hi) * d0 > 0) return p;              // never crossed: leave it alone
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (at(mid) * d0 > 0) lo = mid; else hi = mid;
  }
  const t = (lo + hi) / 2;
  return [p[0] + d[0] * t, p[1] + d[1] * t, p[2] + d[2] * t];
}

/**
 * The interactive handles for one part, in overlay pixels.
 *
 * THE ANCHOR IS THE SHAPE'S SUPPORT POINT, and it is computed rather than
 * placed. `supportLocal` gives how FAR a shape reaches along a direction; the
 * point it reaches is the gradient of that function's 1-homogeneous extension,
 * `H(d) = |d| · support(d / |d|)`. Six evaluations of a function that already
 * exists, and the handle lands exactly on the fillet — on the rounded corner of
 * a box whose three half-extents all differ, on an octahedron's vertex, on a
 * cylinder's rim.
 *
 * THE GAIN IS DERIVED TOO. `support` is affine in `round`, so
 * `support(round + 1) − support(round)` is how far the surface moves per unit
 * of it. That is 1 on most kinds and √3 on the octahedron — which rounds the
 * PLANE distance, so its vertices sit at `a + round·√3`. A per-kind constant
 * would have been the thing that was quietly wrong in six months; this cannot
 * disagree with `prim`, because it asks it.
 *
 * Together they give the contract every other widget on this pane keeps: the
 * handle stays under the pointer.
 */
/**
 * Where the shape's surface is along `d`, in the part's own frame.
 *
 * THE GUESS IS THE SUPPORT POINT, THE ANSWER IS THE FIELD. `supportLocal` gives
 * how FAR a shape reaches along a direction; the point it reaches is the
 * gradient of that function's 1-homogeneous extension, `H(d) = |d|·support(d̂)`.
 * Differentiating the homogeneous form is what keeps the `round` term: written
 * for unit directions only, `+ round` reads as a constant and its gradient
 * loses it, anchoring on the core corner instead of the rounded one.
 *
 * That guess is exact on most kinds and wrong on three. A pyramid, a triangular
 * prism and a hex prism round by `max(plane distances) − round`, which dilates
 * their faces but CHAMFERS their edges — so along an edge the real surface is
 * nearer than `core + round`. Sliding the guess onto the isosurface fixes them
 * without knowing they are special, and would fix a fifteenth primitive nobody
 * has written yet.
 */
function anchorAt(kind, dims, d) {
  const [a, b, c, r] = dims;
  const H = e => {
    const l = len3(e) || 1;
    return l * supportLocal(kind, a, b, c, r, [e[0] / l, e[1] / l, e[2] / l]);
  };
  const EPS = 1e-4;
  const guess = [0, 1, 2].map(k => {
    const up = [...d], dn = [...d];
    up[k] += EPS;
    dn[k] -= EPS;
    return (H(up) - H(dn)) / (2 * EPS);
  });
  return onSurface(kind, a, b, c, r, d, guess);
}

/**
 * One handle: its anchor on the surface, and how far that surface moves per
 * unit of the column it writes.
 *
 * THE GAIN IS MEASURED, for the same reason the anchor is corrected — the
 * algebraic answer is right where the support is exact and wrong exactly where
 * it is not. Growing the column and asking how far the surface went cannot
 * disagree with `prim`, because it asks it. It is 1.000 on a box's corner,
 * 1.732 on an octahedron's vertex (that kind rounds the PLANE distance) and
 * 1.414 on a pyramid's chamfered edge.
 */
function build(cg, kind, dims, d, col, extra, proj) {
  const local = anchorAt(kind, dims, d);
  const D = 0.01;
  const grown = [...dims];
  grown[col - 7] += D;
  const after = anchorAt(kind, grown, d);
  const gain = ((after[0] - local[0]) * d[0] + (after[1] - local[1]) * d[1]
    + (after[2] - local[2]) * d[2]) / D;
  if (!(Math.abs(gain) > 1e-6)) return null;

  const w = toWorld(cg, local);
  const wd = dirToWorld(cg, d);
  const [x, y] = proj(w[0], w[1], w[2]);
  const [ex, ey] = proj(w[0] + wd[0] * 0.1, w[1] + wd[1] * 0.1, w[2] + wd[2] * 0.1);
  const px = ex - x, py = ey - y;
  const plen = Math.hypot(px, py);
  return {
    col,
    axis: -1,
    x,
    y,
    // The handle's geometry in the part's OWN frame, and its drag direction in
    // WORLD — the pane works in pixels, but an asymmetric face drag has to move
    // the centre along a world vector, and a suite checking that the anchor is
    // on the surface has to ask the renderer, which works in the part's frame.
    lpos: local,
    ldir: d,
    wdir: wd,
    // Overlay pixels per world unit ALONG THIS DIRECTION, and where it goes on
    // screen. An edge-on direction projects to nothing, so dragging it would
    // divide by almost zero — it refuses the grab the way an edge-on gizmo arm
    // does rather than sending the number to infinity.
    ppw: plen / 0.1,
    dir: plen > 1e-6 ? [px / plen, py / plen] : [0, 0],
    flat: plen / 0.1 < 12,
    gain,
    ...extra,
  };
}

export function handles(parts, row, proj) {
  const cg = cage(parts, row);
  if (!cg) return [];
  const i = row * STRIDE;
  const kind = parts[i] & 31;
  const dims = [parts[i + 7], parts[i + 8], parts[i + 9], parts[i + 10]];
  const out = [];

  const dl = kind === 2 ? perp(dims) : DILATE[kind] && norm(DILATE[kind]);
  if (dl) {
    const h = build(cg, kind, dims, dl, 10, { type: 'dilate' }, proj);
    if (h) out.push(h);
  }

  // THE CAPSULE GETS ENDS, NOT FACES. Its `a b c` is an axis VECTOR from the
  // centre, not three half-extents, so its cage is square to a frame the shape
  // runs diagonally through and none of that box's faces is a number. What it
  // has is two joints, and dragging one while the other stays is the same
  // asymmetry a face handle offers — in three dimensions instead of one.
  if (kind === 2) {
    for (const s of [1, -1]) {
      const l = [dims[0] * s, dims[1] * s, dims[2] * s];
      const w = toWorld(cg, l);
      const [x, y] = proj(w[0], w[1], w[2]);
      out.push({
        type: 'end',
        col: -1,
        axis: -1,
        x,
        y,
        lpos: l,
        // ON THE JOINT, NOT THE CAP TIP. The tip is `round` further out along
        // the axis, and the axis TURNS as the end is dragged — so a handle
        // there would slide out from under the pointer by however much the
        // direction changed. The joint is where the numbers are.
        wpos: w,
        axes: cg.axes,
        sign: s,
        flat: false,
      });
    }
  }

  for (const f of FACES[kind] || []) {
    for (const s of f.signs || [1, -1]) {
      const d = [0, 0, 0];
      d[f.axis] = s;
      const h = build(cg, kind, dims, d, f.col, {
        type: 'face',
        // Whether an asymmetric drag may move the centre. See FACES.
        movesCentre: f.centre !== false,
      }, proj);
      if (h) out.push(h);
    }
  }
  return out;
}

/** The handle under (x, y), or null. Nearest wins, as with the gizmo's arms. */
export function hit(hs, x, y) {
  let best = null, bd = GRAB * GRAB;
  for (const h of hs) {
    if (h.flat) continue;
    const d = (h.x - x) ** 2 + (h.y - y) ** 2;
    if (d <= bd) { bd = d; best = h; }
  }
  return best;
}

/** How far a drag moved along a handle's own direction, in WORLD units. What
 * that distance means is the caller's — a dilation and a face resize divide it
 * differently. */
export const along = (h, dx, dy) =>
  (dx * h.dir[0] + dy * h.dir[1]) / Math.max(h.ppw, 1e-6);

/**
 * What one face drag writes: a change to the dimension column, and a change to
 * the part's centre along the handle's world direction.
 *
 * ASYMMETRIC BY DEFAULT — the face you hold moves and the opposite one stays
 * still, which is what an adjustable bounding box means. That takes both
 * writes: with the face at `centre ± f(dim)`, holding the far face still and
 * moving the near one by `δ` gives `dim += δ / 2g` and `centre += δ / 2`. Alt
 * resizes about the centre instead, which is `dim += δ / g` and no move — and
 * so does any face whose kind pins its centre (the pyramid's apex).
 */
export function faceWrite(h, dist, symmetric) {
  const solo = symmetric || !h.movesCentre;
  return {
    dim: dist / (solo ? 1 : 2) / h.gain,
    move: solo ? 0 : dist / 2,
  };
}

/**
 * What one capsule-end drag writes: a new centre and a new local axis.
 *
 * The far joint is the reflection of the near one through the centre, so
 * holding it still is one subtraction. Then the segment from the fixed joint to
 * where the pointer is defines both numbers: the centre is its midpoint and the
 * axis is half its span, taken back into the part's own frame — a rotation's
 * inverse is its transpose, which is a dot with each column.
 *
 * A CAPSULE THEREFORE TURNS WITHOUT ITS ROTATION COLUMNS. `rx ry rz` still mean
 * what they meant; the axis is simply a vector, and pointing it is what aiming
 * a limb is.
 */
export function endWrite(h, centre, move) {
  const near = [0, 1, 2].map(k => h.wpos[k] + move[k]);
  const far = [0, 1, 2].map(k => 2 * centre[k] - h.wpos[k]);
  // THE AXIS ALWAYS POINTS AT THE `+` JOINT, whichever end is being dragged —
  // that is the format's convention, `centre + axis` and `centre − axis`. Take
  // the span from near to far without the sign and the `−` handle writes an
  // axis pointing backwards: the joint you are holding stays under the pointer
  // and the far one swings round to meet it.
  const world = [0, 1, 2].map(k => h.sign * (near[k] - far[k]) / 2);
  return {
    centre: [0, 1, 2].map(k => (near[k] + far[k]) / 2),
    axis: h.axes.map(ax => ax[0] * world[0] + ax[1] * world[1] + ax[2] * world[2]),
  };
}

/**
 * Draw the handles.
 *
 * A DIAMOND DILATES, A SQUARE MOVES A FACE, A RING IS A JOINT. They sit within
 * a few pixels of each other on a small part and they write different numbers,
 * so they cannot look alike — and none may look like the gizmo's arrow heads,
 * which move the whole part.
 */
export function drawHandles(ctx, hs, active) {
  ctx.save();
  for (const h of hs) {
    if (h.flat) continue;
    const on = active && active.col === h.col && active.type === h.type
      && active.ldir === h.ldir && active.sign === h.sign;
    ctx.fillStyle = '#4af';
    ctx.strokeStyle = '#cfe6ff';
    ctx.lineWidth = 1;
    ctx.globalAlpha = on ? 1 : 0.85;
    ctx.beginPath();
    if (h.type === 'end') {
      // Hollow: it is inside the shape, on the joint, and a filled dot there
      // reads as a point ON the surface.
      ctx.arc(h.x, h.y, 5, 0, Math.PI * 2);
      ctx.stroke();
      continue;
    }
    if (h.type === 'face') {
      ctx.rect(h.x - 4, h.y - 4, 8, 8);
    } else {
      ctx.moveTo(h.x, h.y - 5);
      ctx.lineTo(h.x + 5, h.y);
      ctx.lineTo(h.x, h.y + 5);
      ctx.lineTo(h.x - 5, h.y);
      ctx.closePath();
    }
    ctx.fill();
    ctx.stroke();
  }
  ctx.restore();
}

/**
 * Draw the cage.
 *
 * Dashed and dim on purpose: it is a guide behind whatever gizmo is up, and a
 * solid box round every selected part would read as part of the model.
 */
export function draw(ctx, cg, proj, cut = false) {
  const p = cg.corners.map(w => proj(w[0], w[1], w[2]));
  ctx.save();
  // A cut is drawn warm, the way the inspector warns in warm: what it bounds is
  // material coming OUT, and that is worth telling apart at a glance.
  ctx.strokeStyle = cut ? '#e5a55a' : '#4af';
  ctx.globalAlpha = 0.45;
  ctx.lineWidth = 1;
  ctx.setLineDash([3, 3]);
  ctx.beginPath();
  for (const [x, y] of EDGES) {
    ctx.moveTo(p[x][0], p[x][1]);
    ctx.lineTo(p[y][0], p[y][1]);
  }
  ctx.stroke();
  ctx.restore();
}
