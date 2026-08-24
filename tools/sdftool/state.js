/**
 * Editor state: the model, its materials, and the view it previews at.
 *
 * The document is `[parts, mats, view]` — the exact array the game imports —
 * so what the editor edits IS the file, and there is no separate authoring
 * format to keep in sync. `parts` is flat, stride 10; see src/js/core/sdf.js
 * for what each column means.
 *
 * ORDER IS SEMANTIC. Parts blend against the accumulated field, not pairwise,
 * so moving a row up or down changes the shape — a subtraction only removes
 * what is already there. That is why the list has reorder buttons and why the
 * part index is the id.
 */

// RELATIVE, not '/src/...' like the other tool modules use: this file is also
// imported straight into Node by the pure-Node suites, which have no server to
// resolve an absolute path against. The browser clamps `..` at the root, so
// both resolve to the same file.
import { map, bound, prepRot } from '../../src/js/core/sdf.js';

export const KINDS = ['sphere', 'box', 'capsule', 'torus', 'cylinder', 'cone',
  'octahedron', 'hex prism', 'ellipsoid', 'link', 'pyramid', 'capped torus',
  'tri prism', 'plane'];
export const STRIDE = 13;
export const SUBTRACT = 32, PAINT = 64, MIRROR = 128, SCATTER = 256;

/** Column index by name, for the inspector. */
export const COL = {
  kind: 0, x: 1, y: 2, z: 3, rx: 4, ry: 5, rz: 6,
  a: 7, b: 8, c: 9, round: 10, blend: 11, mat: 12,
};

/**
 * Which of a, b, c, round mean anything for each kind, and what to call them.
 * A sphere with editable half-extents is three inputs that do nothing, and an
 * editor that shows fields with no effect teaches the wrong model of the
 * format. Keep in step with `prim` in src/js/core/sdf.js.
 */
export const FIELDS = [
  { round: 'radius' },                                                  // sphere
  { a: 'half w', b: 'half h', c: 'half d', round: 'corner' },           // box
  { a: 'axis x', b: 'axis y', c: 'axis z', round: 'radius' },           // capsule
  { a: 'major', round: 'minor' },                                       // torus
  { a: 'radius', b: 'half height', round: 'corner' },                   // cylinder
  { a: 'base r', b: 'half height', c: 'top r', round: 'corner' },       // cone
  { a: 'size', round: 'corner' },                                       // octahedron
  { a: 'radius', b: 'half depth', round: 'corner' },                    // hex prism
  { a: 'radius x', b: 'radius y', c: 'radius z' },                      // ellipsoid
  { a: 'half length', b: 'ring r', round: 'tube r' },                   // link
  { a: 'half base', b: 'height', round: 'corner' },                     // pyramid
  { a: 'major', b: 'cap sin', c: 'cap cos', round: 'minor' },           // capped torus
  { a: 'size', b: 'half depth', round: 'corner' },                      // tri prism
  { a: 'normal x', b: 'normal y', c: 'normal z', round: 'offset' },     // plane
];

/**
 * The `a, b, c, round` a freshly added part starts at, per kind.
 *
 * One row of numbers for every primitive was the same 0.3/0.25, which is wrong
 * twice: it arrives filling the viewport, and on every kind with a `corner` the
 * corner was large enough to round the shape into a blob — a new box read as a
 * sphere. So each kind gets dimensions of roughly 0.15–0.2 world units, and
 * every `corner` starts at 0 or near it. Columns the kind does not read are 0,
 * which also keeps them out of the saved file.
 *
 * Keep in step with FIELDS and with `prim` in src/js/core/sdf.js.
 */
