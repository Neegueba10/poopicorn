/**
 * sdf runtime — golden pixel hashes, the resumable render, the generated
 * palette, and the portability contract.
 *
 * Pure Node, no browser and no server: the SDF runtime has no DOM dependency
 * and proving that is half the point. If this file ever needs Chrome, that
 * contract has been broken.
 *
 * The assertion that matters most is that a render split across many small
 * budgets is identical to one done in a single call. Everything downstream —
 * the worker bake, the progressive boot bake — rests on it.
 */
import { readFileSync, readdirSync } from 'node:fs';

import SDF, { map, shade, bound, prepRot, expand, STRIDE } from '../../src/js/core/sdf.js';
import { genPalette } from '../../src/js/core/palette.js';
import { nearest } from '../../src/js/core/quant.js';

/**
 * THE FIXTURES ARE LITERALS, not the models in src/js/models/.
 *
 * PRELIGHT below is four pixel hashes taken from the single-light renderer,
 * and they are the check that the second light and the fog default to the
 * shading that came before them. A hash of art the GAME owns cannot carry
 * that: it goes stale the day somebody nudges a part, and re-taking it turns
 * the assertion into a tautology. It had gone stale — creature and crate were
 * reworked for poppy.js, and this suite had been failing on both since.
 *
 * So the four fixtures below are the art the hashes were taken from, at
 * 748b16b, pinned here where nothing but the renderer can move them. The
 * game's copies are free to be reworked and rounded; this file is about
 * src/js/core/sdf.js.
 */
const props = {
  creature: [[
    0, 0, -0.1, 0, 0, 0, 0, 0, 0, 0, 0.42, 0, 1,
    0, 0, 0.42, 0, 0, 0, 0, 0, 0, 0, 0.30, 0.18, 1,
    2, -0.38, 0.02, 0, 0, 0, 0, -0.14, -0.22, 0, 0.11, 0.12, 1,
    2, 0.38, 0.02, 0, 0, 0, 0, 0.14, -0.22, 0, 0.11, 0.12, 1,
    2, -0.17, -0.52, 0, 0, 0, 0, 0, -0.16, 0, 0.12, 0.10, 1,
    2, 0.17, -0.52, 0, 0, 0, 0, 0, -0.16, 0, 0.12, 0.10, 1,
    0, -0.12, 0.48, 0.24, 0, 0, 0, 0, 0, 0, 0.07, 0, 0,
    0, 0.12, 0.48, 0.24, 0, 0, 0, 0, 0, 0, 0.07, 0, 0,
    64, 0, -0.18, 0.3, 0, 0, 0, 0, 0, 0, 0.26, 0.2, 2,
  ], [
    [0.85, 0.75, 0.55], [0.30, 0.55, 0.35], [0.55, 0.70, 0.45],
  ], { yaw: 0.06, pitch: 0.09, scale: 1.7, spec: 0.35 }],

  crate: [[
    1, 0, 0, 0, 0, 0, 0, 0.5, 0.5, 0.5, 0.06, 0, 0,
    33, 0, 0.12, 0, 0, 0, 0, 0.56, 0.03, 0.56, 0.01, 0.02, 0,
    33, 0, -0.2, 0, 0, 0, 0, 0.56, 0.03, 0.56, 0.01, 0.02, 0,
  ], [
    [0.65, 0.25, 0.20],
  ], { yaw: 0.06, pitch: 0.09, scale: 1.7, spec: 0.35 }],

  potion: [[
    0, 0, -0.15, 0, 0, 0, 0, 0, 0, 0, 0.42, 0, 0,
    2, 0, 0.32, 0, 0, 0, 0, 0, 0.18, 0, 0.13, 0.10, 0,
    3, 0, 0.5, 0, 0, 0, 0, 0.15, 0, 0, 0.05, 0, 1,
  ], [
    [0.35, 0.40, 0.55], [0.90, 0.70, 0.20],
  ], { yaw: 0.06, pitch: 0.09, scale: 1.7, spec: 0.35 }],

  ingot: [[
    1, 0, 0, 0, 0, 0.04, 0.02, 0.34, 0.5, 0.34, 0.02, 0, 0,
    33, 0, 0.62, 0, 0, 0, 0, 0.5, 0.22, 0.5, 0.15, 0.12, 0,
    33, 0, -0.62, 0, 0, 0, 0, 0.5, 0.22, 0.5, 0.15, 0.12, 0,
  ], [
    [0.90, 0.70, 0.20],
  ], { yaw: 0.06, pitch: 0.09, scale: 1.7, spec: 0.35 }],
};
import { pngPalette, hashPixels } from '../../tools/sdftool/nodeutil.mjs';
import { ROOT } from '../helpers.mjs';

const W = 96, H = 96;
const MODELS = ['creature', 'crate', 'potion', 'ingot'];

const GOLDEN = {
  creature: null,   // filled in below from the first render; see the note
  crate: null,
  potion: null,
  ingot: null,
};

