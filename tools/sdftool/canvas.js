/**
 * The preview: the real renderer, stepped across frames, plus the two gestures
 * that make a numeric model editable by eye — orbit the camera, and drag a
 * part around in the plane facing you.
 *
 * The renderer accumulates and cannot be patched, so every edit restarts it —
 * and a restart is expensive enough (40 ms at 160, 96 ms at 240) that a drag
 * would never see a finished picture. So the preview renders a DRAFT while
 * changes are arriving and holds the last FINISHED frame while the real one is
 * on its way. See the two rules below.
 *
 * DRAGGING A PART IS EXACT, and that is a property of the projection rather
 * than a trick: the camera is orthographic, so a screen delta maps to a world
 * delta by the camera's own right and up vectors with no depth term. Under
 * perspective this control would need the part's distance and would drift.
 */
import SDF, { map, prepRot, bound, expand, STRIDE, SCATTER } from '/src/js/core/sdf.js';
import { genPalette } from '/src/js/core/palette.js';
import * as glr from './glrender.js';
import {
  state, count, get, set, SUBTRACT, PAINT, SCALE_COLS, isCut, isMirror, isScatter,
  dial, setDial, fillDir, fillLinked, selection, multi, selectOnly, toggleSelect,
  applyWrites,
} from './state.js';
import * as giz from './gizmo.js';
// The anim tab's group maths, reused whole. Turning several parts about one
// pivot is the same problem whether a rig asked for it or a multiple selection
// did, and it is the half of this that is easy to get subtly wrong — see the
// Euler-order note at the top of rig.js.
import { centroid, translateGroup, transformGroup, axisMatrix } from './rig.js';
import * as vw from './viewwidget.js';
import * as lgt from './lightwidget.js';
import * as shape from './shapewidget.js';
import { createViewport, panModifier } from './viewport.js';

const TAU = Math.PI * 2;

/**
 * THE DRAFT'S RESOLUTION, fixed rather than derived from `view.size`, so a drag
 * costs the same whether you are previewing at 96 or at 240 — which is what
 * "stays responsive" has to mean.
 *
 * 48 is the largest size that still finishes inside ONE 8 ms slice on the
 * models in this repo. Measured, per whole frame: the crate 2.6 ms, the
 * creature 4.0 ms — against 39.8 ms for the creature at 160 and 96.1 ms at 240.
 */
const DRAFT = 48;

/**
 * How long a full render may hold the previous frame before it gives up and
 * starts showing itself.
 *
 * Holding a frame for 40 ms is invisible; holding one for four seconds looks
 * like a hang. Past this, watching the picture fill in is information rather
 * than tearing.
 */
const PARTIAL_AFTER = 500;

/**
 * How long a stream of changes may go quiet before the preview decides it is
 * over and renders the real thing.
 *
 * A pointer release settles it at once, so this only has to cover the streams
 * that end without one — a held arrow key, a burst of typed values. It is
 * deliberately generous: a hand that pauses mid-drag has not finished dragging,
 * and promoting on a 30 ms gap threw away a 96 ms render every time the mouse
 * hesitated. It is a TIME rather than a frame count so that nothing can wedge
 * the preview in draft if a release is ever missed.
 */
const IDLE_MS = 250;

export const view = {
  rb: null,
  /**
   * The GPU renderer, or null on a machine without one (tools/sdftool/glrender.js).
   *
   * WHEN IT EXISTS, THE DRAFT DOES NOT RUN. The draft is a workaround for a
   * 350 ms frame; a GPU frame is one draw and a readback, so dropping to 48x48
   * would trade the picture you are judging for speed you already have.
   */
  gl: null,
  /** Prefer the GPU when there is one. Off forces the CPU renderer, which is
   * the authority — the two do not agree to the last pixel and comparing them
   * has to be possible from the tool. */
  gpu: localStorage.getItem('sdftool.gpu') !== '0',
  /** The low-resolution renderer. Same model, same view, same lights — only
   * coarser. A draft that dropped occlusion would be faster and would lie about
   * the look, and judging the look is what the preview is for. */
  draft: null,
  pal: null,
  size: 160,
  ms: 0,
  onstatus: null,
  /** 'move' | 'rotate' | 'scale' — what the part gizmo's arms do. */
  mode: 'move',
  /** Whether the two light suns are shown and grabbable. Off by default: a
   * light is aimed once and a part is moved all day, so the lights must not
   * sit over the model waiting to be grabbed by mistake. */
  lights: false,
  /** `(ctx, w, h) => boolean`, called by `paint` under the picture. The anim
   * tab's onion ghosts and its playback; null in every other tab. */
  under: null,
};

let cv, ctx, host;

/**
 * THE PREVIEW RUNS ON TWO RULES, and everything in this section follows from
 * them:
 *
 *   1. WHILE CHANGES ARE STILL ARRIVING, render a draft.
 *   2. NEVER PAINT A PARTIAL FRAME WHEN A FINISHED ONE EXISTS.
 *
 * Rule 1 fixes the drag. `begin()` restarts from row 0 and `tick` gives the
 * renderer 8 ms a frame, so at 160 a whole picture is five slices and a drag
 * restarts it long before the second one — you were looking at the top fifth of
 * the model, and at 240 the top twelfth. A 48x48 draft finishes inside a single
 * slice, so every frame of a drag is a complete picture of the current pose.
 *
 * Rule 2 fixes the wipe and the blanking together. A restart clears the frame
 * and fills it back in from the top; showing that is the tearing. Holding the
 * last FINISHED frame instead means nothing ever blanks — and on release the
 * held frame is the last draft, which is the current pose, coarse. A stale full
 * frame of the PREVIOUS pose would be worse than either.
 *
 * WHAT SELECTS THE DRAFT IS A CHANGE OR A MOVEMENT, not a pointer being down. A
 * click that selects a part changes no pixel and must not re-render at all.
 */
/** One finished picture: a canvas, and the ImageData that writes into it. */
function surface(n) {
  const c = document.createElement('canvas');
  c.width = c.height = n;
  const cx = c.getContext('2d');
  const img = cx.createImageData(n, n);
  return { cv: c, ctx: cx, img, rgba: new Uint8ClampedArray(img.data.buffer) };
}

let full = null, draft = null;
/** The surface holding the newest FINISHED frame, or null before there is one. */
let shown = null;
/** A restart is waiting to begin. */
let pending = true;
/** The render in flight, and whether it is the draft's. */
let cur = null, curDraft = false;
/** Changes are still arriving, so the next render is a draft. */
let streaming = false;
/** When the last change arrived, and when the render in flight began. */
let lastChange = 0, startedAt = 0;

// The widgets live on their OWN canvas, over the picture. Drawing them into
// the render would put 5x-wide handles on a 160px image and rebuild the render
// on every hover; keeping them apart means the overlay redraws at display
// resolution, for free, without touching a single rendered pixel.
let ov, octx;

/** The picture's size and position on screen — see viewport.js. Not the
 * camera: nothing it does reaches the file. */
export let viewport = null;

