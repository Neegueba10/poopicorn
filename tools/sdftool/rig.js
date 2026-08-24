/**
 * Groups: rigid rotation about a pivot, resolved into plain part numbers.
 *
 * THE FORMAT HAS NO TRANSFORM HIERARCHY and is not getting one. A part rotates
 * about its OWN centre, so an arm of three parts that swings from a shoulder
 * cannot be expressed by rotating each of them — they would spin in place and
 * come apart. A parent column would fix that and would cost stride 13 → 14, a
 * matrix chain in `prepRot`'s hot loop, and a rewrite of every model file.
 *
 * So the group lives in the EDITOR. Turning one computes, for every member:
 *
 *     centre    c' = P + G·(c − P)
 *     rotation  R' = G · R
 *
 * and writes those six numbers into channels. The renderer never learns that
 * groups exist, the file gains nothing but the numbers it would have had
 * anyway, and the run-time cost is zero. What it cannot do is bend or squash a
 * part — a group moves rigid pieces, which is what a rig of this kind is.
 *
 * EULER ORDER IS THE RENDERER'S. `rx ry rz` are TURNS and `prepRot` reads them
 * as `R = Rz·Ry·Rx`, so a decomposition in any other order would look right
 * until the second axis was used. Every matrix here is that order, and
 * `matrixToEuler` is its exact inverse.
 *
 * Pure geometry — this module never touches the document. clip.js applies the
 * numbers, because it owns the channels and undo.
 */
import { STRIDE } from './state.js';

const TAU = Math.PI * 2;

/** Rotation about world axis `k` (0 = x, 1 = y, 2 = z) by `turns`. */
export function axisMatrix(k, turns) {
  const s = Math.sin(turns * TAU), c = Math.cos(turns * TAU);
  if (k === 0) return [[1, 0, 0], [0, c, -s], [0, s, c]];
  if (k === 1) return [[c, 0, s], [0, 1, 0], [-s, 0, c]];
  return [[c, -s, 0], [s, c, 0], [0, 0, 1]];
}

export function mul(a, b) {
  const o = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      o[i][j] = a[i][0] * b[0][j] + a[i][1] * b[1][j] + a[i][2] * b[2][j];
    }
  }
  return o;
}

export const apply = (m, v) => [
  m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
  m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
  m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
];

/** `R = Rz·Ry·Rx` from three turns — the same product `prepRot` forms before
 * it transposes. */
export function eulerToMatrix(rx, ry, rz) {
  return mul(axisMatrix(2, rz), mul(axisMatrix(1, ry), axisMatrix(0, rx)));
}

/** How close to gimbal lock a pitch may get before the decomposition stops
 * meaning anything: `cos(ry·TAU)` under this is a quarter turn to within about
 * a degree. */
export const GIMBAL_EPS = 1e-2;

/**
 * The inverse of `eulerToMatrix`: three turns, in `Rz·Ry·Rx` order.
 *
 * AT ±0.25 TURNS OF PITCH THERE IS NO UNIQUE ANSWER. `cos(ry·TAU)` goes to
 * zero, the X and Z rotations become the same rotation, and only their sum or
 * difference survives. This returns one of the answers — roll folded into yaw —
 * and says so, because a tool that quietly picked one would make a group turn
 * feel like it had jumped.
 *
 * @returns {{rx: number, ry: number, rz: number, gimbal: boolean}}
 */
export function matrixToEuler(m) {
  const cy = Math.hypot(m[0][0], m[1][0]);
  if (cy < GIMBAL_EPS) {
    return {
      rx: 0,
      ry: Math.atan2(-m[2][0], cy) / TAU,
      rz: -Math.atan2(m[0][1], m[1][1]) / TAU,
      gimbal: true,
    };
  }
  return {
    rx: Math.atan2(m[2][1], m[2][2]) / TAU,
    ry: Math.atan2(-m[2][0], cy) / TAU,
    rz: Math.atan2(m[1][0], m[0][0]) / TAU,
    gimbal: false,
  };
}

/** Three decimals, the precision every generated file here is written at. */
const round = v => +v.toFixed(3);

/**
 * Turn `ids` about `pivot` by the matrix `g`, reading from `parts`.
 *
 * Returns the writes as `[flatIndex, value]` pairs — six per member — so the
 * caller keys them without this module knowing what a channel is. `gimbal` is
 * true when any member's new rotation landed on the degenerate pitch.
 *
 * @returns {{writes: [number, number][], gimbal: boolean}}
 */
export function transformGroup(parts, pivot, ids, g) {
  const writes = [];
  let gimbal = false;
  for (const id of ids) {
    const i = id * STRIDE;
    if (i < 0 || i + STRIDE > parts.length) continue;
    const d = [parts[i + 1] - pivot[0], parts[i + 2] - pivot[1], parts[i + 3] - pivot[2]];
    const c = apply(g, d);
    writes.push([i + 1, round(pivot[0] + c[0])]);
    writes.push([i + 2, round(pivot[1] + c[1])]);
    writes.push([i + 3, round(pivot[2] + c[2])]);
    const e = matrixToEuler(mul(g, eulerToMatrix(parts[i + 4], parts[i + 5], parts[i + 6])));
    if (e.gimbal) gimbal = true;
    writes.push([i + 4, round(e.rx)]);
    writes.push([i + 5, round(e.ry)]);
    writes.push([i + 6, round(e.rz)]);
  }
  return { writes, gimbal };
}

/** Move `ids` by `d`, reading from `parts`. A translation touches no rotation,
 * so it needs no decomposition and can never hit gimbal lock. */
export function translateGroup(parts, ids, d) {
  const writes = [];
  for (const id of ids) {
    const i = id * STRIDE;
    if (i < 0 || i + STRIDE > parts.length) continue;
    for (let k = 0; k < 3; k++) writes.push([i + 1 + k, round(parts[i + 1 + k] + d[k])]);
  }
  return { writes, gimbal: false };
}

/** The centre of `ids` — where a new group's pivot starts, because a shoulder
 * is nearer the middle of an arm than the origin is. */
export function centroid(parts, ids) {
  let n = 0;
  const c = [0, 0, 0];
  for (const id of ids) {
    const i = id * STRIDE;
    if (i < 0 || i + STRIDE > parts.length) continue;
    for (let k = 0; k < 3; k++) c[k] += parts[i + 1 + k];
    n++;
  }
  return n ? c.map(v => round(v / n)) : [0, 0, 0];
}