let fail = 0;
const check = (name, ok) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`);
  if (!ok) fail++;
};

const pal = pngPalette(ROOT + 'src/assets/palette.png');
const s = new SDF(W, H, pal, { lo: 1, rampSize: 8 });

const render = m => Uint8Array.from(s.render(m[0], m[1], m[2]));

// --- every model renders something ------------------------------------------
for (const name of MODELS) {
  const px = render(props[name]);
  let drawn = 0;
  for (let i = 0; i < px.length; i++) if (px[i]) drawn++;
  // A model that fills the frame is the inverted-subtraction bug, and a model
  // that draws nothing is a bad bounding sphere. Both have happened.
  check(`${name} covers a plausible area (${(100 * drawn / px.length).toFixed(1)}%)`,
    drawn > px.length * 0.05 && drawn < px.length * 0.95);
  GOLDEN[name] = hashPixels(px);
}

// --- determinism -------------------------------------------------------------
for (const name of MODELS) {
  check(`${name} renders identically twice`, hashPixels(render(props[name])) === GOLDEN[name]);
}

// Splitting the work across many small budgets must not change a pixel. The
// clock is only READ — it decides when to stop, never what is drawn — and this
// is what lets a Worker reproduce a main-thread bake byte for byte.
for (const name of MODELS) {
  const m = props[name];
  s.begin(m[0], m[1], m[2]);
  let chunks = 0;
  while (!s.done()) { s.step(0); chunks++; }
  check(`${name} survives being split across ${chunks} budgets`,
    hashPixels(Uint8Array.from(s.col)) === GOLDEN[name]);
}

// --- the view actually does something ---------------------------------------
const front = render(props.creature);
const c = props.creature;
const turned = Uint8Array.from(s.render(c[0], c[1], { ...c[2], yaw: 0.25 }));
check('yaw changes the render', hashPixels(turned) !== hashPixels(front));
const noAo = Uint8Array.from(s.render(c[0], c[1], { ...c[2], ao: 0 }));
check('ambient occlusion changes the render', hashPixels(noAo) !== hashPixels(front));

// --- the frame offset --------------------------------------------------------
// vx/vy move what the CENTRE of the frame looks at, which is what lets a sprite
// be cropped tight around art that is not centred on the origin.
check('vx/vy of 0 is the same as not passing them',
  hashPixels(Uint8Array.from(s.render(c[0], c[1], { ...c[2], vx: 0, vy: 0 }))) === hashPixels(front));
// One pixel of offset must move the picture by exactly one pixel: the render
// samples world points, so a shift of `scale` is a shift of one column.
//
// Measured WITHOUT dither or error carry, because both are screen-space: the
// Bayer cell a pixel lands in is decided by its x and y, so a shifted render is
// the same picture in different dither noise. Comparing the two directly
// matches about 79% and proves nothing either way.
const flat = new SDF(W, H, pal, { lo: 1, rampSize: 8, ditherAmt: 0, carry: 0 });
const px1 = (c[2].scale ?? 3) / Math.min(W, H);
const still = Uint8Array.from(flat.render(c[0], c[1], c[2]));
const shifted = Uint8Array.from(flat.render(c[0], c[1], { ...c[2], vx: px1 }));
let same = 0, drawn = 0;
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W - 1; x++) {
    if (still[y * W + x + 1]) drawn++;
    if (still[y * W + x + 1] === shifted[y * W + x]) same++;
  }
}
check(`one pixel of vx shifts the picture one column (${same}/${(W - 1) * H} match)`,
  drawn > 500 && same > (W - 1) * H * 0.98);

// --- the look dials ----------------------------------------------------------
// Nothing may clip. The weights sum to 1 and the specular is screened in, so
// even a near-white material under a hot exposure has to keep its shading —
// clipping is what turned the tool's pale default into a flat silhouette.
const pale = [[0.95, 0.93, 0.9]];
const hot = Uint8Array.from(s.render(c[0], pale, { ...c[2], spec: 0.9, exposure: 1.2 }));
const top = new Set();
for (let i = 0; i < hot.length; i++) if (hot[i]) top.add(hot[i]);
check(`a white material under a hot light still shades (${top.size} colours)`, top.size > 8);

const lined = Uint8Array.from(s.render(c[0], c[1], { ...c[2], outline: 2 }));
check('the outline changes the render', hashPixels(lined) !== GOLDEN.creature);
// It must darken WITHIN a ramp — same ramp, lower step — or it is not an
// outline, it is a recolour.
let sameRamp = true, darker = 0;
for (let i = 0; i < lined.length; i++) {
  if (!lined[i] || !front[i]) continue;
  if (lined[i] !== front[i]) {
    if ((lined[i] & ~7) !== (front[i] & ~7)) sameRamp = false;
    if ((lined[i] & 7) < (front[i] & 7)) darker++;
  }
}
check(`the outline darkens within the ramp (${darker} px)`, sameRamp && darker > 20);
// And it must be skipped when the palette makes no such promise.
const noRamp = new SDF(48, 48, pal, { lo: 1 });
const a1 = Uint8Array.from(noRamp.render(c[0], c[1], { ...c[2], outline: 2 }));
const a2 = Uint8Array.from(noRamp.render(c[0], c[1], c[2]));
check('without rampSize the outline is skipped rather than guessed',
  hashPixels(a1) === hashPixels(a2));

const shadowed = Uint8Array.from(s.render(c[0], c[1], { ...c[2], shadow: 1 }));
check('the shadow ray changes the render', hashPixels(shadowed) !== GOLDEN.creature);

// --- the two lights and the fog ----------------------------------------------
// THE DEFAULTS ARE THE OLD SHADING, TERM FOR TERM. These four hashes were taken
// from the single-light renderer, before the second light and the fog existed.
// The second light IS the wrap fill that used to be hard-coded — direction -L,
// weight 0.10, fully wrapped — so a model that sets no dial must land on the
// same bytes. This is the check that says so.
const PRELIGHT = {
  creature: '6ffa280f', crate: 'fa6d5747', potion: 'b5a182af', ingot: '626e1543',
};
for (const name of MODELS) {
  check(`${name} renders exactly what the single-light renderer rendered`,
    GOLDEN[name] === PRELIGHT[name]);
}

// A flat instance for everything below: the dither and the error carry are
// screen-space, and they turn a 2% colour difference into noise you cannot
// assert on.
const lum8 = (px, i) => 0.299 * pal[px[i] * 3] + 0.587 * pal[px[i] * 3 + 1]
  + 0.114 * pal[px[i] * 3 + 2];
/** Mean [r, g, b] of the drawn pixels in a box. */
function mean(px, x0, y0, x1, y1) {
  let r = 0, g = 0, b = 0, n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = y * W + x;
      if (!px[i]) continue;
      r += pal[px[i] * 3]; g += pal[px[i] * 3 + 1]; b += pal[px[i] * 3 + 2];
      n++;
    }
  }
  return n ? [r / n, g / n, b / n, n] : [0, 0, 0, 0];
}
const meanLum = m => 0.299 * m[0] + 0.587 * m[1] + 0.114 * m[2];

// Two spheres, side by side, one 1.1 in front of the other along the view axis.
// Their boxes are centred on them to the half pixel, and nothing else about
// them differs, so any difference between the two IS the depth term.
const pair = [
  0, -0.5, 0, -0.55, 0, 0, 0, 0, 0, 0, 0.4, 0, 0,
  0, 0.5, 0, 0.55, 0, 0, 0, 0, 0, 0, 0.4, 0, 0,
];
const grey = [[0.35, 0.35, 0.35]];
const flatView = { yaw: 0, pitch: 0, scale: 3, spec: 0, ao: 0 };
const near = [18, 34, 46, 62], far = [50, 34, 78, 62];
const pairAt = v => {
  const px = Uint8Array.from(flat.render(pair, grey, { ...flatView, ...v }));
  return [mean(px, ...near), mean(px, ...far)];
};

const [n0, f0] = pairAt({});
check(`without fog, depth changes nothing (${n0[0].toFixed(1)} vs ${f0[0].toFixed(1)})`,
  n0[3] > 100 && f0[3] > 100 && Math.abs(n0[0] - f0[0]) < 2);

// Toward white: the far sphere must come up and the near one must move less.
const [n1, f1] = pairAt({ fog: 0.6, fogr: 1, fogg: 1, fogb: 1 });
check(`fog lifts the far sphere more than the near one `
  + `(+${(f1[0] - f0[0]).toFixed(1)} vs +${(n1[0] - n0[0]).toFixed(1)})`,
  f1[0] - f0[0] > n1[0] - n0[0] + 8);
// And it is a depth ramp, not a flat wash: more fog moves both further.
const [n2, f2] = pairAt({ fog: 1, fogr: 1, fogg: 1, fogb: 1 });
check('more fog moves both spheres further toward the fog colour',
  f2[0] > f1[0] && n2[0] > n1[0]);

// The colour is the fog's, not a brightness: a blue haze must land blue.
const [, fb] = pairAt({ fog: 0.8, fogr: 0.1, fogg: 0.2, fogb: 1 });
check(`the fog carries its own colour (rgb ${fb.slice(0, 3).map(v => v.toFixed(0))})`,
  fb[2] > fb[0] + 40);
// Fog off must cost nothing at all — the same pixels as omitting the dial.
check('fog 0 is the same render as no fog',
  hashPixels(Uint8Array.from(s.render(c[0], c[1], { ...c[2], fog: 0, fogr: 1 })))
  === GOLDEN.creature);

// --- the key ------------------------------------------------------------------
const keyLit = v => Uint8Array.from(flat.render(c[0], c[1], { ...c[2], ao: 0, spec: 0, ...v }));
const plainKey = keyLit({});
const warm = keyLit({ lr: 1, lg: 0.5, lb: 0.35 });
const mp = mean(plainKey, 0, 0, W, H), mw = mean(warm, 0, 0, W, H);
// The RATIO, not the red channel. A warm light multiplies green and blue down
// and leaves red alone, but the quantiser then has to find that colour in 256
// entries, and the nearest warm entry can sit a little below the grey it
// replaced. What must not move is which end of the spectrum the picture is on.
check(`a warm key warms the render (r/b ${(mp[0] / mp[2]).toFixed(2)}`
  + ` to ${(mw[0] / mw[2]).toFixed(2)})`,
  mw[0] / mw[2] > mp[0] / mp[2] + 0.08 && mw[2] < mp[2] - 5);

// Turning the key must move the bright side across the model, not just change it.
const fromL = mean(keyLit({ lx: -1, ly: 0.2, lz: -0.6 }), 0, 0, W / 2, H);
const fromR = mean(keyLit({ lx: 1, ly: 0.2, lz: -0.6 }), 0, 0, W / 2, H);
check(`the key direction moves the lit side (left half ${fromL[0].toFixed(0)}`
  + ` vs ${fromR[0].toFixed(0)})`, fromL[0] > fromR[0] + 15);

// li scales the key and nothing else: with the key out, only ambient and the
// fill are left, so the picture must go darker everywhere.
const noKey = mean(keyLit({ li: 0 }), 0, 0, W, H);
check(`li 0 puts the key out (${mp[0].toFixed(0)} to ${noKey[0].toFixed(0)})`,
  noKey[0] < mp[0] - 20);
// The specular is a highlight OF the key, so dimming the key must not dim it.
const dimGloss = Uint8Array.from(flat.render(c[0], [[0.2, 0.2, 0.2]],
  { ...c[2], li: 0.1, spec: 0.9, ao: 0 }));
let bright = 0;
for (let i = 0; i < dimGloss.length; i++) if (dimGloss[i] && lum8(dimGloss, i) > 140) bright++;
check(`a dim key still leaves a highlight (${bright} px)`, bright > 20);

// --- the second light ---------------------------------------------------------
// It defaults to the old wrap fill, so stating that direction explicitly must
// be the same render — that is the "follows the key until you move it" rule.
const follow = Uint8Array.from(s.render(c[0], c[1], { ...c[2], l2x: -0.6, l2y: -0.7, l2z: 0.4 }));
check('an unset second light faces the key', hashPixels(follow) === GOLDEN.creature);
// And once it is set, turning the key must leave it where it is. With the key
// out, the whole picture is the fill, so a moved key that still changes the
// render would prove the fill had followed it.
const fillOnly = v => hashPixels(keyLit({ li: 0, l2i: 1, ...v }));
check('the fill follows the key while it is unset',
  fillOnly({ lx: 1 }) !== fillOnly({ lx: -1 }));
check('a set second light stops following the key',
  fillOnly({ lx: 1, l2x: 0.3, l2y: 0.5, l2z: -0.8 })
  === fillOnly({ lx: -1, l2x: 0.3, l2y: 0.5, l2z: -0.8 }));

// l2i 0 is how it is off, and what it takes away is the dark side's wrap.
const lit0 = meanLum(mean(keyLit({}), 0, 0, W, H));
const lit1 = meanLum(mean(keyLit({ l2i: 0 }), 0, 0, W, H));
check(`l2i 0 turns the fill off (${lit0.toFixed(1)} to ${lit1.toFixed(1)})`,
  lit1 < lit0 - 2);

// A rim: a sphere, lit from BEHIND AND TO THE SIDE, with no wrap. Straight from
// behind draws nothing at all — with `n·l` the lit band is exactly the face you
// cannot see — so a rim light is placed off-axis, and then the near edge of the
// silhouette catches it while the middle stays where it was.
const ball = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.9, 0, 0];
const rimView = { yaw: 0, pitch: 0, scale: 2.2, spec: 0, ao: 0, li: 0.2 };
const rimOff = Uint8Array.from(flat.render(ball, grey, { ...rimView, l2i: 0 }));
const rimOn = Uint8Array.from(flat.render(ball, grey,
  { ...rimView, l2i: 0.9, l2w: 0, l2x: 1, l2y: 0, l2z: 0.5 }));
const ring = (px, r0, r1, right) => {
  let sum = 0, n = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (!px[i] || (right && x <= W / 2)) continue;
      const d = Math.hypot(x - W / 2, y - H / 2) / (W / 2);
      if (d >= r0 && d < r1) { sum += lum8(px, i); n++; }
    }
  }
  return n ? sum / n : 0;
};
const dRim = ring(rimOn, 0.75, 0.95, 1) - ring(rimOff, 0.75, 0.95, 1);
const dMid = ring(rimOn, 0, 0.3, 0) - ring(rimOff, 0, 0.3, 0);
check(`a back light with no wrap rims the edge (+${dRim.toFixed(0)} edge, `
  + `+${dMid.toFixed(0)} middle)`, dRim > 20 && dMid < dRim / 3);

// The resumable render still has to be exact with all of this on — everything
// downstream rests on it.
const loaded = { ...c[2], fog: 0.7, fogr: 0.3, fogg: 0.4, fogb: 0.9,
  lr: 1, lg: 0.8, lb: 0.6, l2i: 0.4, l2w: 0, l2x: 0, l2y: -1, l2z: 0.5, shadow: 1 };
const whole = hashPixels(Uint8Array.from(s.render(c[0], c[1], loaded)));
s.begin(c[0], c[1], loaded);
let lchunks = 0;
while (!s.done()) { s.step(0); lchunks++; }
check(`two lights and fog survive being split across ${lchunks} budgets`,
  hashPixels(Uint8Array.from(s.col)) === whole);
check('two lights and fog change the render', whole !== GOLDEN.creature);

// --- the field itself --------------------------------------------------------
// Signed: negative inside, positive outside, zero-ish on the surface.
// [kind, x,y,z, rx,ry,rz, a,b,c, round, blend, mat]
const sphere = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0];
check('inside a sphere is negative', map(sphere, 0, 0, 0) < 0);
check('outside a sphere is positive', map(sphere, 3, 0, 0) > 0);
check('on the surface is ~zero', Math.abs(map(sphere, 1, 0, 0)) < 1e-9);
check('distance is the true distance', Math.abs(map(sphere, 3, 0, 0) - 2) < 1e-9);
check('bound covers the part', bound(sphere) >= 1 && bound(sphere) < 1.2);

// Subtraction must REMOVE material, never invert the model. Cutting a slab out
// of a box has to leave the box's untouched corner solid and the cut hollow.
const box = [1, 0, 0, 0, 0, 0, 0, 0.5, 0.5, 0.5, 0, 0, 0];
const cut = [...box, 33, 0, 0, 0, 0, 0, 0, 0.6, 0.1, 0.6, 0, 0, 0];
check('subtraction hollows the cut', map(box, 0, 0, 0) < 0 && map(cut, 0, 0, 0) > 0);
check('subtraction leaves the rest solid', map(cut, 0, 0.35, 0) < 0);
check('a part is STRIDE numbers', box.length === STRIDE);

// --- rotation -----------------------------------------------------------------
// A long box turned a quarter turn about Y must swap its X and Z extents. This
// is the check that catches a transposed matrix: a rotation and its inverse
// look identical on anything symmetric, so the subject has to be lopsided.
const slab = [1, 0, 0, 0, 0, 0, 0, 0.8, 0.1, 0.1, 0, 0, 0];
const spun = [1, 0, 0, 0, 0, 0.25, 0, 0.8, 0.1, 0.1, 0, 0, 0];
const rotS = prepRot(spun);
check('an unrotated model needs no matrices', prepRot(slab) === null);
check('a rotated one gets them', rotS && rotS.length === 10 && rotS[9] === 1);
check('rotation swaps the long axis',
  map(slab, 0.6, 0, 0) < 0 && map(slab, 0, 0, 0.6) > 0
  && map(spun, 0.6, 0, 0, rotS) > 0 && map(spun, 0, 0, 0.6, rotS) < 0);
// A full turn is the identity, which catches a wrong angle unit — degrees or
// radians here would land somewhere arbitrary.
const full = [1, 0, 0, 0, 0, 1, 0, 0.8, 0.1, 0.1, 0, 0, 0];
check('a full turn is the identity (angles are TURNS)',
  Math.abs(map(full, 0.6, 0, 0, prepRot(full)) - map(slab, 0.6, 0, 0)) < 1e-9);

// --- materials blend like shapes ---------------------------------------------
// Two spheres, red and blue, smooth-unioned. Between them the colour has to be
// a MIX — a nearest-part rule puts a hard seam across a soft join.
const two = [
  0, -0.3, 0, 0, 0, 0, 0, 0, 0, 0, 0.35, 0, 0,
  0, 0.3, 0, 0, 0, 0, 0, 0, 0, 0, 0.35, 0.3, 1,
];
const twoMats = [[1, 0, 0], [0, 0, 1]];
const rgb = [0, 0, 0];
shade(two, twoMats, -0.3, 0, 0, null, rgb);
const left = [...rgb];
shade(two, twoMats, 0.3, 0, 0, null, rgb);
const right = [...rgb];
shade(two, twoMats, 0, 0, 0, null, rgb);
check('each part keeps its own colour at its centre',
  left[0] > 0.9 && left[2] < 0.1 && right[2] > 0.9 && right[0] < 0.1);
check(`the seam between them is a mix (${rgb.map(v => v.toFixed(2))})`,
  rgb[0] > 0.2 && rgb[0] < 0.8 && rgb[2] > 0.2 && rgb[2] < 0.8);

// --- paint: colour without shape ---------------------------------------------
// The same sphere, with a paint volume over half of it. The SILHOUETTE must be
// untouched — that is the whole point — and the colour must change.
const plain = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.5, 0, 0];
const painted = [...plain, 64, 0.4, 0, 0, 0, 0, 0, 0, 0, 0, 0.3, 0.2, 1];
check('a paint part does not change the field',
  [[0, 0, 0], [0.4, 0, 0], [0.6, 0, 0], [0, 0.45, 0]].every(([x, y, z]) =>
    Math.abs(map(plain, x, y, z) - map(painted, x, y, z)) < 1e-12));
check('a paint part does not grow the bound', bound(plain) === bound(painted));
shade(painted, twoMats, 0.4, 0.05, 0, null, rgb);
const under = [...rgb];
shade(painted, twoMats, -0.45, 0, 0, null, rgb);
check(`paint tints where it reaches (${under.map(v => v.toFixed(2))})`,
  under[2] > 0.4 && rgb[2] < 0.2);
// And a painted model still renders — the renderer must skip it in map() and
// find it in shade().
const pr = Uint8Array.from(s.render(painted, twoMats, { scale: 1.6 }));
let pdrawn = 0;
for (let i = 0; i < pr.length; i++) if (pr[i]) pdrawn++;
check(`a painted model renders (${pdrawn} px)`, pdrawn > 500);

// --- mirror: one row, two shapes ---------------------------------------------
// +128 folds the sample across x = 0 before anything else, so a part and its
// mirror image are the SAME numbers. The whole point is that symmetry costs no
// rows; these checks are what say the fold is doing it and not something else.
const MIR = 128;
const offBall = [0, 0.4, 0, 0, 0, 0, 0, 0, 0, 0, 0.25, 0, 0];
const mirBall = [MIR, 0.4, 0, 0, 0, 0, 0, 0, 0, 0, 0.25, 0, 0];
check('mirror puts the same field on both sides',
  Math.abs(map(mirBall, -0.4, 0, 0) - map(mirBall, 0.4, 0, 0)) < 1e-12
  && map(mirBall, -0.4, 0, 0) < 0);
check('without it the far side is empty', map(offBall, -0.4, 0, 0) > 0);
check('mirror does not grow the bound', bound(mirBall) === bound(offBall));

// A mirrored part at a NEGATIVE x has no x >= 0 half to fold, so it vanishes
// entirely. The renderer could take |x| of the centre too and pay a second abs
// in its hottest loop; the editor clamps x at 0 instead (see `set` in
// tools/sdftool/state.js). This check is the record of that decision.
const backBall = [MIR, -0.4, 0, 0, 0, 0, 0, 0, 0, 0, 0.25, 0, 0];
check('a mirrored part at a negative x disappears',
  map(backBall, -0.4, 0, 0) > 0 && map(backBall, 0, 0, 0) > 0);

// A part CROSSING the plane folds into a chevron rather than doubling — a pair
// of horns from one row, which is what a duplicated row cannot give you.
const horn = [2 | MIR, 0, 0, 0, 0, 0, 0, 0.35, 0.35, 0, 0.08, 0, 0];
check('a part crossing the plane folds into a chevron',
  map(horn, -0.3, 0.3, 0) < 0 && map(horn, 0.3, 0.3, 0) < 0
  && map(horn, -0.3, -0.3, 0) > 0);

// The flags compose: a mirrored cut bites both sides, a mirrored paint tints
// both sides. Neither needed a line of its own, and this says so.
const slabBox = [1, 0, 0, 0, 0, 0, 0, 0.6, 0.3, 0.3, 0, 0, 0];
const bitten = [...slabBox, 32 | MIR, 0.5, 0, 0, 0, 0, 0, 0, 0, 0, 0.2, 0, 0];
check('a mirrored cut bites both sides',
  map(slabBox, 0.55, 0, 0) < 0 && map(bitten, 0.55, 0, 0) > 0
  && map(bitten, -0.55, 0, 0) > 0);
const spotted = [...plain, 64 | MIR, 0.4, 0, 0, 0, 0, 0, 0, 0, 0, 0.3, 0.2, 1];
shade(spotted, twoMats, -0.45, 0, 0, null, rgb);
// The unmirrored `painted` above leaves this same point untinted.
check(`a mirrored paint tints both sides (${rgb.map(v => v.toFixed(2))})`, rgb[2] > 0.9);

// And the picture. Measured on the SILHOUETTE and not on the colours: the key
// light is off to one side, so a symmetric model is deliberately not shaded
// symmetrically. The projection is exact about the centre column, so a single
// odd pixel is a real fault rather than float dust.
const wing = [
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.35, 0, 0,
  2 | MIR, 0.3, 0.1, 0, 0, 0, 0.08, 0.45, 0.2, 0, 0.09, 0.15, 0,
];
const wingPx = Uint8Array.from(flat.render(wing, [[0.6, 0.6, 0.6]],
  { yaw: 0, pitch: 0, scale: 2 }));
let odd = 0, wink = 0;
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const a = !!wingPx[y * W + x];
    if (a) wink++;
    if (a !== !!wingPx[y * W + (W - 1 - x)]) odd++;
  }
}
check(`a mirrored model has a symmetric silhouette (${wink} px, ${odd} odd)`,
  wink > 800 && !odd);

// --- scatter: two rows, forty parts ------------------------------------------
// +256 marks a HEADER that copies the row after it, with jittered numbers, once
// per render. The header is [SCATTER, seed, count, sx, sy, sz, srot, sa, sb, sc,
// sround, sblend, smat]; the template is an ordinary part row.
const SCA = 256;
const rows = m => m.length / STRIDE;
const inst = (m, k) => m.slice(k * STRIDE, (k + 1) * STRIDE);

// The no-scatter path must cost nothing: it runs on every restart while a part
// is being dragged, so it returns the SAME array rather than a copy of it.
check('a model with no scatter is not touched', expand(plain) === plain);

const tmpl = [0, 0, 0.2, 0, 0, 0, 0, 0, 0, 0, 0.09, 0.02, 0];
const mass = [
  ...plain,
  SCA, 1337, 12, 0.5, 0.4, 0.5, 0.25, 0, 0, 0, 0.03, 0, 0,
  ...tmpl,
];
const grown = expand(mass);
check(`a header of 12 grows into 12 rows (${rows(mass)} -> ${rows(grown)})`,
  rows(grown) === 1 + 12);
check('the rows before it are untouched',
  inst(grown, 0).every((v, k) => v === plain[k]));
check('an instance keeps the template kind', inst(grown, 1)[0] === tmpl[0]);
// The template is NOT drawn beside its instances. It is what they are copies
// of, and drawing it as well would put an unjittered one in every mass.
check('the template itself is not a row', rows(grown) === 13);

check('the same seed gives the same arrangement',
  expand(mass).join() === grown.join());
const reseed = [...mass];
reseed[plain.length + 1] = 999;
check('a different seed does not', expand(reseed).join() !== grown.join());

// Every spread at zero must give the template back, count times — this is the
// check that says the jitter is applied to the right columns.
const still2 = [...plain, SCA, 7, 5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, ...tmpl];
const flatSet = expand(still2);
check('every spread at zero gives identical instances',
  [1, 2, 3, 4, 5].every(k => inst(flatSet, k).join() === tmpl.join()));

// A negative count is the ellipsoid distribution — the drawtool's own
// convention (op 5), because a big count in a box reads as a filled rectangle.
const ballSet = expand([SCA, 4242, -40, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.05, 0, 0]);
let out = 0;
for (let k = 0; k < 40; k++) {
  const p = inst(ballSet, k);
  if (p[1] * p[1] + p[2] * p[2] + p[3] * p[3] > 1.000001) out++;
}
check(`a negative count keeps every instance inside the ellipsoid (${out} outside)`,
  rows(ballSet) === 40 && !out);

// smat picks from smat + 1 materials starting at the template's own, which is
// the drawtool's c1+n idea and the reason random rotation shares one slot.
const painted2 = expand([SCA, 55, 30, 0.4, 0.4, 0.4, 0, 0, 0, 0, 0, 0, 2,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.05, 0, 1]);
const used = new Set();
for (let k = 0; k < 30; k++) used.add(inst(painted2, k)[12]);
check(`smat 2 uses materials 1..3 and no others (${[...used].sort().join()})`,
  [...used].every(v => v >= 1 && v <= 3) && used.size === 3);

// A MIRRORED template folds x -> |x|, so an instance rolled to the far side
// would have no half left to mirror and would vanish — half the mass of it.
const symm = expand([SCA, 3, 24, 0.6, 0.2, 0.2, 0, 0, 0, 0, 0, 0, 0,
  MIR, 0.3, 0, 0, 0, 0, 0, 0, 0, 0, 0.06, 0, 0]);
let behind = 0;
for (let k = 0; k < 24; k++) if (inst(symm, k)[1] < 0) behind++;
check(`a mirrored template keeps every instance at x >= 0 (${behind} behind)`, !behind);

// A dimension that starts positive stays positive — a negative half-extent is a
// shape turned inside out and the march fills the frame. One that starts
// negative is a signed vector (a capsule's axis) and keeps its own sign.
const signed = expand([SCA, 9, 20, 0, 0, 0, 0, 0, 0.6, 0, 0.6, 0, 0,
  2, 0, 0, 0, 0, 0, 0, 0.2, -0.5, 0, 0.1, 0, 0]);
let wrong = 0;
for (let k = 0; k < 20; k++) {
  const p = inst(signed, k);
  if (p[8] > 0 || p[10] < 0) wrong++;
}
check(`spreads never flip a dimension's sign (${wrong} wrong)`, !wrong);