export function setup(canvasEl, overlayEl, hostEl) {
  // The generated palette, because that is what the new stack ships
  // A model authored against it is a model
  // the game reproduces exactly.
  view.pal = genPalette();
  cv = canvasEl;
  ctx = cv.getContext('2d');
  ov = overlayEl;
  octx = ov.getContext('2d');
  host = hostEl;
  viewport = createViewport(host, [cv], () => [view.size, view.size], place);
  view.draft = new SDF(DRAFT, DRAFT, view.pal, { lo: 1, rampSize: 8 });
  draft = surface(DRAFT);
  resize(view.size);
  initOrbit();
  // A DRAG ENDS AT THE WINDOW, not at the widget that started it. This catches
  // the gizmo, the suns, the orbit, the pan, the part drag, every scrubber in
  // the inspector and every scrubber in the sheet inspector, with no call site
  // knowing about it — and anything added later for free.
  addEventListener('pointerup', settle, true);
  addEventListener('pointercancel', settle, true);
}

// Where the picture sits inside the pane: the whole-number scale it is drawn
// at, and its top-left. The VIEWPORT owns these (tools/sdftool/viewport.js).
let ovScale = 3, ovX = 0, ovY = 0;

/**
 * Follow the viewport. Called by it, not by the panels.
 *
 * THE OVERLAY COVERS THE PANE, NOT THE PICTURE. It would be simpler to scale
 * it with the render, but then the camera cross — which belongs in the corner
 * of the WINDOW you are working in — would scroll off the edge the moment you
 * zoomed in, and the overlay's backing store would grow to the zoomed size
 * (240 at 16x is a 3840px canvas) for no gain. So it stays pane-sized at 1:1
 * CSS pixels, and the gizmo is offset into it instead.
 */
function place(z, x, y) {
  ovScale = z;
  ovX = x;
  ovY = y;
  if (!ov || !host) return;
  const w = Math.max(1, host.clientWidth), h = Math.max(1, host.clientHeight);
  if (ov.width !== w || ov.height !== h) {
    ov.width = w;
    ov.height = h;
  }
  ov.style.position = 'absolute';
  ov.style.left = '0px';
  ov.style.top = '0px';
  ov.style.width = w + 'px';
  ov.style.height = h + 'px';
  drawOverlay();
}

export function resize(size) {
  view.size = size;
  view.rb = new SDF(size, size, view.pal, { lo: 1, rampSize: 8 });
  view.gl = glr.create(size, size, view.pal, { lo: 1, rampSize: 8 });
  cv.width = size;
  cv.height = size;
  // A full frame of another size is not a picture of this one, so it stops
  // being holdable. A held DRAFT still is — same picture, coarser — which is
  // why changing the preview size shows the draft rather than blanking.
  if (shown === full) shown = null;
  full = surface(size);
  // A resolution change is a different-sized picture, so the fit is a
  // different number: 96 wants more magnification than 240 to fill the pane.
  viewport?.apply();
  restart();
  paint();
}

/** Overlay pixels per rendered pixel. */
const zoom = () => ovScale;

/**
 * Start the picture over. Any edit calls this.
 *
 * `moving` says this restart is one of a STREAM — a drag frame, a scrub step —
 * so it renders a draft. A caller that does not know passes nothing and is
 * caught anyway: a restart arriving while the last render is still unfinished
 * is, by definition, changes coming in faster than they can be drawn.
 */
export function restart(moving) {
  if (moving || (cur && !cur.done())) streaming = true;
  pending = true;
  lastChange = performance.now();
  view.ms = 0;
}

/** Changes have stopped — finish at full resolution. Bound to pointerup at the
 * window, and reached anyway after two quiet frames. */
export function settle() {
  if (!streaming) return;
  streaming = false;
  if (curDraft || cur === null) pending = true;
}

/** Test hook: nothing to draw and a full frame is up. */
view.settled = () => !pending && !cur && shown === full;
/** Test hook: the preview is currently working at draft resolution. On the GPU
 * it never is — a stream of changes renders at full size. */
view.drafting = () => curDraft || (streaming && !gpuRenderer());

/**
 * The renderer this frame should use: the GPU when there is one, it is wanted,
 * and this model is inside what the shader can reproduce.
 *
 * The last test is per model rather than once at boot. A model that grows past
 * the shader's part or material limit has to fall back mid-session rather than
 * render something the game would not bake — see `supports` in glrender.js.
 */
function gpuRenderer() {
  // `available()` is asked EVERY FRAME and not once at boot, because a context
  // can be lost at any moment — a driver reset, a laptop switching GPUs, a tab
  // backgrounded too long. A renderer whose context has gone draws nothing at
  // all, so noticing has to be cheap and continuous rather than clever.
  if (!view.gpu || !view.gl || !glr.available()) return null;
  return glr.supports(expand(state.parts), state.mats) ? view.gl : null;
}

/** Test hook: which back end drew the last frame — 'gpu' or 'cpu'. */
view.backend = () => (gpuRenderer() ? 'gpu' : 'cpu');

/** One frame of work. Returns false when there is nothing left to do. */
export function tick() {
  if (!view.rb) return false;
  if (pending) {
    pending = false;
    const gpu = gpuRenderer();
    // Rule 1 is a workaround for a slow full frame. On the GPU there isn't
    // one, so the draft is skipped and every frame of a drag is the real
    // picture at the real resolution.
    curDraft = streaming && !gpu;
    cur = gpu || (curDraft ? view.draft : view.rb);
    cur.begin(state.parts, state.mats, state.view);
    startedAt = performance.now();
    view.ms = 0;
  }
  if (!cur) {
    // The stream went quiet without a release — see IDLE_MS.
    if (streaming && performance.now() - lastChange > IDLE_MS) settle();
    return false;
  }
  const t0 = performance.now();
  cur.step(8);
  view.ms += performance.now() - t0;

  if (cur.done()) {
    const finished = cur, wasDraft = curDraft;
    publish(wasDraft ? draft : full, finished);
    cur = null;
    status(finished, wasDraft);
  } else if (!shown || performance.now() - startedAt > PARTIAL_AFTER) {
    // RULE 2's only exceptions: nothing has ever finished (an empty pane at
    // boot would be worse than a wipe), or this render is slow enough that
    // watching it arrive beats watching nothing.
    publish(curDraft ? draft : full, cur);
  }
  drawOverlay();
  return true;
}

/** Copy a renderer's pixels into its surface and put that on screen. */
function publish(s, r) {
  r.toRGBA(s.rgba);
  s.ctx.putImageData(s.img, 0, 0);
  shown = s;
  paint();
}

/**
 * Draw the held frame into the display canvas.
 *
 * A draft is 48x48 and the display is `view.size`, so this scales — with
 * smoothing off, which upscales it as hard pixels, the same nearest neighbour
 * the pane's own `image-rendering: pixelated` gives. A finished full frame is
 * already the right size and the draw is 1:1.
 */
