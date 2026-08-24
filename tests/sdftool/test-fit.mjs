/**
 * fit — the frame that crops a sprite to its art.
 *
 * Pure Node. `tools/sdftool/fit.js` writes out a box per primitive, which is
 * knowledge duplicated from `prim()` in src/js/core/sdf.js and free to drift
 * from it. So this suite does not check the arithmetic against itself: it
 * RENDERS each primitive into a generous frame, finds the ink, and asserts the
 * ink lies inside the box fit predicted — and that the box is not absurdly
 * larger than the ink either, since a bound that is merely correct can still
 * be useless.
 *
 * The asymmetric primitives are the ones that make this worth having. The
 * pyramid grows upward from a base below its origin and the triangular prism's
 * apex is further out than its base; both crop if you assume symmetry.
 */
import SDF from '../../src/js/core/sdf.js';
import { genPalette } from '../../src/js/core/palette.js';
import { projectedBounds, fitFrame } from '../../tools/sdftool/fit.js';
import creature from '../../src/js/models/creature.js';

const W = 96, H = 96;
const pal = genPalette();
const s = new SDF(W, H, pal, { lo: 1, rampSize: 8 });

let fail = 0;
const check = (name, ok) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`);
  if (!ok) fail++;
};

const KINDS = ['sphere', 'box', 'capsule', 'torus', 'cylinder', 'cone',
  'octahedron', 'hex prism', 'ellipsoid', 'link', 'pyramid', 'capped torus',
  'tri prism'];

/** The ink's bounding box in camera-space world units, from a real render. */
function inkBounds(parts, view) {
  const col = s.render(parts, [[0.7, 0.7, 0.7]], view);
  const scale = (view.scale ?? 3) / Math.min(W, H);
  let x0 = W, x1 = -1, y0 = H, y1 = -1;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (!col[y * W + x]) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (x1 < 0) return null;
  // Pixel centres back to world, the inverse of sdf.js's scanline mapping.
  return [
    (x0 - W / 2 + 0.5) * scale + (view.vx ?? 0),
    (x1 - W / 2 + 0.5) * scale + (view.vx ?? 0),
    (H / 2 - y1 - 0.5) * scale + (view.vy ?? 0),
    (H / 2 - y0 - 0.5) * scale + (view.vy ?? 0),
  ];
}

// --- every primitive, unrotated and rotated ---------------------------------
// Sizes chosen so each shape is clearly not a sphere: a long capsule, a flat
// box, a tall cone. A bound that only works on round things proves nothing.
const PARTS = {
  0: [0.3, 0, 0, 0.34],
  1: [0.5, 0.18, 0.3, 0.03],
  2: [0.05, 0.62, 0, 0.1],
  3: [0.5, 0, 0, 0.09],
  4: [0.24, 0.6, 0, 0.03],
  5: [0.45, 0.55, 0.05, 0.02],
  6: [0.5, 0, 0, 0.03],
  7: [0.42, 0.2, 0, 0.03],
  8: [0.6, 0.22, 0.35, 0],
  9: [0.35, 0.2, 0, 0.08],
  10: [0.45, 0.7, 0, 0.02],
  11: [0.45, 0.7, 0.7, 0.08],
  12: [0.6, 0.2, 0, 0.03],
};

// The third pass is MIRRORED, and it is pushed off the plane on purpose: a
// mirrored part centred on x = 0 is its own mirror image, so it would pass on
// the un-mirrored arithmetic and prove nothing. At x = 0.5 the box has to cover
// both copies, or a symmetric model fits to half of itself.
for (const [rot, mir, cx, sc] of [
  [[0, 0, 0], 0, 0, 3],
  [[0.07, 0.13, 0.21], 0, 0, 3],
  [[0.07, 0.13, 0.21], 128, 0.5, 4],
]) {
  const tag = mir ? 'mirrored' : rot[0] ? 'rotated' : 'flat';
  for (const k of Object.keys(PARTS).map(Number)) {
    const [a, b, c, r] = PARTS[k];
    const parts = [k | mir, cx, 0, 0, ...rot, a, b, c, r, 0, 0];
    const view = { yaw: 0.08, pitch: 0.12, scale: sc };
    const ink = inkBounds(parts, view);
    const box = projectedBounds(parts, view);
    if (!ink) { check(`${KINDS[k]} ${tag} draws something`, false); continue; }
    // One pixel of tolerance: the ink box is measured at pixel centres and the
    // renderer resolves to half a pixel.
    const tol = 2 * view.scale / Math.min(W, H);
    const inside = ink[0] >= box[0] - tol && ink[1] <= box[1] + tol
      && ink[2] >= box[2] - tol && ink[3] <= box[3] + tol;
    check(`${KINDS[k]} ${tag}: the render fits inside the predicted box`, inside);
    // And the box must be TIGHT: a bound twice the size of the art is correct
    // and useless, and a sphere bound is exactly that on a long capsule.
    const slackU = (box[1] - box[0]) / Math.max(ink[1] - ink[0], 1e-6);
    const slackV = (box[3] - box[2]) / Math.max(ink[3] - ink[2], 1e-6);
    check(`${KINDS[k]} ${tag}: the box is tight (${slackU.toFixed(2)}x, ${slackV.toFixed(2)}x)`,
      slackU < 1.9 && slackV < 1.9);
  }
}

// --- a whole model ----------------------------------------------------------
{
  const view = creature[2];
  const ink = inkBounds(creature[0], view);
  const box = projectedBounds(creature[0], view);
  const tol = 2 * (view.scale ?? 3) / Math.min(W, H);
  check('a whole model fits inside its box',
    ink[0] >= box[0] - tol && ink[1] <= box[1] + tol
    && ink[2] >= box[2] - tol && ink[3] <= box[3] + tol);
}

// --- the frame it produces ---------------------------------------------------
// A standing capsule: 0.2 across, 1.8 tall. The renderer's own bound() calls
// that a 1.9-radius sphere and would fit it to a square — which is the entire
// reason this file exists.
{
  const pole = [2, 0, 0, 0, 0, 0, 0, 0, 0.8, 0, 0.1, 0, 0];
  const f = fitFrame(pole, { yaw: 0, pitch: 0 }, { max: 64 });
  check(`a tall thin part fits a tall thin frame (${f.w}x${f.h})`,
    f.h === 64 && f.w < 16);
  // The fit must be renderable AS FITTED: same scale, same offsets, no crop.
  const r2 = new SDF(f.w, f.h, pal, { lo: 1, rampSize: 8 });
  const col = r2.render(pole, [[0.7, 0.7, 0.7]],
    { yaw: 0, pitch: 0, scale: f.scale, vx: f.vx, vy: f.vy });
  let ink = 0, edge = 0;
  for (let y = 0; y < f.h; y++) {
    for (let x = 0; x < f.w; x++) {
      if (!col[y * f.w + x]) continue;
      ink++;
      if (x === 0 || y === 0 || x === f.w - 1 || y === f.h - 1) edge++;
    }
  }
  check(`the fitted frame renders the part (${ink} px)`, ink > f.w * f.h * 0.3);
  check('and nothing touches the frame edge', edge === 0);
}

// An off-centre part: without vx/vy the crop would cut it in half.
{
  const off = [1, 0.9, -0.6, 0, 0, 0, 0, 0.12, 0.5, 0.12, 0.02, 0, 0];
  const f = fitFrame(off, { yaw: 0, pitch: 0 }, { max: 48 });
  check(`an off-centre part moves the frame (vx ${f.vx}, vy ${f.vy})`,
    Math.abs(f.vx - 0.9) < 0.05 && Math.abs(f.vy + 0.6) < 0.05);
  const r3 = new SDF(f.w, f.h, pal, { lo: 1, rampSize: 8 });
  const col = r3.render(off, [[0.7, 0.7, 0.7]],
    { yaw: 0, pitch: 0, scale: f.scale, vx: f.vx, vy: f.vy });
  let ink = 0;
  for (let i = 0; i < col.length; i++) if (col[i]) ink++;
  check(`the off-centre part is IN the fitted frame (${ink} px)`,
    ink > f.w * f.h * 0.3);
}

// --- paint parts do not grow the frame --------------------------------------
{
  const view = { yaw: 0, pitch: 0 };
  const solid = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.3, 0, 0];
  const painted = [...solid, 64, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0.4, 0.2, 0];
  const a = projectedBounds(solid, view), b = projectedBounds(painted, view);
  check('a paint volume off to one side does not grow the frame',
    a.every((v, i) => Math.abs(v - b[i]) < 1e-9));
}

// --- fit clip: ONE frame that holds every pose ------------------------------
// `fit set` over time. A per-frame fit would centre each pose on its own art,
// so the origin would land somewhere different in every sprite and the
// character would shift under itself as it played. This is the check that the
// shared frame is genuinely big enough for all of them.
{
  const { models } = await import('../../tools/sdftool/sheet.js');
  const C = await import('../../tools/sdftool/clip.js');
  const { clipSheet } = await import('../../src/js/core/sdfanim.js');
  models.set('creature', creature);

  Object.assign(C.clip, {
    model: 'creature', view: { yaw: 0.25 }, w: 64, h: 64,
    frames: 6, fps: 10, mode: 0, frame: 0, groups: [], group: -1,
    channels: [
      // A big leg swing, so the frames genuinely differ in silhouette.
      { target: 4 * 13 + 4, values: [0.12, 0.2, 0.14, -0.12, -0.2, -0.14] },
      { target: 5 * 13 + 4, values: [-0.12, -0.2, -0.14, 0.12, 0.2, 0.14] },
      // And a bob, which is the case that could have defeated the fit: `vy`
      // moves what the frame LOOKS AT, so the correction has to fold into the
      // channel rather than into a clip-wide dial the channel overrides.
      { target: 'vy', values: [0, -0.06, 0, 0, -0.06, 0] },
    ],
  });

  const bobBefore = C.clip.channels[2].values.slice();
  const f = C.fitClip(48);
  check(`fit clip returns a frame (${f && `${f.w}x${f.h}`})`, !!f && f.w > 0 && f.h > 0);
  check('it does not warn when only vy is animated', f.warn === '');
  const bobAfter = C.clip.channels[2].values;
  check('the correction folded INTO the vy channel',
    bobAfter.join() !== bobBefore.join());
  // And the bob survived it: a fit that flattened the channel would have
  // "fitted" the clip by deleting the motion.
  const span = v => Math.max(...v) - Math.min(...v);
  check(`the bob survives the fit (span ${span(bobBefore)} -> ${span(bobAfter)})`,
    Math.abs(span(bobAfter) - span(bobBefore)) < 1e-6);

  // THE ASSERTION THAT CARRIES IT: render every frame at the fitted size and
  // check that none of them touches the edge. Ink on the border means the pose
  // was cropped, and a crop that only happens on frame 4 is the exact bug a
  // shared frame exists to prevent.
  const rows = clipSheet(C.clipArray());
  const rc = new SDF(C.clip.w, C.clip.h, pal, { lo: 1, rampSize: 8 });
  let worstEdge = 0, thinnest = 1e9;
  for (const row of rows) {
    const px = rc.render(row[0][0], row[0][1], { ...row[0][2], ...row[1] });
    let ink = 0, edge = 0;
    for (let y = 0; y < C.clip.h; y++) {
      for (let x = 0; x < C.clip.w; x++) {
        if (!px[y * C.clip.w + x]) continue;
        ink++;
        if (x === 0 || y === 0 || x === C.clip.w - 1 || y === C.clip.h - 1) edge++;
      }
    }
    worstEdge = Math.max(worstEdge, edge);
    thinnest = Math.min(thinnest, ink);
  }
  check(`every frame draws something (thinnest ${thinnest} px)`, thinnest > 200);
  check(`no frame touches the edge of the shared frame (${worstEdge} px)`, worstEdge === 0);

  // The frames must also agree on where the model's origin sits — that is the
  // whole point of one shared frame rather than six fitted ones.
  check('every frame is the same size', rows.every(r => r[2] === C.clip.w && r[3] === C.clip.h));
}

console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);