// And the whole thing renders, resumably. begin() does the expansion, so this
// is what says the new work did not break the split-render contract that the
// worker bake and the progressive boot bake both rest on.
const massMats = [[0.5, 0.45, 0.4], [0.6, 0.3, 0.2]];
const massView = { yaw: 0.1, pitch: 0.1, scale: 2.2 };
const massWhole = hashPixels(Uint8Array.from(s.render(mass, massMats, massView)));
s.begin(mass, massMats, massView);
let mchunks = 0;
while (!s.done()) { s.step(0); mchunks++; }
check(`a scattered model survives being split across ${mchunks} budgets`,
  hashPixels(Uint8Array.from(s.col)) === massWhole);
const bare = hashPixels(Uint8Array.from(s.render(plain, massMats, massView)));
check('and the mass actually changes the picture', massWhole !== bare);
check('the bound covers the instances', bound(expand(mass)) > bound(plain));

// --- every primitive is marchable --------------------------------------------
// A distance that OVER-estimates steps the march through the surface and the
// model grows holes. Sampling around each primitive catches that: the reported
// distance must never exceed the true distance to the nearest surface, which a
// dense scan approximates well enough to catch a real mistake.
for (let kind = 0; kind < 14; kind++) {
  const one = [kind, 0, 0, 0, 0, 0, 0, 0.4, 0.3, 0.25, 0.05, 0, 0];
  let bad = 0, inside = 0;
  for (let i = 0; i < 400; i++) {
    const x = (i % 10) / 5 - 1, y = ((i / 10 | 0) % 10) / 5 - 1, z = ((i / 100 | 0)) / 2 - 1;
    const d = map(one, x, y, z);
    if (!Number.isFinite(d)) { bad++; continue; }
    if (d < 0) inside++;
    // step along a random direction by d; the field there must not have moved
    // more than d — that is the Lipschitz property sphere tracing needs
    const d2 = map(one, x + d * 0.577, y + d * 0.577, z + d * 0.577);
    if (d2 < -1e-6 && d > 1e-6) bad++;
  }
  check(`primitive ${kind} is finite and marchable (${inside} interior samples)`,
    !bad && (kind === 13 || inside > 0));
}