export const NEW_DIMS = [
  [0, 0, 0, 0.2],             // sphere: radius
  [0.15, 0.15, 0.15, 0],      // box: half extents, square corners
  [0, 0.15, 0, 0.07],         // capsule: standing up
  [0.18, 0, 0, 0.05],         // torus
  [0.12, 0.15, 0, 0],         // cylinder
  [0.15, 0.15, 0.02, 0],      // cone: nearly a point on top
  [0.2, 0, 0, 0],             // octahedron
  [0.15, 0.1, 0, 0],          // hex prism
  [0.18, 0.12, 0.12, 0],      // ellipsoid
  [0.1, 0.12, 0, 0.04],       // link
  [0.15, 0.25, 0, 0],         // pyramid
  [0.18, 0.7071, 0.7071, 0.05], // capped torus: a 45° cap, and b/c must be a unit pair
  [0.3, 0.1, 0, 0],           // tri prism: `a` is measured across, so it reads half its number
  [0, 1, 0, 0],               // plane: a floor through the origin
];

/**
 * Which column each LOCAL axis scales, per kind: `[x, y, z]`.
 *
 * The gizmo's scale handles edit the numbers the primitive actually reads —
 * the ask is "scale affects dimensions", not a transform, because this format
 * has no scale transform and adding one would cost the renderer a matrix per
 * part. So dragging the Y handle on a cylinder lengthens it (`b`, half height)
 * and dragging X or Z fattens it (`a`, radius), which is what the shape means.
 *
 * A repeated column is not a mistake: a cylinder has one radius, so X and Z
 * are the same number and dragging either changes both. `null` is a primitive
 * with nothing to scale on that axis.
 */
export const SCALE_COLS = [
  [10, 10, 10],       // sphere: radius, on any axis
  [7, 8, 9],          // box: half w/h/d
  [7, 8, 9],          // capsule: the axis vector itself
  [7, 10, 7],         // torus: major in XZ, minor is the tube
  [7, 8, 7],          // cylinder: radius, half height
  [7, 8, 7],          // cone: base radius, half height
  [7, 7, 7],          // octahedron: one size
  [7, 8, 7],          // hex prism: radius, half depth is Y here
  [7, 8, 9],          // ellipsoid: three radii
  [8, 7, 10],         // link: ring radius, half length in Y, tube
  [7, 8, 7],          // pyramid: half base, height
  [7, 7, 10],         // capped torus: major, minor
  [7, 7, 8],          // tri prism: size, half depth in Z
  [null, null, null], // plane: a normal and an offset; nothing to scale
];

/**
 * The lighting and fog dials, and what the renderer does when they are absent.
 *
 * A KEY HELD AT ITS DEFAULT IS NOT WRITTEN. There are eighteen of these and a
 * model usually touches two, so writing them all would put sixteen numbers of
 * noise in every file and in every diff. `fileText` and the save call prune
 * them; see `liveView`.
 *
 * `l2x`/`l2y`/`l2z` default to null and not to a number, because "unset" is a
 * real state there: the second light faces the key until one of the three is
 * written, which is the unlink the widget performs on its first drag.
 */
export const LIGHT_DEFAULTS = {
  lcam: 0,
  lx: 0.6, ly: 0.7, lz: -0.4, lr: 1, lg: 1, lb: 1, li: 0.74, lw: 0,
  l2x: null, l2y: null, l2z: null, l2r: 1, l2g: 1, l2b: 1, l2i: 0.1, l2w: 1,
  amb: 0.16,
  fog: 0, fogr: 0, fogg: 0, fogb: 0,
};

export const state = {
  name: 'untitled',
  parts: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.45, 0, 0],
  mats: [[0.45, 0.43, 0.4]],
  view: { yaw: 0.06, pitch: 0.09, scale: 1.7, spec: 0.35, ao: 1 },
  sel: 0,
  /**
   * The rows selected ALONGSIDE `sel`. See `selection` — `sel` stays the one
   * anchor every other part of the tool already reads.
   */
  also: [],
  dirty: false,
};

/**
 * The selected rows, anchor first.
 *
 * `sel` IS STILL THE ANCHOR and nothing else changed meaning: the inspector
 * edits it, a material swatch paints it, the clip tab poses it, and the mirror
 * plane is drawn for it. `also` only adds rows that a gizmo gesture carries
 * along — which is the whole of what multiple selection is for here.
 *
 * A SCATTER HEADER IS NEVER IN IT. Its columns 1..6 are a seed, a count and
 * position spreads, so a group move would write a translation into the number
 * that says how many pebbles there are. Its template carries the mass, and the
 * template is an ordinary row.
 */
