// Playtest: drop a body into the stage and walk it around.
//
// `Tab` answers "does this look right". It cannot answer "can the player make
// that jump", which is the question a platformer level exists to answer —
// every jump in `delve` was tested by rebuilding the game. This runs a box
// with gravity against `hitStage`, the SAME collision call the game makes, so
// a gap that clears here clears there.
//
// The movement constants are fields, seeded from delve's, because a level is
// only testable against the movement it is designed for. They are editor
// state and reach nothing that is saved.
import { hitStage } from '/src/js/core/stage.js';
import { state, flatAabbs, SCREEN_W, SCREEN_H } from './state.js';
import { blit, addOverlay, display } from './canvas.js';
import { setStatus } from './status.js';

export const play = {
  w: 12, h: 24,       // body size in world px
  grav: 0.5,
  jump: 7,            // upward launch speed
  speed: 2,           // horizontal run speed
  maxFall: 8,
  type: 0,            // the collision type the body stands on
};

let on = false;
let body = null;      // { x, y, vx, vy, ground }
let saved = null;     // camera + zoom to restore on exit
let raf = 0;
const keys = new Set();

export const active = () => on;
export const bodyOf = () => body;

// The collision-only stage the probe tests against — the shipped format, so
// hitStage behaves exactly as it does in the game. Flattened once a frame,
// not once a step: a fast fall probes eight times before it lands.
let colStage = [[], [], [], []];
const reflow = () => { colStage = [[], [], flatAabbs(), []]; };

/** Solid at this box? Returns the AABB index or -1. */
const solidAt = (x0, y0, x1, y1) =>
  hitStage(colStage, Math.round(x0), Math.round(y0), Math.round(x1), Math.round(y1), play.type);

/**
 * Move one axis ONE PIXEL AT A TIME, stopping on the first solid. Two things
 * come out of that, and both matter for a pixel-art level:
 *
 *   - The body always rests FLUSH on a box. A fractional position tested
 *     against rounded box edges leaves a sub-pixel gap, and "is that ledge
 *     at 200 or 199.6" is not a question a level editor should raise.
 *   - A fast fall cannot tunnel. Speed only changes how many one-pixel
 *     steps a frame takes, never how far a single test reaches.
 *
 * The sub-pixel part of the speed is carried in a remainder, so a 0.5 px/frame
 * fall still moves — one pixel every other frame. Returns true on a hit.
 */
function moveAxis(axis, amount) {
  const rk = axis === 'x' ? 'rx' : 'ry';
  body[rk] += amount;
  let move = Math.round(body[rk]);
  body[rk] -= move;
  const sign = Math.sign(move);
  while (move !== 0) {
    const nx = body.x + (axis === 'x' ? sign : 0);
    const ny = body.y + (axis === 'x' ? 0 : sign);
    if (solidAt(nx, ny, nx + play.w, ny + play.h) >= 0) {
      body[rk] = 0;
      return true;
    }
    body.x = nx;
    body.y = ny;
    move -= sign;
  }
  return false;
}

function step() {
  reflow();
  body.vx = (keys.has('right') ? play.speed : 0) - (keys.has('left') ? play.speed : 0);
  body.vy = Math.min(play.maxFall, body.vy + play.grav);
  if (body.ground && keys.has('jump')) {
    body.vy = -play.jump;
    body.ground = false;
  }
  moveAxis('x', body.vx);
  const hit = moveAxis('y', body.vy);
  if (hit) {
    body.ground = body.vy > 0;
    body.vy = 0;
  } else if (body.vy !== 0) {
    body.ground = false;
  }
  // camera follows, clamped to whole pixels so the picture stays crisp
  state.cam[0] = Math.round(body.x + play.w / 2 - SCREEN_W / 2);
  state.cam[1] = Math.round(body.y + play.h / 2 - SCREEN_H / 2);
  blit();
  raf = requestAnimationFrame(step);
}

/** Start at world (x, y) — the cursor, or the middle of the camera. */
export function start(x, y) {
  if (on) return;
  on = true;
  saved = [state.cam[0], state.cam[1], state.zoom];
  body = {
    x: Math.round(x - play.w / 2), y: Math.round(y - play.h),
    vx: 0, vy: 0, rx: 0, ry: 0, ground: false,
  };
  keys.clear();
  reflow();
  setStatus('playtest — arrows/WASD move, space jumps, Esc or P exits');
  document.body.classList.add('playing');
  raf = requestAnimationFrame(step);
}

export function stop() {
  if (!on) return;
  on = false;
  cancelAnimationFrame(raf);
  raf = 0;
  body = null;
  keys.clear();
  document.body.classList.remove('playing');
  if (saved) {
    state.cam[0] = saved[0];
    state.cam[1] = saved[1];
    state.zoom = saved[2];
    saved = null;
  }
  setStatus('playtest ended');
  blit();
}

export const toggle = (x, y) => (on ? stop() : start(x, y));

const BIND = {
  ArrowLeft: 'left', a: 'left', A: 'left',
  ArrowRight: 'right', d: 'right', D: 'right',
  ArrowUp: 'jump', w: 'jump', W: 'jump', ' ': 'jump',
};

// Own the keyboard while playing: the editor's arrows nudge a selection, and
// its space pans, so both would fight the body.
window.addEventListener('keydown', e => {
  if (!on) return;
  if (e.key === 'Escape' || e.key === 'p' || e.key === 'P') {
    e.preventDefault();
    e.stopPropagation();
    return stop();
  }
  const b = BIND[e.key];
  if (!b) return;
  e.preventDefault();
  e.stopPropagation();
  keys.add(b);
}, true);

window.addEventListener('keyup', e => {
  if (!on) return;
  const b = BIND[e.key];
  if (b) { keys.delete(b); e.stopPropagation(); }
}, true);

// The body, drawn last so it is never behind a foreground plane.
addOverlay((ctx, zoom, preview) => {
  if (!on || !body) return;
  const ox = preview ? state.cam[0] : state.cam[0] - state.origin[0];
  const oy = preview ? state.cam[1] : state.cam[1] - state.origin[1];
  const x = (body.x - ox) * zoom, y = (body.y - oy) * zoom;
  ctx.fillStyle = 'rgba(80,200,255,.35)';
  ctx.fillRect(x, y, play.w * zoom, play.h * zoom);
  ctx.strokeStyle = '#4af';
  ctx.lineWidth = 2;
  ctx.strokeRect(x, y, play.w * zoom, play.h * zoom);
  ctx.fillStyle = body.ground ? '#4f4' : '#fd4';
  ctx.fillRect(x, y - 4, 4, 3);
});

// clicking while playing teleports the body — retrying a jump should not
// mean walking back to the start of the level
display.addEventListener('pointerdown', e => {
  if (!on) return;
  e.stopPropagation();
  const rect = display.getBoundingClientRect();
  const wx = (e.clientX - rect.left) / state.zoom + state.cam[0] - state.origin[0];
  const wy = (e.clientY - rect.top) / state.zoom + state.cam[1] - state.origin[1];
  body.x = Math.round(wx - play.w / 2);
  body.y = Math.round(wy - play.h / 2);
  body.vx = body.vy = body.rx = body.ry = 0;
}, true);