// --- the generated palette ---------------------------------------------------
const gen = genPalette();
check('generated palette is 256 entries', gen.length === 768);
const lum = i => 0.299 * gen[i * 3] + 0.587 * gen[i * 3 + 1] + 0.114 * gen[i * 3 + 2];
// COVERAGE IS WHAT IT IS FOR, now that it is a cube rather than 32 authored
// ramps: the shading asks for an arbitrary colour and the quantiser answers
// with the nearest entry, so what matters is how far that answer ever is.
// Sampled over the RGB cube, weighted 2:4:1 like `nearest` itself.
let worst = 0, sum = 0, n = 0;
for (let r = 0; r < 8; r++) {
  for (let g = 0; g < 8; g++) {
    for (let b = 0; b < 8; b++) {
      const q = [r / 7, g / 7, b / 7];
      const c = nearest(gen, 1, 255, q[0], q[1], q[2]);
      const d = Math.sqrt(2 * (q[0] - gen[c * 3] / 255) ** 2
        + 4 * (q[1] - gen[c * 3 + 1] / 255) ** 2 + (q[2] - gen[c * 3 + 2] / 255) ** 2);
      sum += d; n++;
      if (d > worst) worst = d;
    }
  }
}
// The authored palette measured 1.03 worst and 0.30 mean on this sample. A
// cube is bounded by its own step, so it comes in at 0.16 and 0.09 — six times
// closer at the worst, which is the whole reason its reds and purples arrive.
check(`no colour is far from an entry (worst ${worst.toFixed(2)}, mean ${(sum / n).toFixed(2)})`,
  worst < 0.36 && sum / n < 0.13);