export function paint() {
  if (!ctx) return;
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, cv.width, cv.height);
  // THE ANIM TAB DRAWS HERE, and it is the only thing that does. Onion ghosts
  // go UNDER the pose — the useful part of a ghost is the part the current pose
  // does not cover — and during playback it paints the BAKED frames instead of
  // the live render, which is what makes ten frames a second possible at all.
  // It returns true when it has painted the picture itself. See clipui.js.
  const took = view.under && view.under(ctx, cv.width, cv.height);
  if (shown && !took) ctx.drawImage(shown.cv, 0, 0, cv.width, cv.height);
  drawOverlay();
}

function status(r, isDraft) {
  if (!view.onstatus || !r.done()) return;
  // Authored rows first, then the rows the renderer actually marched. A
  // scatter is two rows and forty parts, and march cost is linear in the
  // second number — so the second number is the one that has to be visible.
  const n = count(), e = r.m.length / STRIDE;
  // WHICH BACK END DREW THIS IS PART OF THE STATUS, not a hidden detail. The
  // GPU and the CPU agree to within a dither step and not further, so a render
  // you are judging has to say which one made it.
  const back = r === view.gl ? 'gpu' : 'cpu';
  view.onstatus(`${n}${e === n ? '' : ` → ${e}`} parts  ·  ${r.px} px`
    + `  ·  ${view.ms.toFixed(0)} ms  ·  ${r.w}x${r.h}`
    + (isDraft ? ' draft' : ` at ${zoom()}x`) + `  ·  ${back}`);
}

/** The widgets: the selected part's gizmo, the two suns, and the camera cross
 * in the corner. */
export function drawOverlay() {
  if (!octx) return;
  octx.clearRect(0, 0, ov.width, ov.height);
  if (state.sel >= 0 && state.sel < count()) {
    // A scatter header has no position and no dimensions, so it gets no gizmo.
    // What it has is the volume its instances land in, and that is drawn.
    if (isScatter(state.sel)) drawSpreadBox(state.sel);
    else {
      // The mirror plane belongs to ONE part, so it is not drawn for a group —
      // it would say the whole selection folds, and only the anchor does.
      if (isMirror(state.sel) && !multi()) drawMirrorPlane();
      if (multi()) drawMembers();
      // SHAPE MODE ONLY, AND ONE PART ONLY. The cage says what the dimension
      // handles act on; a group's scale is uniform and has nothing to point at,
      // and a cage round every part in every mode is a pane full of dashes.
      if (view.mode === 'scale' && !multi()) {
        const cg = shape.cage(state.parts, state.sel);
        if (cg) shape.draw(octx, cg, projectOverlay, isCut(state.sel));
      }
      giz.draw(octx, gizmo(), view.mode, drag && drag.handle);
      // Over the arms, because it is the smaller target and it sits on the
      // shape rather than out on a 54 px arm — hidden under one it would be
      // unreachable in exactly the foreshortened views where it matters.
      shape.drawHandles(octx, shapeHandles(), drag && drag.handle);
    }
  }
  // The rig pivot, over the part gizmo — it is grabbed first, so it has to be
  // drawn last or a handle would be hidden under the thing it outranks.
  const rg = rigGizmo();
  if (rg) {
    giz.draw(octx, rg, rig.mode(), drag && drag.what === 'rig' ? drag.handle : null);
    // A ring at a point with no part under it reads as belonging to whatever it
    // happens to overlap. The square says this one is a pivot.
    octx.save();
    octx.strokeStyle = '#e5a55a';
    octx.lineWidth = 1.5;
    octx.strokeRect(rg.sx - 6, rg.sy - 6, 12, 12);
    octx.restore();
  }
  if (view.lights) {
    for (const l of lights()) {
      lgt.draw(octx, l.g, l.col, l.i > 0, drag && drag.light === l.which);
    }
  }
  vw.draw(octx, ov.width, ov.height, state.view);
}

/**
 * A ring on each member of a multiple selection, and a line to the pivot.
 *
 * The list says which rows are selected, but the drag happens over here, and a
 * group gizmo alone is one widget floating at a centroid with nothing to say
 * what it will carry. A part hidden inside another one is exactly the case
 * where that matters.
 */
function drawMembers() {
  const ids = selection();
  const c = centroid(state.parts, ids);
  const [cx, cy] = projectOverlay(c[0], c[1], c[2]);
  octx.save();
  octx.strokeStyle = '#4af';
  octx.lineWidth = 1;
  for (const id of ids) {
    const [x, y] = projectOverlay(get(id, 1), get(id, 2), get(id, 3));
    octx.globalAlpha = 0.35;
    octx.beginPath();
    octx.moveTo(cx, cy);
    octx.lineTo(x, y);
    octx.stroke();
    octx.globalAlpha = id === state.sel ? 1 : 0.7;
    octx.beginPath();
    octx.arc(x, y, id === state.sel ? 6 : 4, 0, TAU);
    octx.stroke();
  }
  octx.restore();
}

/**
 * The box a scatter's instances land in: the header's three spreads, about the
 * template's own centre.
 *
 * Drawn as the box even when the distribution is an ellipsoid inside it. The
 * box is the numbers you are editing; the ellipsoid is what those numbers do,
 * and the render already shows that.
 */
function drawSpreadBox(i) {
  if (i + 1 >= count()) return;                 // a header with no template yet
  const c = [get(i + 1, 1), get(i + 1, 2), get(i + 1, 3)];
  const e = [get(i, 3), get(i, 4), get(i, 5)];
  const p = [];
  for (let k = 0; k < 8; k++) {
    p.push(projectOverlay(c[0] + (k & 1 ? e[0] : -e[0]),
      c[1] + (k & 2 ? e[1] : -e[1]), c[2] + (k & 4 ? e[2] : -e[2])));
  }
  octx.save();
  octx.strokeStyle = '#4af';
  octx.globalAlpha = 0.5;
  octx.setLineDash([3, 3]);
  octx.beginPath();
  // The twelve edges of a cube, as pairs of corner indices.
  for (const [a, b] of [[0, 1], [0, 2], [0, 4], [1, 3], [1, 5], [2, 3],
    [2, 6], [3, 7], [4, 5], [4, 6], [5, 7], [6, 7]]) {
    octx.moveTo(p[a][0], p[a][1]);
    octx.lineTo(p[b][0], p[b][1]);
  }
  octx.stroke();
  octx.restore();
}

/**
 * The mirror plane, drawn while a mirrored part is selected.
 *
 * A SQUARE IN THE YZ PLANE, not a line. A plane seen from an angle covers the
 * whole picture, so there is no honest line to draw; the square is where the
 * plane cuts the model's own bounds, which is the part you are placing against.
 * Seen edge-on it collapses to a line, which is correct and is also how you
 * know you are looking straight down the axis of symmetry.
 */
function drawMirrorPlane() {
  const br = (bound(expand(state.parts)) || 1) * 1.15;
  octx.save();
  octx.strokeStyle = '#4af';
  octx.globalAlpha = 0.45;
  octx.setLineDash([4, 4]);
  octx.beginPath();
  [[0, br, br], [0, br, -br], [0, -br, -br], [0, -br, br]]
    .map(p => projectOverlay(p[0], p[1], p[2]))
    .forEach(([x, y], i) => (i ? octx.lineTo(x, y) : octx.moveTo(x, y)));
  octx.closePath();
  octx.stroke();
  octx.restore();
}