export const selection = () => {
  if (state.sel < 0 || state.sel >= count()) return [];
  return [state.sel, ...state.also.filter(i => i >= 0 && i < count() && i !== state.sel)];
};
export const multi = () => selection().length > 1;
export const isSelected = i => i === state.sel || state.also.includes(i);

/** Select one row and drop the rest. Every plain click ends here. */
export function selectOnly(i) {
  state.sel = i;
  state.also = [];
}

/** Shift-click: add or remove a row, keeping the anchor if it can. Removing
 * the anchor promotes the next row in, so there is always one. */
export function toggleSelect(i) {
  if (i < 0 || i >= count() || isScatter(i)) return false;
  if (i === state.sel) {
    if (!state.also.length) return false;      // never leave nothing selected
    state.sel = state.also.shift();
    return true;
  }
  const at = state.also.indexOf(i);
  if (at >= 0) state.also.splice(at, 1);
  else state.also.push(i);
  return true;
}

/**
 * A row index is only meaningful against the row list it was taken from, and
 * every add, delete, reorder and undo renumbers rows. Remapping `also` through
 * all of that is a lot of chances to be subtly wrong about a working state that
 * is meant to last one gesture — so a structural change drops it instead.
 */
export const clearAlso = () => { state.also = []; };

/** The value the renderer will use for `k`, whether or not the model sets it. */
export const dial = k => state.view[k] ?? LIGHT_DEFAULTS[k];

/** True while the second light still faces the key. */
export const fillLinked = () =>
  state.view.l2x == null && state.view.l2y == null && state.view.l2z == null;

/** The second light's direction as the renderer resolves it — the key's,
 * negated, while it is linked. */
export function fillDir() {
  if (!fillLinked()) return [dial('l2x') || 0, dial('l2y') || 0, dial('l2z') || 0];
  return [-dial('lx'), -dial('ly'), -dial('lz')];
}

/** Set a dial, dropping the key when it lands back on its default. Passing
 * null clears it outright, which is how the fill is relinked. */
export function setDial(k, v) {
  if (v == null || (LIGHT_DEFAULTS[k] != null && v === LIGHT_DEFAULTS[k])) delete state.view[k];
  else state.view[k] = v;
}

/** The view as it is saved: without any dial still sitting on its default. */
export function liveView() {
  const out = {};
  for (const [k, v] of Object.entries(state.view)) {
    if (v == null) continue;
    if (k in LIGHT_DEFAULTS && v === LIGHT_DEFAULTS[k]) continue;
    out[k] = v;
  }
  return out;
}

export const count = () => state.parts.length / STRIDE;
export const part = i => state.parts.slice(i * STRIDE, (i + 1) * STRIDE);
export const get = (i, col) => state.parts[i * STRIDE + col];

/**
 * TWO DECIMAL PLACES: a model file never holds anything longer.
 *
 * A third digit is a byte in the zip and about a thirtieth of a pixel on
 * screen — these sprites bake at roughly 35 px per world unit, so 0.001 cannot
 * survive the quantiser, let alone the dither. Rounding the models poppy.js
 * ships took 139 B out of the zip.
 *
 * IT ROUNDS AT THE EDGES OF THE DOCUMENT — `fileText`, `loadModel`, and the
 * server's save — and NOT inside `set`. Quantising every write sounds tidier
 * and is worse: a group rotate writes six columns from a matrix and a group
 * scale writes a dimension and a centre, so rounding each intermediate makes
 * the error accumulate through the very gestures this editor measures to a
 * thousandth (tests/sdftool/test-multiselect.mjs holds a rotated pair's
 * spacing to 2e-3). Rounding once, at rest, costs those gestures nothing.
 *
 * Integers pass through unharmed, which matters for the columns that are not
 * lengths: `kind` and `mat`, and a SCATTER header's seed and count.
 */
export const q2 = v => Math.round(v * 100) / 100;