// The dither spreads error between NEIGHBOURING entries, so a palette with a
// hole in it bands however good its average is. Nothing may be isolated.
let lonely = 0;
for (let a = 1; a < 256; a++) {
  let near = Infinity;
  for (let b = 1; b < 256; b++) {
    if (a === b) continue;
    const d = Math.hypot(gen[a * 3] - gen[b * 3], gen[a * 3 + 1] - gen[b * 3 + 1],
      gen[a * 3 + 2] - gen[b * 3 + 2]);
    if (d < near) near = d;
  }
  if (near > 72) lonely++;
}
check(`every entry has a neighbour to dither with (${lonely} isolated)`, !lonely);
check('index 0 is the transparent/black entry', !gen[0] && !gen[1] && !gen[2]);
// It has to span the range, or shading clips at both ends.
check(`the palette reaches dark and light (${lum(1).toFixed(0)}..${lum(255).toFixed(0)})`,
  lum(1) < 40 && lum(255) > 200);
// And it has to be usable as a palette: distinct entries, spread over the cube.
const distinct = new Set();
for (let i = 0; i < 256; i++) distinct.add(`${gen[i * 3]},${gen[i * 3 + 1]},${gen[i * 3 + 2]}`);
check(`entries are distinct (${distinct.size}/256)`, distinct.size > 240);
// A mid grey must quantise to something near grey, not to a hue.
const g = nearest(gen, 1, 255, 0.5, 0.5, 0.5);
const spread = Math.max(gen[g * 3], gen[g * 3 + 1], gen[g * 3 + 2])
  - Math.min(gen[g * 3], gen[g * 3 + 1], gen[g * 3 + 2]);