/** The camera's forward vector — the one sdf.js's begin() builds. */
function forward() {
  const { yaw = 0, pitch = 0 } = state.view;
  const cp = Math.cos(pitch * TAU), sp = Math.sin(pitch * TAU);
  return [Math.sin(yaw * TAU) * cp, -sp, Math.cos(yaw * TAU) * cp];
}

/**
 * The two lights, in overlay pixels: the key first, then the fill or rim.
 *
 * The fill's direction is asked of the state rather than stored here, because
 * while it is unset it IS the key's, negated — the same rule the renderer
 * follows, and the reason the fill glyph swings when the key is dragged.
 */
/** The radius the suns orbit at, in world units. Measured on the EXPANDED
 * model, or a scatter's instances hang outside the sphere its suns ride. */
const lightRadius = () => (bound(expand(state.parts)) || 1) * lgt.ORBIT;

/** The world point under an overlay pixel, on the camera's own plane through
 * the origin. Orthographic, so this is exact and has no depth term. */
function planeAt(ox, oy) {
  return rayAt((ox - ovX) / ovScale, (oy - ovY) / ovScale).o;
}

/**
 * Mirror a light through the camera plane: the same place on screen, the other
 * side of the model. Aiming a light and then flipping it is how a rim is made,
 * because a drag alone holds its hemisphere — see lightwidget.js.
 */
export function flipLight(which) {
  const d = lgt.toCam(lgt.flip(lightDirs()[which], forward()), state.view);
  (which ? ['l2x', 'l2y', 'l2z'] : ['lx', 'ly', 'lz'])
    .forEach((k, i) => setDial(k, round(d[i])));
  restart();
  drawOverlay();
}

/**
 * The two light directions in WORLD space, which is the only space the widgets
 * work in. Under `lcam` the dials hold camera-space aims instead, so the sun
 * stays put on screen while the camera orbits — see lightwidget.js.
 */
const lightDirs = () => [[dial('lx'), dial('ly'), dial('lz')], fillDir()]
  .map(d => lgt.toWorld(d, state.view));

/**
 * Lock the lights to the camera, or let them go, WITHOUT MOVING THEM: the aims
 * are rewritten into the other space, so the suns stay exactly where they are
 * and only the next orbit behaves differently. Toggling at some turned-round
 * yaw would otherwise throw the key across the model.
 *
 * A linked fill is left alone — it is the key negated in whichever space the
 * key is in, so it converts for free.
 */
export function setLightCam(on) {
  const [key, fill] = lightDirs();
  const linked = fillLinked();
  setDial('lcam', on ? 1 : 0);
  const put = (keys, d) => {
    const c = lgt.toCam(d, state.view);
    keys.forEach((k, i) => setDial(k, round(c[i])));
  };
  put(['lx', 'ly', 'lz'], key);
  if (!linked) put(['l2x', 'l2y', 'l2z'], fill);
  restart();
  drawOverlay();
}

function lights() {
  const br = bound(expand(state.parts)) || 1;
  const fwd = forward();
  const dirs = lightDirs();
  return [0, 1].map(w => ({
    which: w,
    g: lgt.place(dirs[w], br, projectOverlay, fwd),
    col: w ? [dial('l2r'), dial('l2g'), dial('l2b')] : [dial('lr'), dial('lg'), dial('lb')],
    i: w ? dial('l2i') : dial('li'),
  }));
}

/** Overlay pixel to client pixel. The overlay is pane-sized at 1:1, so this is
 * only its offset — but going through one function keeps the test hooks and
 * the gestures reading the same geometry. */
function overlayToClient() {
  const r = ov.getBoundingClientRect();
  return (x, y) => ({ x: r.left + x, y: r.top + y });
}

/** Client pixel to overlay pixel. */
function clientToOverlay(e) {
  const r = ov.getBoundingClientRect();
  return [e.clientX - r.left, e.clientY - r.top];
}

/**
 * Test hook (tests/README.md's convention): every grabbable point of the
 * current widget, in CLIENT coordinates, so a suite can press exactly where a
 * person would rather than reaching past the gesture it means to test.
 */
export function debugHandles() {
  if (!ov || state.sel < 0 || state.sel >= count()) return [];
  const g = gizmo();
  const toClient = overlayToClient();
  const out = giz.handles(g, view.mode)
    .map(h => ({ type: h.type, axis: h.axis, ...toClient(h.x, h.y) }));
  // The shape handles report the COLUMN they write, so a suite can ask for
  // "the handle that edits round" without knowing where it is drawn.
  for (const h of shapeHandles()) {
    // `dir` too: a suite that dragged a fixed direction would be asserting
    // about the camera rather than about the handle, and would pass or fail on
    // whichever way the model happened to be turned.
    // `sign` too, or the two ends of a capsule are indistinguishable to a suite
    // and "the far one stayed put" silently measures the near one.
    if (!h.flat) {
      out.push({ type: h.type, axis: h.axis, col: h.col, dir: h.dir, sign: h.sign,
        ...toClient(h.x, h.y) });
    }
  }
  if (view.mode === 'rotate') {
    for (let a = 0; a < 3; a++) {
      const pts = giz.ringPointsFor(g, a);
      const [x, y] = pts[6];
      out.push({ type: 'rotate', axis: a, ...toClient(x, y) });
    }
  }
  return out;
}

/**
 * Test hook: where each light's sun is, in CLIENT coordinates, whether or not
 * the lights are shown — a suite asserting that a hidden light cannot be
 * grabbed needs to press where it would have been.
 */
export function debugLights() {
  if (!ov) return [];
  const toClient = overlayToClient();
  const c = toClient(0, 0);
  return lights().map(l => ({
    which: l.which,
    behind: l.g.behind,
    ...toClient(l.g.x, l.g.y),
    // The model's centre, and the sphere the suns ride, both in client pixels.
    // A suite testing that a sun tracks the pointer has to drag INWARD: outside
    // the silhouette there is no sphere point to track, and the gesture rides
    // the rim by design.
    cx: c.x + l.g.cx,
    cy: c.y + l.g.cy,
    r: lightRadius() / (state.view.scale ?? 3) * view.size * ovScale,
  }));
}

/** Test hook: where the view widget's box and pan handle are, in client
 * coordinates. */
export function debugViewWidget() {
  const b = vw.box(ov.width, ov.height);
  const toClient = overlayToClient();
  return {
    pan: toClient(b.x + b.s / 2, b.y + b.s / 2),
    rim: toClient(b.x + 6, b.y + 6),
  };
}

/**
 * The gizmo for the selection, in overlay pixels.
 *
 * ONE PART GETS ITS OWN FRAME, SEVERAL GET THE WORLD'S. A gizmo in a part's own
 * frame is what makes `scale` mean the number the primitive reads — see
 * gizmo.js. Several parts have no shared frame, and picking the anchor's would
 * make the same drag do different things depending on which row you clicked
 * first, so a group turns about world axes at its own centre. Same rule the rig
 * pivot follows, and the same `buildAt` behind it.
 */