/**
 * Write one column.
 *
 * THE X CLAMP LIVES HERE, and it is the one place it can live. A mirrored part
 * folds `x -> |x|`, so a mirrored part at a negative x has no `x >= 0` half to
 * mirror and disappears entirely. The renderer could take `|m[i + 1]|` too, at
 * the price of a second abs in the hottest loop in the project; this is free.
 * Putting it in `set` means every writer obeys it — the inspector, the plane
 * drag, both gizmo handles, and whatever is written next.
 */
export const set = (i, col, v) => {
  state.parts[i * STRIDE + col] = col === COL.x && v < 0 && isMirror(i) ? 0 : v;
};
/** Apply rig.js's `[flatIndex, value]` writes to the document. Through `set`,
 * so the mirror clamp on x holds for a group move exactly as it does for a
 * single one. */
export function applyWrites(writes) {
  for (const [flat, v] of writes) set(Math.floor(flat / STRIDE), flat % STRIDE, v);
}

/** The primitive, with the flag bits masked off. */
export const kindOf = i => get(i, 0) & 31;
export const isCut = i => !!(get(i, 0) & SUBTRACT);
export const isPaint = i => !!(get(i, 0) & PAINT);
export const isMirror = i => !!(get(i, 0) & MIRROR);

/**
 * A SCATTER IS TWO ROWS: a header, then the template it copies. The pair is one
 * thing to the eye and has to be one thing to the hands — reorder it, duplicate
 * it or delete it and both rows go, or the file is left with a header pointing
 * at whatever happened to fall in behind it.
 */
export const isScatter = i => !!(get(i, 0) & SCATTER);
/** The template belonging to the header above it. */
export const isTemplate = i => i > 0 && isScatter(i - 1);
/** The rows that move together: `[first, length]`. */
export function groupAt(i) {
  if (isTemplate(i)) return [i - 1, 2];
  if (isScatter(i)) return [i, 2];
  return [i, 1];
}

// --- mutation ----------------------------------------------------------------

/** Append a part of `kind`, at the origin, sized from NEW_DIMS. */
export function addPart(kind = 0) {
  state.parts.push(kind, 0, 0, 0, 0, 0, 0, ...NEW_DIMS[kind & 31], 0.1, 0);
  selectOnly(count() - 1);
  return state.sel;
}

/**
 * Change a part's primitive, keeping its flags and whatever dimensions carry
 * over.
 *
 * A column the new kind reads but the old one left at 0 is re-seeded from
 * NEW_DIMS, because 0 in a dimension the shape needs is an invisible part — a
 * sphere switched to a cylinder has no radius and no height and vanishes. A
 * column that already holds a number is kept: switching kind to compare two
 * shapes must not throw away the size you dialled in.
 */
export function setKind(i, kind) {
  set(i, 0, (kind & 31) | (get(i, 0) & ~31));
  const dims = NEW_DIMS[kind & 31];
  for (const k of Object.keys(FIELDS[kind & 31])) {
    const col = COL[k];
    if (!get(i, col)) set(i, col, dims[col - COL.a]);
  }
}

/**
 * A scatter: the header, then the sphere it copies.
 *
 * The defaults are a visible mass rather than a safe one — twelve pebbles in an
 * ellipsoid, each a different size. A scatter that arrives looking like nothing
 * teaches nothing about what the dials do.
 */
export function addScatter() {
  state.parts.push(
    //  seed  count  sx   sy   sz  srot   sa sb sc  sround sblend smat
    SCATTER, 1337, -12, 0.5, 0.5, 0.5, 0.5, 0, 0, 0, 0.04, 0, 0,
    // the template
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.09, 0.03, 0,
  );
  selectOnly(count() - 2);
  return state.sel;
}

export function duplicatePart(i) {
  const [g, len] = groupAt(i);
  const rows = state.parts.slice(g * STRIDE, (g + len) * STRIDE);
  // Offset, or the copy hides inside the original. For a scatter that is the
  // TEMPLATE's x — the header's own slot 1 is the seed.
  const px = len === 2 ? STRIDE + 1 : 1;
  rows[px] += 0.15;
  // And a fresh seed: the same seed beside itself is the same arrangement
  // twice, which reads as a copy rather than as more of the same thing.
  if (len === 2) rows[1] = (rows[1] * 7 + 13) % 65535 || 1;
  state.parts.splice((g + len) * STRIDE, 0, ...rows);
  selectOnly(g + len);
}