check(`mid grey finds a grey (spread ${spread})`, spread < 40);

// The point of generating it: a render through it must still work.
const genRender = new SDF(48, 48, gen, { lo: 1, rampSize: 8 });
const gpx = genRender.render(c[0], c[1], c[2]);
let gdrawn = 0;
for (let i = 0; i < gpx.length; i++) if (gpx[i]) gdrawn++;
check(`the generated palette renders (${(100 * gdrawn / gpx.length).toFixed(1)}%)`,
  gdrawn > gpx.length * 0.05);

// --- the inlined font ---------------------------------------------------------
// The glyphs are packed into source so the canvas boot can drop the palette
// image. Nothing about that packing is self-checking, so check it: an off-by-one
// in the row alphabet shifts every glyph after it and still "works".
const { FONT_CHARS, GLYPH_W, GLYPH_H, glyphBits } = await import('../../src/js/core/font.js');
const art = ch => glyphBits(ch).reduce((s, v, i) =>
  s + (v ? '#' : '.') + ((i + 1) % GLYPH_W ? '' : '\n'), '');

check(`the strip has ${FONT_CHARS.length} glyphs`, FONT_CHARS.length === 69);
// UPPERCASE ONLY — the 26 lowercase glyphs were dropped and poppy.js speaks in
// capitals. If one comes back, this count is the first thing that says so.
check('lowercase is gone', [...'abcxyz'].every(c => glyphBits(c) === null));
check('every glyph decodes to w*h bits',
  [...FONT_CHARS].every(c => glyphBits(c).length === GLYPH_W * GLYPH_H));