function gizmo() {
  const { yaw = 0, pitch = 0 } = state.view;
  const cy = Math.cos(yaw * TAU), sy = Math.sin(yaw * TAU);
  const cp = Math.cos(pitch * TAU), sp = Math.sin(pitch * TAU);
  const fwd = [sy * cp, -sp, cy * cp];
  if (multi()) {
    return giz.buildAt(centroid(state.parts, selection()), giz.WORLD_AXES,
      projectOverlay, fwd);
  }
  return giz.build(state.parts, state.sel, projectOverlay, fwd);
}

/**
 * The shape handles for the selected part, in overlay pixels.
 *
 * Shape mode only, and one ordinary part only: a group's scale is uniform and
 * has no single shape to hang a handle on, and a scatter header is a seed and a
 * count rather than a shape.
 */
function shapeHandles() {
  if (view.mode !== 'scale' || multi() || state.sel < 0 || state.sel >= count()
    || isScatter(state.sel)) return [];
  return shape.handles(state.parts, state.sel, projectOverlay);
}

/**
 * How big the selection is about its own centre, in world units — the length a
 * group's scale drag is measured against.
 *
 * A factor needs a scale to be a factor OF. Using the drag distance raw would
 * make a small group explode and a large one barely move for the same hand
 * movement, so the arm is normalised by the thing it is stretching.
 */
function groupRadius(parts, ids, pivot) {
  let r = 0;
  for (const id of ids) {
    const i = id * STRIDE;
    const d = Math.hypot(parts[i + 1] - pivot[0], parts[i + 2] - pivot[1],
      parts[i + 3] - pivot[2]);
    const ext = Math.hypot(parts[i + 7], parts[i + 8], parts[i + 9])
      + parts[i + 10] + parts[i + 11];
    r = Math.max(r, d + ext);
  }
  return Math.max(r, 0.05);
}

/**
 * A SECOND GIZMO, at a point that is not a part.
 *
 * The anim tab's group pivot: a shoulder an arm swings from, which no row of
 * the model names. Whoever owns the tab supplies it, and gets the drag back as
 * a world point or a turn about a world axis — this file does the pointer and
 * the projection, and knows nothing about groups.
 *
 * `{ at(): [x,y,z]|null, mode(): 'move'|'rotate', begin(), move(p), turn(k, t) }`
 * `turn` is measured from the pose `begin` saw, not from the last frame: a
 * delta re-derived mid-drag feeds back into itself and runs away from the hand.
 */
let rig = null;
export const setRig = r => { rig = r; };

/** The rig's gizmo, or null when nothing is rigged. Its rings are the WORLD's
 * axes, because a group has no frame of its own. */
function rigGizmo() {
  const c = rig && rig.at();
  if (!c) return null;
  const { yaw = 0, pitch = 0 } = state.view;
  const cy = Math.cos(yaw * TAU), sy = Math.sin(yaw * TAU);
  const cp = Math.cos(pitch * TAU), sp = Math.sin(pitch * TAU);
  return giz.buildAt(c, giz.WORLD_AXES, projectOverlay, [sy * cp, -sp, cy * cp]);
}

/** Test hook: the pivot's grabbable points, in client coordinates. */
export function debugRigHandles() {
  const g = rigGizmo();
  if (!g || !ov) return [];
  const toClient = overlayToClient();
  const out = giz.handles(g, rig.mode()).map(h => ({ type: h.type, axis: h.axis, ...toClient(h.x, h.y) }));
  if (rig.mode() === 'rotate') {
    for (let a = 0; a < 3; a++) {
      const [x, y] = giz.ringPointsFor(g, a)[6];
      out.push({ type: 'rotate', axis: a, ...toClient(x, y) });
    }
  }
  return out;
}

/** The camera basis, matching sdf.js's begin() exactly. */
function basis() {
  const { yaw = 0, pitch = 0 } = state.view;
  const cy = Math.cos(yaw * TAU), sy = Math.sin(yaw * TAU);
  const cp = Math.cos(pitch * TAU), sp = Math.sin(pitch * TAU);
  return {
    r: [cy, 0, -sy],
    u: [sy * sp, cp, cy * sp],
    scale: (state.view.scale ?? 3) / view.size,
  };
}

/** World point to canvas pixel. The inverse of sdf.js's ray setup, `vx`/`vy`
 * included — the frame can be looking somewhere other than the origin. */
export function project(x, y, z) {
  const { r, u, scale } = basis();
  const su = x * r[0] + y * r[1] + z * r[2] - (state.view.vx ?? 0);
  const sv = x * u[0] + y * u[1] + z * u[2] - (state.view.vy ?? 0);
  // Screen Y grows down and world Y grows up — the same flip sdf.js applies.
  return [su / scale + view.size / 2 - 0.5, view.size / 2 - 0.5 - sv / scale];
}

/** The same, in overlay pixels — the picture's scale, plus where the picture
 * currently sits in the pane. */
export function projectOverlay(x, y, z) {
  const [px, py] = project(x, y, z);
  return [px * ovScale + ovX, py * ovScale + ovY];
}

/** Canvas pixel to the ray through it: an origin and the shared direction. */
function rayAt(px, py) {
  const { r, u, scale } = basis();
  const { yaw = 0, pitch = 0 } = state.view;
  const cy = Math.cos(yaw * TAU), sy = Math.sin(yaw * TAU);
  const cp = Math.cos(pitch * TAU), sp = Math.sin(pitch * TAU);
  const f = [sy * cp, -sp, cy * cp];
  const su = (px - view.size / 2 + 0.5) * scale + (state.view.vx ?? 0);
  const sv = (view.size / 2 - py - 0.5) * scale + (state.view.vy ?? 0);
  return { o: [r[0] * su + u[0] * sv, r[1] * su + u[1] * sv, r[2] * su + u[2] * sv], f };
}

/**
 * Which part is under (px, py)? March the ray to the surface, then ask each
 * part on its own which is nearest that point.
 *
 * The renderer's own MAT tells you the material, not the part, and two parts
 * can share a material — so this re-evaluates rather than reading it back.
 */
/**
 * Which AUTHORED row each row of the expanded model came from.
 *
 * An instance is not a row anybody can edit, so clicking one has to select the
 * template it was copied from. This walks the same rows `expand` does, in the
 * same order, and keeps the answer.
 */
function sourceRows(parts) {
  const src = [];
  for (let i = 0, r = 0; i < parts.length; i += STRIDE, r++) {
    if (!(parts[i] & SCATTER)) { src.push(r); continue; }
    if (i + STRIDE >= parts.length) break;         // a header with no template
    const n = Math.abs(parts[i + 2]) | 0;
    for (let k = 0; k < n; k++) src.push(r + 1);
    i += STRIDE;
    r++;
  }
  return src;
}