/** False when this is the last thing in the model — a model with no parts
 * renders nothing at all. One rule, so the delete key can ask before it takes
 * an undo snapshot for a delete that will not happen. */
export const canDelete = i => count() - groupAt(i)[1] >= 1;

export function deletePart(i) {
  if (!canDelete(i)) return false;
  const [g, len] = groupAt(i);
  state.parts.splice(g * STRIDE, len * STRIDE);
  selectOnly(Math.min(g, count() - 1));
  return true;
}

/**
 * Delete every selected row.
 *
 * HIGHEST FIRST. Splicing row 2 renumbers row 5, so deleting in list order
 * would take out whatever fell into the slots behind. The same rule keeps the
 * last part in the model: rows come out one at a time and `deletePart` refuses
 * the last one, so a "select everything and press Delete" leaves one part
 * rather than an empty document.
 */
export function deleteSelection() {
  const rows = selection().sort((a, b) => b - a);
  if (!rows.length) return false;
  let any = false;
  for (const i of rows) if (deletePart(i)) any = true;
  return any;
}

/** Move a part up or down the list — which changes the SHAPE, not just the
 * list: a cut only removes what is already there.
 *
 * A scatter moves as a pair, and it steps over a neighbouring scatter as a pair
 * too. Stepping one row at a time would land a header between another header
 * and its template, which is a file the server refuses and a model nobody
 * meant. */
export function movePart(i, d) {
  const [g, len] = groupAt(i);
  const j = d < 0 ? g - 1 : g + len;
  if (j < 0 || j >= count()) return;
  const [n, nlen] = groupAt(j);
  const rows = state.parts.splice(g * STRIDE, len * STRIDE);
  const at = d < 0 ? n : g + nlen;
  state.parts.splice(at * STRIDE, 0, ...rows);
  selectOnly(at + (i - g));
}

/** Flags are independent of the primitive and of each other, except that a
 * PAINT part has no shape to subtract — the renderer skips it in map()
 * either way, so the editor keeps them exclusive rather than silently inert.
 *
 * MIRROR is exclusive of neither: a mirrored cut cuts both sides and a
 * mirrored paint tints both sides, and both are useful. */
export function setFlag(i, flag, on) {
  let k = get(i, 0);
  k = on ? (k | flag) : (k & ~flag);
  if (on && flag === PAINT) k &= ~SUBTRACT;
  if (on && flag === SUBTRACT) k &= ~PAINT;
  set(i, 0, k);
  // Turning the mirror on over a part sitting at a negative x would make it
  // vanish. Re-writing x through `set` is what clamps it.
  if (on && flag === MIRROR) set(i, COL.x, get(i, COL.x));
}
export const setCut = (i, on) => setFlag(i, SUBTRACT, on);