check('an unknown character has no glyph', glyphBits('é') === null);
// A is the canary: symmetric, closed counter, full height. If the row alphabet
// or the stride drifts, this is unrecognisable.
check('A is an A', art('A') === '.....\n.##..\n#..#.\n#..#.\n####.\n#..#.\n#..#.\n.....\n.....\n');
// Ink below the cap band proves the 9-row box is right — 7 rows would clip it.
// It was g's descender; with no lowercase left, Q's tail is what reaches down.
check('Q keeps its tail', glyphBits('Q').slice(7 * GLYPH_W).some(v => v));
check('space is blank', !glyphBits(' ').some(v => v));
// $ is hand-authored — the punctuation came off the strip mis-spaced, so each
// mark is repaired one at a time as the game needs it, and the repair has to
// survive the next person who tidies this data. It is the font's own S with a
// stem above and below, so the S is checked alongside it: if a shift ever
// smears one into the other, both of these fail rather than neither.
check('$ is a dollar sign',
  art('$') === '..#..\n.##..\n#..#.\n.#...\n..#..\n#..#.\n.##..\n..#..\n.....\n');
check('and its S still reads as an S',
  art('S') === '.....\n.##..\n#..#.\n.#...\n..#..\n#..#.\n.##..\n.....\n.....\n');