export function pick(px, py) {
  const { o, f } = rayAt(px, py);
  const scale = basis().scale;
  const eps = 0.5 * scale;
  // The picture is of the EXPANDED model, so the hit test has to be too.
  const m = expand(state.parts);
  const src = sourceRows(state.parts);
  // The same rotations the renderer used, or a rotated part is invisible to
  // the hit test and unselectable in the view.
  const rot = prepRot(m);
  // A generous march bound: the model's own extent plus slack.
  let t = -4, hit = false;
  while (t < 4) {
    const d = map(m, o[0] + f[0] * t, o[1] + f[1] * t, o[2] + f[2] * t, rot);
    if (d < eps) { hit = true; break; }
    t += Math.max(d, eps * 0.5);
  }
  if (!hit) return -1;
  const hx = o[0] + f[0] * t, hy = o[1] + f[1] * t, hz = o[2] + f[2] * t;
  let best = -1, bestD = Infinity;
  for (let r = 0, i = 0; i < m.length; i += STRIDE, r++) {
    // A cut has no surface of its own to select, and a paint volume has no
    // surface at all — clicking either should select what it acts ON.
    if (m[i] & (SUBTRACT | PAINT)) continue;
    const one = m.slice(i, i + STRIDE);
    one[11] = 0;                                   // no blending against itself
    const d = Math.abs(map(one, hx, hy, hz, prepRot(one)));
    if (d < bestD) { bestD = d; best = src[r]; }
  }
  return best;
}

// --- gestures ----------------------------------------------------------------

let onedit = null;
/** Called after a gesture changes the document: (settled) => void. */
export const setOnEdit = fn => { onedit = fn; };

/** The gesture in flight: null, or `{ what, handle, ... }`. */
let drag = null;

function initOrbit() {
  let mode = null, from = null;

  // THE LISTENERS ARE ON THE PANE, NOT ON THE PICTURE, and that is not a
  // detail: the overlay covers the PANE, so every widget can be drawn outside
  // the picture. The camera cross always is — it lives in the corner of the
  // window you are working in — and a light's sun orbits at 1.45 bounding radii,
  // which leaves the frame for any model whose bounds are more than about a
  // third of `scale`. Listening on the canvas made all of those visible and
  // dead: the press landed on #stage and no handler ever saw it.
  //
  // The suites could not catch it. They call `cv.dispatchEvent(...)`, which
  // skips hit-testing entirely and fires on the canvas whatever the coordinates
  // say — so a widget outside the picture passed every test and did nothing in
  // a browser. tests/sdftool/test-widgets.mjs presses through real CDP input
  // for exactly that reason.
  host.addEventListener('pointerdown', e => {
    // The viewport owns middle-drag and space-drag, and it takes them in the
    // CAPTURE phase — which stopped this handler cleanly while it lived on the
    // canvas, because the canvas was then a later object in the path. On the
    // same element it no longer can: when the pane itself is the target, both
    // of its listeners run. So the guard is repeated rather than assumed.
    if (e.button !== 0 || panModifier()) return;
    const rect = cv.getBoundingClientRect();
    const px = (e.clientX - rect.left) * cv.width / rect.width;
    const py = (e.clientY - rect.top) * cv.height / rect.height;
    // Overlay pixels for the widgets, which are drawn and hit-tested over the
    // whole pane at 1:1.
    const [ox, oy] = clientToOverlay(e);
    host.setPointerCapture(e.pointerId);

    // THE WIDGETS GO FIRST, and the order is the whole point of them. The ray
    // picker can only hit a surface, so a paint-only part — colour and no
    // shape — was selectable from the list and then not draggable at all. A
    // handle is a number, not a surface.
    if (vw.inside(ov.width, ov.height, ox, oy)) {
      mode = vw.onPan(ov.width, ov.height, ox, oy) ? 'pan' : 'orbit';
      from = {
        x: e.clientX, y: e.clientY, yaw: state.view.yaw, pitch: state.view.pitch,
        vx: state.view.vx ?? 0, vy: state.view.vy ?? 0,
      };
      drag = { what: mode };
      drawOverlay();
      return;
    }

    // Then the suns, while they are shown. Above the part gizmo because a
    // light you can see is a light you meant to grab, and hidden they are not
    // in the way at all.
    if (view.lights && !e.shiftKey) {
      const l = lights().find(o => lgt.hit(o.g, ox, oy));
      if (l) {
        mode = 'light';
        // The side is taken ONCE, here: two points of the sphere project to
        // every pixel, and re-deriving the near one mid-drag would make a light
        // jump sides as it crossed the rim.
        const side = lgt.sideOf(l.g.dir, forward());
        from = {
          x: e.clientX, y: e.clientY, ox, oy, which: l.which, dir: l.g.dir, side,
          p0: lgt.onSphere(planeAt(ox, oy), forward(), lightRadius(), side),
        };
        drag = { what: 'light', light: l.which };
        if (onedit) onedit(false, true);   // snapshot for undo, once per drag
        drawOverlay();
        return;
      }
    }

    // THEN THE RIG PIVOT, above the part gizmo and for the same reason the
    // suns are: a handle you can see is a handle you meant to grab, and a
    // group's pivot usually sits right on top of one of its own parts.
    const rg = rig && !e.shiftKey ? rigGizmo() : null;
    const rh = rg ? giz.hit(rg, rig.mode(), ox, oy) : null;
    if (rh) {
      mode = 'rig';
      from = { x: e.clientX, y: e.clientY, ox, oy, h: rh, g: rg, p: [...rg.c] };
      drag = { what: 'rig', handle: rh };
      rig.begin();
      if (onedit) onedit(false, true);   // snapshot for undo, once per drag
      drawOverlay();
      return;
    }

    // A SHAPE HANDLE OUTRANKS AN ARM. Both live in this slot and both are
    // grabbed within 8 px, but a dilate handle sits ON the shape while an arm
    // reaches 54 px out, so on a small part the arm's base is what a press near
    // the handle would otherwise catch.
    const sh = !e.shiftKey ? shape.hit(shapeHandles(), ox, oy) : null;
    const h = sh || (state.sel >= 0 && state.sel < count() && !e.shiftKey
      && !isScatter(state.sel)
      ? giz.hit(gizmo(), view.mode, ox, oy) : null);
    if (h) {
      mode = 'gizmo';
      const i = state.sel;
      const g = gizmo();
      from = {
        x: e.clientX, y: e.clientY, ox, oy, h, g,
        p: [get(i, 1), get(i, 2), get(i, 3)],
        rot: [get(i, 4), get(i, 5), get(i, 6)],
        dim: [get(i, 7), get(i, 8), get(i, 9), get(i, 10)],
      };
      // A GROUP DRAG IS ABSOLUTE, so it reads the rows as they were when the
      // press landed. Accumulating per-move deltas would drift on rotation —
      // three decimals of Euler decomposition, re-decomposed sixty times a
      // second — and the parts would creep apart under the hand.
      if (multi()) {
        const ids = selection();
        const pivot = [...g.c];
        from.group = { ids, pivot, rows: state.parts.slice(),
          radius: groupRadius(state.parts, ids, pivot) };
      }
      drag = { what: 'gizmo', handle: h };
      if (onedit) onedit(false, true);   // snapshot for undo, once per drag
      drawOverlay();
      return;
    }

    // Shift-drag always orbits, so a camera move is available even with the
    // pointer over the model.
    const id = e.shiftKey ? -1 : pick(px, py);
    if (id >= 0) {
      // CTRL, NOT SHIFT, adds a part to the selection here. Shift is already
      // "orbit whatever is under the pointer" in this pane and giving it a
      // second meaning would make the camera unreachable over a model. The part
      // LIST takes shift-click, where nothing else wants it.
      if (e.ctrlKey || e.metaKey) {
        toggleSelect(id);
        drag = null;
        drawOverlay();
        if (onedit) onedit(false);
        return;
      }
      selectOnly(id);
      mode = 'part';
      from = { x: e.clientX, y: e.clientY, p: [get(id, 1), get(id, 2), get(id, 3)] };
      if (onedit) onedit(false, true);   // snapshot for undo, once per drag
    } else {
      mode = 'orbit';
      from = { x: e.clientX, y: e.clientY, yaw: state.view.yaw, pitch: state.view.pitch };
    }
    drag = { what: mode };
    // NOT restart(). A press selects a part or takes hold of the camera; it
    // changes no pixel, and re-rendering for it was throwing away a finished
    // picture to draw the same one again. The gizmo has moved, so the OVERLAY
    // is redrawn — and that is the whole of what a press changes.
    drawOverlay();
    if (onedit) onedit(false);
  });

  host.addEventListener('pointermove', e => {
    if (!mode) return;
    if (mode === 'gizmo') { applyGizmo(e, from); return; }
    if (mode === 'rig') { applyRig(e, from); return; }
    if (mode === 'light') { applyLight(e, from); return; }
    if (mode === 'pan') {
      // Panning measures the CANVAS: the model has to stay under the pointer.
      const rect = cv.getBoundingClientRect();
      const { scale } = basis();
      state.view.vx = round(from.vx - (e.clientX - from.x) * cv.width / rect.width * scale);
      state.view.vy = round(from.vy + (e.clientY - from.y) * cv.height / rect.height * scale);
      restart(1);
      if (onedit) onedit(false);
      return;
    }
    // THE TWO GESTURES MEASURE DIFFERENT THINGS, and it matters because the
    // canvas is displayed several times its own resolution.
    //
    // Orbiting is a camera control, so it measures the HAND: a full turn per
    // 400 px of screen travel, the same rate the noodletool's orbit uses, so
    // the two editors feel alike. Scaling it by the display zoom made it three
    // times too slow at 160 in a 480 box.
    //
    // Dragging a part is direct manipulation, so it measures the CANVAS: the
    // part has to stay under the pointer, which means converting screen
    // movement to the pixels it lands on first.
    const rect = cv.getBoundingClientRect();
    const hx = e.clientX - from.x, hy = e.clientY - from.y;
    if (mode === 'orbit') {
      // BOTH AXES PUSH THE NEAR FACE, the same rule the noodletool's orbit
      // states: you have hold of the side of the model facing you, and it goes
      // where your hand goes. Measured against the projection, not guessed —
      // in sdf.js's basis a positive yaw carries the far side left and a
      // positive pitch carries it UP, so rightward is +yaw and downward is
      // +pitch. Pitch was negated here, which made the vertical axis the
      // inverse of the horizontal one: dragging down lifted the near face.
      state.view.yaw = round(from.yaw + hx * 0.0025);
      state.view.pitch = round(from.pitch + hy * 0.0025);
    } else {
      const px = hx * cv.width / rect.width, py = hy * cv.height / rect.height;
      const { r, u, scale } = basis();
      const du = px * scale, dv = -py * scale;
      set(state.sel, 1, round(from.p[0] + r[0] * du + u[0] * dv));
      set(state.sel, 2, round(from.p[1] + r[1] * du + u[1] * dv));
      set(state.sel, 3, round(from.p[2] + r[2] * du + u[2] * dv));
    }
    restart(1);
    if (onedit) onedit(false);
  });

  const up = () => {
    if (!mode) return;
    mode = null;
    drag = null;
    drawOverlay();
    if (onedit) onedit(true);
  };
  host.addEventListener('pointerup', up);
  host.addEventListener('pointercancel', up);
}