/**
 * Turn one mirrored part into two real ones.
 *
 * A MIRROR row is a fold in the sample, so both halves are the same numbers by
 * construction — which is exactly what you do not want once the two sides have
 * to move apart. An animated character's left arm and right arm are one row
 * here, and a clip channel writes one row, so a mirrored pair can only ever
 * wave both arms in step. Baking it spends one row to buy two independent ones.
 *
 * THE SECOND ROW IS DERIVED, NOT GUESSED. `map()` samples a mirrored part at
 * `(|x|, y, z)` and then rotates, so for the x < 0 half it evaluates
 * `f(A·M·(q − t'))` where `M = diag(−1, 1, 1)`, `A` is the part's world→local
 * matrix and `t'` is its position with x negated. Every primitive except the
 * capsule and the plane is symmetric under a local x flip, so `f(A·M·u)` is
 * `f(M·A·M·u)` and the copy's rotation is `M·A·M` — which in this file's Euler
 * order (Rz·Ry·Rx) is simply **rx kept, ry and rz negated**. The capsule and
 * the plane carry their x in column `a` — an axis and a normal — so that
 * number is negated instead of being symmetric for free. Checked against
 * models/creature.js, whose arms were authored as a hand-mirrored pair.
 *
 * A SCATTER IS REFUSED. Its instances are rolled from a seed at render time, so
 * two scatters would be two different arrangements rather than one reflected —
 * the copy would not be a mirror of anything.
 *
 * A PLANE IS REFUSED TOO, and for a reason that also bounds this whole feature.
 * The fold CLIPS each half at x = 0: the x > 0 side of a mirrored part is its
 * own shape and the x < 0 side is the reflection, and neither reaches across.
 * Two real rows are not clipped, so a part that STRADDLES the plane bakes into
 * more material than it had — its far half is added back. For a part sitting
 * clear of x = 0 the clip removes nothing and the bake is exact; a plane is
 * infinite and always straddles, so there is no version of it that works. See
 * `mirrorCrosses`, which is what the inspector warns from.
 */
export function bakeMirror(i) {
  if (!isMirror(i) || isScatter(i) || isTemplate(i)) return false;
  if (kindOf(i) === 13) return false;
  const row = part(i);
  row[0] &= ~MIRROR;
  row[COL.x] = -row[COL.x];
  row[COL.ry] = -row[COL.ry];
  row[COL.rz] = -row[COL.rz];
  const k = row[0] & 31;
  if (k === 2 || k === 13) row[COL.a] = -row[COL.a];
  set(i, 0, get(i, 0) & ~MIRROR);
  state.parts.splice((i + 1) * STRIDE, 0, ...row);
  selectOnly(i + 1);
  return true;
}

/**
 * Does this part reach across x = 0?
 *
 * MEASURED, NOT DERIVED FROM A TABLE. The obvious test — is `x` further from
 * the plane than the part's extent — needs a per-kind extent, and the only
 * extent already in the codebase is `bound()`'s, which is a sphere: it reads a
 * capsule's whole axis vector as reach along x and so warned about an arm, the
 * one case this feature exists for. Sampling the part's own field on the plane
 * asks `prim` directly, cannot drift out of step with it, and costs a thousand
 * evaluations of a one-row model.
 *
 * A distance field is 1-Lipschitz, so a sample sits at most half a grid step
 * above the true minimum between samples — hence the margin.
 *
 * THE SURFACE IS THE QUESTION, NOT THE BLEND. Adding `blend` to the margin is
 * defensible — the far half still pulls on a smooth union from that distance —
 * and it flagged the creature's arm, whose bake differs by 1.6e-4. A warning
 * that fires on the case the feature exists for is a warning nobody reads. The
 * blend seam is a few thousandths wide and invisible; the clip is not.
 */
export function mirrorCrosses(i) {
  if (kindOf(i) === 13) return true;                    // a plane is infinite
  // The shape alone: a cut or a paint part still has one, and `bound` skips a
  // paint part entirely.
  const row = part(i);
  row[0] &= 31;
  const r = bound(row);
  const rot = prepRot(row);
  const N = 33, step = (2 * r) / (N - 1);
  let min = Infinity;
  for (let iy = 0; iy < N; iy++) {
    for (let iz = 0; iz < N; iz++) {
      const d = map(row, 0, -r + iy * step, -r + iz * step, rot);
      if (d < min) min = d;
    }
  }
  return min < step / 2;
}

export function addMat(rgb = [0.7, 0.7, 0.7]) {
  state.mats.push(rgb);
  return state.mats.length - 1;
}

/**
 * Repaint a material.
 *
 * NOT QUANTISED HERE, for the same reason `set` is not: the picker hands over
 * an exact `channel / 255` and the editor keeps what it was given.  `fileText`
 * and the server round it on the way out.
 */
export function setMat(ix, rgb) {
  state.mats[ix] = rgb;
}

/** Drop a material and re-point every part that used it. Materials are
 * referenced by index, so deleting one without this silently repaints parts. */
