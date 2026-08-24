/**
 * `lcam` — light directions read in CAMERA space instead of world space.
 *
 * Pure Node, like tests/sdftool/test-sdf.mjs: the runtime has no DOM
 * dependency and this suite must not grow one.
 *
 * The assertion that carries the feature is the one about a facing set. A
 * world-space light stays put while the camera orbits, so each facing of a
 * character is lit from a different side of the SCREEN — which is the whole
 * complaint `lcam` answers. So the suite measures the light in camera
 * components and asserts they do not move, and asserts that they do move
 * without the flag, or the test would pass on a renderer that ignored it.
 *
 * The tool's own conversion helpers are checked against the renderer's basis
 * rather than against a comment about it, the way tests/sdftool/test-rig.mjs
 * checks its Euler maths against `prepRot`.
 */
import SDF from '../../src/js/core/sdf.js';
import { camBasis, toWorld, toCam } from '../../tools/sdftool/lightwidget.js';
import creature from '../../src/js/models/creature.js';
import { pngPalette, hashPixels } from '../../tools/sdftool/nodeutil.mjs';
import { ROOT } from '../helpers.mjs';

const W = 64, H = 64;

let fail = 0;
const check = (name, ok) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`);
  if (!ok) fail++;
};

const pal = pngPalette(ROOT + 'src/assets/palette.png');
const s = new SDF(W, H, pal, { lo: 1, rampSize: 8 });
const [parts, mats] = creature;

/** The camera basis the renderer built, taken from the renderer itself. */
const basisOf = view => {
  s.begin(parts, mats, view);
  return { r: s.r, u: s.u, f: s.f, l1: s.l1, l2: s.l2 };
};

/** A world direction in the camera's own components: right, up, forward. */
const inCam = (d, b) => [b.r, b.u, b.f].map(a => a[0] * d[0] + a[1] * d[1] + a[2] * d[2]);

const near = (a, b, e = 1e-9) => a.every((v, i) => Math.abs(v - b[i]) < e);

const AIM = { lx: 0.6, ly: 0.7, lz: -0.4 };
const unit = ([x, y, z]) => {
  const l = Math.hypot(x, y, z);
  return [x / l, y / l, z / l];
};
const AIMED = unit([AIM.lx, AIM.ly, AIM.lz]);

// --- the two spaces agree where the camera is neutral ------------------------
// At yaw 0 pitch 0 the camera basis IS the world basis, so turning the flag on
// there must not change a pixel. That is what makes `lcam` safe to adopt.
const flat = { yaw: 0, pitch: 0, scale: 1.7, ...AIM };
check('at yaw 0 pitch 0 lcam renders the same pixels',
  hashPixels(Uint8Array.from(s.render(parts, mats, flat)))
  === hashPixels(Uint8Array.from(s.render(parts, mats, { ...flat, lcam: 1 }))));

// --- a facing set is lit from one side ---------------------------------------
const YAWS = [0, 0.125, 0.25, -0.3];
let held = true, moved = false;
for (const yaw of YAWS) {
  const view = { yaw, pitch: 0.09, scale: 1.7, ...AIM };
  const locked = basisOf({ ...view, lcam: 1 });
  const world = basisOf(view);
  if (!near(inCam(locked.l1, locked), AIMED, 1e-9)) held = false;
  // Without the flag the light slides round the screen as the camera turns —
  // the behaviour `lcam` exists to fix, asserted so this suite cannot pass on a
  // renderer that ignores the dial.
  if (yaw !== 0 && !near(inCam(world.l1, world), AIMED, 0.05)) moved = true;
}
check('lcam holds the key in the same place on screen at every yaw', held);
check('and without it the key slides round the screen', moved);

// The direction still reaches the world as a unit vector: the basis is
// orthonormal, so the rotation must not stretch it.
const turned = basisOf({ yaw: 0.3, pitch: -0.2, scale: 1.7, lcam: 1, ...AIM });
check(`lcam keeps the direction normalised (${Math.hypot(...turned.l1).toFixed(6)})`,
  Math.abs(Math.hypot(...turned.l1) - 1) < 1e-9);

// --- the fill --------------------------------------------------------------
// Linked, the fill is the key negated. It is negated AFTER the rotation, which
// is the same answer as before it, so the fill needs no rule of its own.
check('a linked fill still faces the key under lcam',
  near(turned.l2, turned.l1.map(v => -v)));
// Aimed, it turns with the camera too — a rim aimed at the screen's left edge
// has to stay on the left edge, or a facing set gains a swinging rim.
const rim = { yaw: 0.3, pitch: -0.2, scale: 1.7, lcam: 1, ...AIM, l2x: 0.9, l2y: 0.2, l2z: 0.4 };
check('an aimed fill is read in camera space as well',
  near(inCam(basisOf(rim).l2, basisOf(rim)), unit([0.9, 0.2, 0.4]), 1e-9));

// --- the tool's helpers agree with the renderer ------------------------------
// The widgets work in world space and the dials hold camera space, so a wrong
// basis here would aim the sun somewhere the bake does not light.
for (const [yaw, pitch] of [[0, 0], [0.125, 0.09], [-0.37, 0.42]]) {
  const b = basisOf({ yaw, pitch, scale: 1.7, lcam: 1, ...AIM });
  check(`camBasis matches the renderer at yaw ${yaw} pitch ${pitch}`,
    near(camBasis({ yaw, pitch }).r, b.r) && near(camBasis({ yaw, pitch }).u, b.u)
    && near(camBasis({ yaw, pitch }).f, b.f));
  const view = { yaw, pitch, lcam: 1 };
  check(`toWorld lands where the renderer put the light at yaw ${yaw}`,
    near(toWorld(AIMED, view), b.l1, 1e-12));
  check(`toCam is its inverse at yaw ${yaw}`, near(toCam(toWorld(AIMED, view), view), AIMED, 1e-12));
}

// Off, both are the identity — the promise that keeps every model authored
// before the flag untouched.
const off = { yaw: 0.3, pitch: 0.2 };
check('the helpers are the identity while lcam is off',
  toWorld(AIMED, off) === AIMED && toCam(AIMED, off) === AIMED && toWorld(AIMED, null) === AIMED);

console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);