/**
 * One frame of a light drag.
 *
 * THE SUN STAYS UNDER THE POINTER, which is the same contract the part drag
 * has: the light turns by the rotation carrying the point of the sphere first
 * grabbed onto the point under the pointer now. Measured from the direction the
 * drag STARTED at, like the gizmo, so it cannot chase its own movement.
 *
 * Dragging the fill writes `l2x/l2y/l2z` for the first time, which is what
 * unlinks it from the key — the panel's relink button deletes them again.
 */
function applyLight(e, from) {
  const [ox, oy] = clientToOverlay(e);
  const fine = e.shiftKey ? 0.1 : 1;
  const p1 = lgt.onSphere(planeAt(ox, oy), forward(), lightRadius(), from.side);
  const d = lgt.toCam(lgt.turn(from.dir, from.p0, p1, fine), state.view);
  const keys = from.which ? ['l2x', 'l2y', 'l2z'] : ['lx', 'ly', 'lz'];
  // The fill's three keys have no numeric default — "unset" is their default —
  // so writing them cannot be pruned back out, and the unlink sticks.
  keys.forEach((k, i) => setDial(k, round(d[i])));
  restart(1);
  drawOverlay();
  if (onedit) onedit(false);
}

/**
 * One frame of a gizmo drag.
 *
 * Measured against the gizmo AS IT WAS when the drag started, not as it is
 * now: moving a part moves its handles, and re-deriving the axis from the
 * current position would feed the drag back into itself and accelerate away
 * from the pointer.
 */