export function deleteMat(ix) {
  if (state.mats.length < 2) return;
  state.mats.splice(ix, 1);
  for (let i = 0; i < count(); i++) {
    const m = get(i, COL.mat);
    // On a scatter header that column is a SPREAD, not an index — re-pointing
    // it would silently change how many materials the mass picks from. It only
    // has to stay inside the list that is left.
    if (isScatter(i)) set(i, COL.mat, Math.min(m, state.mats.length - 1));
    else set(i, COL.mat, m === ix ? 0 : m > ix ? m - 1 : m);
  }
}

// --- file --------------------------------------------------------------------

/** Mirrors the server's generated file (saveModel in tools/drawtool/server.js)
 * so the byte counter is honest; keep the two in sync. */
export function fileText() {
  const rows = [];
  for (let i = 0; i < state.parts.length; i += STRIDE) {
    rows.push('  ' + state.parts.slice(i, i + STRIDE).map(q2).join(', ') + ',');
  }
  const num = v => (Number.isInteger(v) ? v : +v.toFixed(2));
  return '// generated by tools/sdftool — [parts, mats, view]; stride 13, see src/js/core/sdf.js\n'
    + `export default [[\n${rows.join('\n')}\n], [\n`
    + state.mats.map(m => `  [${m.map(num).join(', ')}],`).join('\n')
    + `\n], {${Object.entries(liveView()).map(([k, v]) => `${k}: ${num(v)}`).join(', ')}}];\n`;
}

export async function listModels() {
  const r = await fetch('/api/models');
  return r.ok ? r.json() : [];
}

export async function loadModel(name) {
  const mod = await import(`/src/js/models/${name}.js?v=${Date.now()}`);
  const [parts, mats, view] = mod.default;
  state.name = name;
  // Quantised on the way in as well, so a model authored before the 2 dp rule
  // is in the same world as a new one the moment it is opened.
  state.parts = parts.map(q2);
  state.mats = mats.map(m => m.map(q2));
  state.view = { yaw: 0.06, pitch: 0.09, scale: 1.7, spec: 0.35, ao: 1, ...view };
  // null is a real state on l2x/l2y/l2z — the fill is linked — so only numbers.
  for (const [k, v] of Object.entries(state.view))
    if (Number.isFinite(v)) state.view[k] = q2(v);
  selectOnly(0);
  state.dirty = false;
  clearUndo();
}

export async function saveModel() {
  const r = await fetch('/api/save-model', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: state.name, parts: state.parts, mats: state.mats, view: liveView(),
    }),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(text);
  state.dirty = false;
  return JSON.parse(text);
}

// --- undo --- (JSON snapshots, cap 100, the same shape as the other tools')
//
// THE VIEW IS IN THE SNAPSHOT. It was not, so no dial was undoable — not the
// camera, not a scrub, and not the lights once they arrived. A light is dragged
// the way a part is dragged, so Ctrl+Z has to take it back the way it takes a
// part back. The cost is that an orbit is undoable too, which is the right
// answer for the same reason.
let undoStack = [];

export function pushUndo() {
  state.dirty = true;
  undoStack.push(JSON.stringify({ parts: state.parts, mats: state.mats, view: state.view }));
  if (undoStack.length > 100) undoStack.shift();
}

export function undo() {
  if (!undoStack.length) return false;
  const before = count();
  const s = JSON.parse(undoStack.pop());
  state.parts = s.parts;
  state.mats = s.mats;
  if (s.view) state.view = s.view;
  // A MULTIPLE SELECTION SURVIVES AN UNDO THAT DID NOT RENUMBER ROWS, and it
  // has to: taking back a group drag and trying it again is one gesture, and
  // dropping the selection in between makes that impossible. When the row count
  // moved, the indices mean something else and the selection goes.
  if (count() !== before) selectOnly(Math.min(state.sel, count() - 1));
  else state.sel = Math.min(state.sel, count() - 1);
  return true;
}

export const clearUndo = () => { undoStack = []; };

// --- change notification ---
const listeners = [];
export const onChange = fn => listeners.push(fn);
export const emit = () => listeners.forEach(fn => fn());