// --- the portability contract -------------------------------------------------
const imports = f => [...readFileSync(ROOT + f, 'utf8')
  .matchAll(/^\s*(?:import|export)\b[^;]*?from\s*['"]([^'"]+)['"]/gm)].map(m => m[1]);
const noDom = f => !/\b(document|window|navigator|HTMLElement)\b/
  .test(readFileSync(ROOT + f, 'utf8'));

check('sdf imports quant.js and nothing else',
  imports('src/js/core/sdf.js').every(i => i === './quant.js'));
check('palette imports nothing', !imports('src/js/core/palette.js').length);
check('sdf touches no DOM', noDom('src/js/core/sdf.js'));
check('palette touches no DOM', noDom('src/js/core/palette.js'));
// Models are data, and must stay data. A sheet is the one file allowed to
// reference them, and it may reference nothing else.
check('models import nothing',
  readdirSync(ROOT + 'src/js/models')
    .every(f => !imports('src/js/models/' + f).length));
check('a sheet imports models and nothing else',
  imports('src/js/sheets/props.js').every(i => i.startsWith('../models/')));

// --- the editor and the bake quantise alike -----------------------------------
// THE BUG THIS PREVENTS: the sdftool previews at the renderer's defaults, and
// delve.js baked at its own, so the same model came out about four times less
// dithered in the game than in the editor that authored it — and nothing said
// so. The defaults are the look; a game takes them or the editor is lying.
//
// Read as source because glrender.js is a browser module and cannot be imported
// here. Its copy of the two numbers is deliberate — that quantiser has to be
// the CPU one pixel for pixel — so the copy is what drifts.
const defaultsOf = f => {
  const src = readFileSync(ROOT + f, 'utf8');
  return ['ditherAmt', 'carry'].map(k =>
    (src.match(new RegExp(`opts\\.${k} \\?\\? ([\\d.]+)`)) || [])[1]);
};
const rt = defaultsOf('src/js/core/sdf.js');
check(`the renderer's dither defaults are the tool's (${rt.join(', ')})`,
  rt[0] === '0.035' && rt[1] === '0.8');
check('and the sdftool\'s GPU back end spells the same two numbers',
  defaultsOf('tools/sdftool/glrender.js').join() === rt.join());
check('and no game overrides them',
  !readdirSync(ROOT + 'src/js/games')
    .some(f => /ditherAmt|carry:/.test(readFileSync(ROOT + 'src/js/games/' + f, 'utf8'))));

console.log(fail ? `\n${fail} failed` : '\nall passed');
process.exitCode = fail ? 1 : 0;