function applyGizmo(e, from) {
  const [ox, oy] = clientToOverlay(e);
  const dx = ox - from.ox, dy = oy - from.oy;
  const i = state.sel, g = from.g, h = from.h;
  const fine = e.shiftKey ? 0.1 : 1;      // shift for a slow drag, as everywhere else

  if (from.group) { applyGroupGizmo(from, ox, oy, dx, dy, fine); return; }

  if (h.type === 'end') {
    // A joint is placed, not sized, so it moves in the plane facing you — the
    // same gesture the gizmo's centre handle uses, and for the same reason:
    // there is no one axis that "putting this end there" runs along.
    const { r, u, scale } = basis();
    const du = dx / zoom() * scale * fine, dv = -dy / zoom() * scale * fine;
    const w = shape.endWrite(h, from.p,
      [r[0] * du + u[0] * dv, r[1] * du + u[1] * dv, r[2] * du + u[2] * dv]);
    for (let k = 0; k < 3; k++) {
      set(i, 1 + k, round(w.centre[k]));
      set(i, 7 + k, round(w.axis[k]));
    }
    restart(1);
    drawOverlay();
    if (onedit) onedit(false);
    return;
  }

  if (h.type === 'dilate' || h.type === 'face') {
    const dist = shape.along(h, dx, dy) * fine;
    // Never below zero: a negative dimension is a shape turned inside out, and
    // the march fills the frame — the same clamp the scale arms take.
    if (h.type === 'dilate') {
      set(i, h.col, round(Math.max(0, from.dim[h.col - 7] + dist / h.gain)));
    } else {
      // Alt resizes about the centre. It is the only modifier free on this
      // pane: shift is the fine drag everywhere, and space is the pan.
      const w = shape.faceWrite(h, dist, e.altKey);
      set(i, h.col, round(Math.max(0, from.dim[h.col - 7] + w.dim)));
      for (let k = 0; k < 3; k++) set(i, 1 + k, round(from.p[k] + h.wdir[k] * w.move));
    }
    restart(1);
    drawOverlay();
    if (onedit) onedit(false);
    return;
  }

  if (h.type === 'free' || (h.type === 'move' && h.axis < 0)) {
    // The screen plane: the handle a part with no surface is moved by.
    const { r, u, scale } = basis();
    const du = dx / zoom() * scale * fine, dv = -dy / zoom() * scale * fine;
    set(i, 1, round(from.p[0] + r[0] * du + u[0] * dv));
    set(i, 2, round(from.p[1] + r[1] * du + u[1] * dv));
    set(i, 3, round(from.p[2] + r[2] * du + u[2] * dv));
  } else if (h.type === 'move') {
    const d = giz.axisDelta(g, h.axis, dx, dy) * fine;
    const w = g.axes[h.axis].world;
    for (let k = 0; k < 3; k++) set(i, 1 + k, round(from.p[k] + w[k] * d));
  } else if (h.type === 'rotate') {
    const t = giz.ringDelta(g, h.axis, from.ox, from.oy, ox, oy) * fine;
    set(i, 4 + h.axis, round(from.rot[h.axis] + t));
  } else {
    // Scale: the delta along the axis, added to the dimension that axis means
    // for this primitive. Never below zero — a negative half-extent is a shape
    // turned inside out, and the march fills the frame.
    const col = (SCALE_COLS[g.kind] || [])[h.axis];
    if (col != null) {
      const base = from.dim[col - 7];
      const d = giz.axisDelta(g, h.axis, dx, dy) * fine;
      // A capsule's a/b/c are a vector from the centre, so its own sign says
      // which way "longer" is; everything else is a magnitude.
      const signed = g.kind === 2 && base < 0;
      set(i, col, round(signed ? Math.min(0, base - d) : Math.max(0, base + d)));
    }
  }
  restart(1);
  drawOverlay();
  if (onedit) onedit(false);
}

/**
 * The same drag, applied to every selected part at once about their centre.
 *
 * MOVE and ROTATE are the rig's own operations — `translateGroup` and
 * `transformGroup` — because a rigid group of parts is a rigid group of parts
 * whether the anim tab or a multiple selection asked for it.
 *
 * SCALE IS UNIFORM, and that is not a shortcut. A per-axis group scale would
 * have to push a WORLD axis into each member's `a b c`, which live in the
 * member's OWN frame — the two coincide only while nothing is rotated, so the
 * same drag would do something different to a turned part than to its neighbour.
 * One factor on every length is well defined for any arrangement.
 *
 * SCALING a, b, c IS SAFE ON EVERY PRIMITIVE. On the two kinds where those
 * columns are a direction rather than a length — the plane's normal and the
 * capped torus's cap sin/cos — the renderer normalises them, so multiplying all
 * of them by one factor changes nothing there. `blend` scales too, or the
 * smooth joins would stay the same absolute width and a shrunk group would fuse
 * into a blob.
 */
function applyGroupGizmo(from, ox, oy, dx, dy, fine) {
  const { ids, pivot, rows, radius } = from.group;
  const g = from.g, h = from.h;

  if (h.type === 'free' || (h.type === 'move' && h.axis < 0)) {
    const { r, u, scale } = basis();
    const du = dx / zoom() * scale * fine, dv = -dy / zoom() * scale * fine;
    applyWrites(translateGroup(rows, ids,
      [r[0] * du + u[0] * dv, r[1] * du + u[1] * dv, r[2] * du + u[2] * dv]).writes);
  } else if (h.type === 'move') {
    const d = giz.axisDelta(g, h.axis, dx, dy) * fine;
    const w = g.axes[h.axis].world;
    applyWrites(translateGroup(rows, ids, [w[0] * d, w[1] * d, w[2] * d]).writes);
  } else if (h.type === 'rotate') {
    const t = giz.ringDelta(g, h.axis, from.ox, from.oy, ox, oy) * fine;
    const { writes, gimbal } = transformGroup(rows, pivot, ids, axisMatrix(h.axis, t));
    applyWrites(writes);
    // The same warning the rig gives, for the same reason: at a quarter turn of
    // pitch the decomposition has no unique answer and roll folds into yaw.
    if (gimbal && view.onstatus) view.onstatus('near gimbal lock — roll folded into yaw');
  } else {
    const d = giz.axisDelta(g, h.axis, dx, dy) * fine;
    const f = Math.max(0.01, 1 + d / radius);
    for (const id of ids) {
      const i = id * STRIDE;
      for (let k = 0; k < 3; k++) set(id, 1 + k, round(pivot[k] + (rows[i + 1 + k] - pivot[k]) * f));
      for (let c = 7; c <= 11; c++) set(id, c, round(rows[i + c] * f));
    }
  }
  restart(1);
  drawOverlay();
  if (onedit) onedit(false);
}

/**
 * The same drag, applied to the RIG's pivot instead of to a part.
 *
 * It measures exactly what `applyGizmo` measures and hands the result over
 * whole: a world point for a move, a turn about a world axis for a rotate. The
 * owner decides what that means to its document — here it can only be one
 * thing, and this file does not need to know which.
 */
function applyRig(e, from) {
  const [ox, oy] = clientToOverlay(e);
  const dx = ox - from.ox, dy = oy - from.oy;
  const h = from.h, g = from.g;
  const fine = e.shiftKey ? 0.1 : 1;

  if (h.type === 'free') {
    const { r, u, scale } = basis();
    const du = dx / zoom() * scale * fine, dv = -dy / zoom() * scale * fine;
    rig.move([
      round(from.p[0] + r[0] * du + u[0] * dv),
      round(from.p[1] + r[1] * du + u[1] * dv),
      round(from.p[2] + r[2] * du + u[2] * dv),
    ]);
  } else if (h.type === 'move') {
    const d = giz.axisDelta(g, h.axis, dx, dy) * fine;
    const w = g.axes[h.axis].world;
    rig.move([round(from.p[0] + w[0] * d), round(from.p[1] + w[1] * d),
      round(from.p[2] + w[2] * d)]);
  } else {
    rig.turn(h.axis, giz.ringDelta(g, h.axis, from.ox, from.oy, ox, oy) * fine);
  }
  restart(1);
  drawOverlay();
  if (onedit) onedit(false);
}

// Three decimals everywhere: it is the precision the file is written at, and
// float dust in a saved model is noise in every diff.
const round = v => +v.toFixed(3);

