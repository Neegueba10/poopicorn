/**
 * The sheet tab's widgets: the same camera cross and the same two suns the
 * model tab has, over whichever sprite is selected.
 *
 * WHY THEY ARE THE SAME WIDGETS AND NOT A SECOND SET. A sprite's view is the
 * model's view with overrides on top, so aiming a light or turning a camera in
 * this tab is the same act as in the model tab — it just writes to a slot
 * instead of to the model. Giving it a different gesture would make the two
 * tabs disagree about what dragging a sun means. So `viewwidget.js` and
 * `lightwidget.js` are imported rather than copied, and everything here is the
 * projection that puts them over a sprite's own rect.
 *
 * THE PROJECTION IS THE WHOLE JOB. In the model tab there is one picture at one
 * view, filling the pane. Here there are dozens, each with its own frame, its
 * own `scale`, its own `vx`/`vy`, packed at an arbitrary place in the sheet,
 * and the sheet itself is zoomed and panned. So a world point goes: the
 * sprite's view basis, into the sprite's own rect, into sheet pixels, then
 * through the sheet viewport. `planeAt` runs that backwards, and it is exact
 * because the camera is orthographic.
 *
 * WHAT IT WILL NOT DO IS RE-PACK MID-DRAG. Aiming a light and turning a camera
 * change no sprite's size, so the layout holds still while you drag and only
 * one sprite has to be redrawn. `fit` is the gesture that changes a rect, and
 * it is a button rather than a drag for exactly that reason.
 */
import { bound, expand } from '/src/js/core/sdf.js';
import * as vw from './viewwidget.js';
import * as lgt from './lightwidget.js';
import { panModifier } from './viewport.js';
import { view as modelView } from './canvas.js';
import {
  sheet, models, selSlot, effectiveView, lightDirs, fillLinked, setDials,
} from './sheet.js';

const TAU = Math.PI * 2;
/** Three decimals, as everywhere else: float dust in a saved sheet is noise in
 * every diff. */
const round = v => +v.toFixed(3);

let ov, octx, host, api = null;
/** Where the sheet picture sits in its pane — the viewport tells us. */
let ovScale = 1, ovX = 0, ovY = 0;
/** The gesture in flight. */
let drag = null;

/**
 * @param {object} o
 *   `overlay`  the canvas the widgets draw on, covering the PANE
 *   `host`     the pane the gestures listen on
 *   `rectOf`   (id) => [x, y, w, h] in sheet pixels, or null
 *   `idAt`     (sheetX, sheetY) => sprite id or -1
 *   `onSelect` (id) => void, a click that picked a sprite
 *   `onLive`   (id) => void, one frame of a drag: redraw just this sprite
 *   `onDone`   () => void, the gesture ended
 */
export function initSheetWidgets(o) {
  api = o;
  ov = o.overlay;
  octx = ov.getContext('2d');
  host = o.host;
  initGestures();
}

/** Follow the sheet viewport. Same contract as the model tab's `place`: the
 * overlay covers the PANE at 1:1, so the camera cross stays in the corner you
 * are working in rather than scrolling away at 8x. */
export function place(z, x, y) {
  ovScale = z;
  ovX = x;
  ovY = y;
  if (!ov || !host) return;
  const w = Math.max(1, host.clientWidth), h = Math.max(1, host.clientHeight);
  if (ov.width !== w || ov.height !== h) {
    ov.width = w;
    ov.height = h;
  }
  Object.assign(ov.style, {
    position: 'absolute', left: '0px', top: '0px', width: w + 'px', height: h + 'px',
  });
  draw();
}

// --- geometry -----------------------------------------------------------------

/** The camera basis for a view, matching sdf.js's begin() exactly. */
function basis(eff, rw, rh) {
  const { yaw = 0, pitch = 0 } = eff;
  const cy = Math.cos(yaw * TAU), sy = Math.sin(yaw * TAU);
  const cp = Math.cos(pitch * TAU), sp = Math.sin(pitch * TAU);
  return {
    f: [sy * cp, -sp, cy * cp],
    r: [cy, 0, -sy],
    u: [sy * sp, cp, cy * sp],
    // World units across the SHORT axis — the rule the renderer follows, and
    // the reason a fitted non-square sprite still projects correctly here.
    scale: (eff.scale ?? 3) / Math.min(rw, rh),
  };
}

/**
 * Everything the widgets need about the selected sprite, or null when there is
 * nothing to draw on: no selection, no model loaded, or a rect the bake has not
 * produced yet.
 */
function frame() {
  const s = selSlot();
  const m = s && models.get(s.model);
  const r = api && api.rectOf(sheet.sel);
  if (!m || !r || !r[2]) return null;
  const eff = effectiveView(s);
  return { id: sheet.sel, slot: s, model: m, eff, rect: r, ...basis(eff, r[2], r[3]) };
}

/** World point to overlay pixel, through the sprite's rect and the sheet
 * viewport. The inverse of the renderer's ray setup, `vx`/`vy` included. */
function projectWith(fr) {
  return (x, y, z) => {
    const su = x * fr.r[0] + y * fr.r[1] + z * fr.r[2] - (fr.eff.vx ?? 0);
    const sv = x * fr.u[0] + y * fr.u[1] + z * fr.u[2] - (fr.eff.vy ?? 0);
    // Screen Y grows down and world Y grows up — the flip sdf.js applies.
    const sx = fr.rect[0] + su / fr.scale + fr.rect[2] / 2 - 0.5;
    const sy = fr.rect[1] + fr.rect[3] / 2 - 0.5 - sv / fr.scale;
    return [sx * ovScale + ovX, sy * ovScale + ovY];
  };
}

/** The world point under an overlay pixel, on the camera's own plane through
 * the origin. Orthographic, so this is exact and has no depth term. */
function planeAt(fr, ox, oy) {
  const sx = (ox - ovX) / ovScale - fr.rect[0], sy = (oy - ovY) / ovScale - fr.rect[1];
  const su = (sx - fr.rect[2] / 2 + 0.5) * fr.scale + (fr.eff.vx ?? 0);
  const sv = (fr.rect[3] / 2 - sy - 0.5) * fr.scale + (fr.eff.vy ?? 0);
  return [fr.r[0] * su + fr.u[0] * sv, fr.r[1] * su + fr.u[1] * sv,
    fr.r[2] * su + fr.u[2] * sv];
}

/** The radius the suns orbit at, in world units. Measured on the EXPANDED
 * model, or a scatter's instances hang outside the sphere its suns ride. */
const lightRadius = fr => (bound(expand(fr.model[0])) || 1) * lgt.ORBIT;

/** The two suns, in overlay pixels: the key first, then the fill or rim. */
function lights(fr) {
  const br = bound(expand(fr.model[0])) || 1;
  const dirs = lightDirs(fr.eff);
  const proj = projectWith(fr);
  return [0, 1].map(w => ({
    which: w,
    g: lgt.place(dirs[w], br, proj, fr.f),
    col: w ? [fr.eff.l2r ?? 1, fr.eff.l2g ?? 1, fr.eff.l2b ?? 1]
      : [fr.eff.lr ?? 1, fr.eff.lg ?? 1, fr.eff.lb ?? 1],
    i: w ? fr.eff.l2i ?? 0.1 : fr.eff.li ?? 0.74,
  }));
}

// --- drawing ------------------------------------------------------------------

export function draw() {
  if (!octx) return;
  octx.clearRect(0, 0, ov.width, ov.height);
  const fr = frame();
  if (fr) {
    // The selected sprite's rect, so it is obvious which sprite the widgets
    // are aiming. On the overlay it is one crisp pixel at any zoom; in the
    // picture it would be a magnified block.
    const [x, y, w, h] = fr.rect;
    octx.save();
    octx.strokeStyle = '#4af';
    octx.lineWidth = 1;
    octx.strokeRect(Math.round(x * ovScale + ovX) + 0.5, Math.round(y * ovScale + ovY) + 0.5,
      Math.round(w * ovScale) - 1, Math.round(h * ovScale) - 1);
    octx.restore();
    if (modelView.lights) {
      for (const l of lights(fr)) {
        lgt.draw(octx, l.g, l.col, l.i > 0, drag && drag.light === l.which);
      }
    }
  }
  vw.draw(octx, ov.width, ov.height, fr ? fr.eff : {});
}

// --- gestures -----------------------------------------------------------------

/** Client pixel to overlay pixel. */
function clientToOverlay(e) {
  const r = ov.getBoundingClientRect();
  return [e.clientX - r.left, e.clientY - r.top];
}

function initGestures() {
  let mode = null, from = null;

  // ON THE PANE, NOT ON THE PICTURE — the same rule the model tab states. The
  // camera cross lives in the pane's corner and a sun orbits at 1.45 bounding
  // radii, so both are routinely outside the sheet image. Listening on the
  // canvas would leave them visible and dead.
  host.addEventListener('pointerdown', e => {
    if (e.button !== 0 || panModifier()) return;
    const [ox, oy] = clientToOverlay(e);
    const fr = frame();

    // THE WIDGETS GO FIRST, for the model tab's reason: a handle is a number,
    // not a surface, and the sprite under it must not steal the press.
    if (fr && vw.inside(ov.width, ov.height, ox, oy)) {
      host.setPointerCapture(e.pointerId);
      mode = vw.onPan(ov.width, ov.height, ox, oy) ? 'pan' : 'orbit';
      from = {
        x: e.clientX, y: e.clientY, fr,
        yaw: fr.eff.yaw ?? 0, pitch: fr.eff.pitch ?? 0,
        vx: fr.eff.vx ?? 0, vy: fr.eff.vy ?? 0,
      };
      drag = { what: mode };
      draw();
      return;
    }

    if (fr && modelView.lights && !e.shiftKey) {
      const l = lights(fr).find(o => lgt.hit(o.g, ox, oy));
      if (l) {
        host.setPointerCapture(e.pointerId);
        mode = 'light';
        // The side is taken ONCE, here: two points of the sphere project to
        // every pixel, and re-deriving the near one mid-drag would make a light
        // jump sides as it crossed the rim.
        const side = lgt.sideOf(l.g.dir, fr.f);
        from = {
          x: e.clientX, y: e.clientY, fr, which: l.which, dir: l.g.dir, side,
          p0: lgt.onSphere(planeAt(fr, ox, oy), fr.f, lightRadius(fr), side),
        };
        drag = { what: 'light', light: l.which };
        draw();
        return;
      }
    }

    // Then the sheet itself. A press picks the sprite under it — which is what
    // this tab has always done — and a DRAG from there orbits that sprite. So
    // selecting and turning are one gesture, in the order a hand makes them.
    const sx = (ox - ovX) / ovScale, sy = (oy - ovY) / ovScale;
    const id = api.idAt(sx, sy);
    if (id >= 0 && id !== sheet.sel) api.onSelect(id);
    const f2 = frame();
    if (!f2) return;
    host.setPointerCapture(e.pointerId);
    mode = 'orbit';
    from = {
      x: e.clientX, y: e.clientY, fr: f2,
      yaw: f2.eff.yaw ?? 0, pitch: f2.eff.pitch ?? 0,
    };
    drag = { what: 'orbit' };
    draw();
  });

  host.addEventListener('pointermove', e => {
    if (!mode) return;
    const fr = from.fr;
    if (mode === 'light') { applyLight(e, from); return; }
    if (mode === 'pan') {
      // Panning measures the SHEET's own pixels: the model has to stay under
      // the pointer, so screen movement is divided by the viewport zoom before
      // it becomes world units.
      setDials(fr.id, {
        vx: round(from.vx - (e.clientX - from.x) / ovScale * fr.scale),
        vy: round(from.vy + (e.clientY - from.y) / ovScale * fr.scale),
      });
      live(fr.id);
      return;
    }
    // Orbiting is a CAMERA control, so it measures the hand — a full turn per
    // 400 px — rather than the canvas. The same rate the model tab and the
    // noodletool use, so the three feel alike. Both axes push the near face.
    setDials(fr.id, {
      yaw: round(from.yaw + (e.clientX - from.x) * 0.0025),
      pitch: round(from.pitch + (e.clientY - from.y) * 0.0025),
    });
    live(fr.id);
  });

  const up = () => {
    if (!mode) return;
    mode = null;
    drag = null;
    draw();
    api.onDone();
  };
  host.addEventListener('pointerup', up);
  host.addEventListener('pointercancel', up);
}

/**
 * One frame of a light drag. The sun stays under the pointer, turned by the
 * rotation the hand made — the arcball contract lightwidget.js documents, and
 * the same call the model tab makes.
 */
function applyLight(e, from) {
  const fr = from.fr;
  const [ox, oy] = clientToOverlay(e);
  const p1 = lgt.onSphere(planeAt(fr, ox, oy), fr.f, lightRadius(fr), from.side);
  const d = lgt.toCam(lgt.turn(from.dir, from.p0, p1, e.shiftKey ? 0.1 : 1), fr.eff);
  const keys = from.which ? ['l2x', 'l2y', 'l2z'] : ['lx', 'ly', 'lz'];
  // Dragging the fill writes its three keys for the first time, which is what
  // unlinks it from the key — `relink` deletes them again.
  setDials(fr.id, Object.fromEntries(keys.map((k, i) => [k, round(d[i])])));
  live(fr.id);
}

/** One sprite redrawn, and the widgets with it. A full rebake per drag frame
 * would re-render every sprite in the sheet to move one light. */
function live(id) {
  api.onLive(id);
  draw();
}

// --- the buttons the widget needs ---------------------------------------------

/**
 * Mirror a light through the camera plane: the same place on screen, the other
 * side of the model. Aim it, then flip it — that is a rim.
 */
export function flipLight(which) {
  const fr = frame();
  if (!fr) return;
  const d = lgt.toCam(lgt.flip(lightDirs(fr.eff)[which], fr.f), fr.eff);
  const keys = which ? ['l2x', 'l2y', 'l2z'] : ['lx', 'ly', 'lz'];
  setDials(fr.id, Object.fromEntries(keys.map((k, i) => [k, round(d[i])])));
}

/** Drop the fill's own direction so it follows the key again. */
export function relinkFill() {
  const fr = frame();
  if (fr) setDials(fr.id, { l2x: null, l2y: null, l2z: null });
}

/** Whether the selected sprite's fill still follows its key. */
export const isFillLinked = () => {
  const fr = frame();
  return !fr || fillLinked(fr.eff);
};

// --- test hooks (tests/README.md's convention) --------------------------------

/** Overlay pixel to client pixel. */
function toClient() {
  const r = ov.getBoundingClientRect();
  return (x, y) => ({ x: r.left + x, y: r.top + y });
}

/** Where each sun is, in CLIENT coordinates, whether or not the lights are
 * shown — a suite asserting a hidden sun cannot be grabbed presses where it
 * would have been. */
export function debugLights() {
  const fr = frame();
  if (!fr) return [];
  const c = toClient();
  return lights(fr).map(l => ({
    which: l.which,
    behind: l.g.behind,
    ...c(l.g.x, l.g.y),
    cx: c(0, 0).x + l.g.cx,
    cy: c(0, 0).y + l.g.cy,
    r: lightRadius(fr) / fr.scale * ovScale,
  }));
}

/** Where the view widget's box and pan handle are, in client coordinates. */
export function debugViewWidget() {
  const b = vw.box(ov.width, ov.height);
  const c = toClient();
  return { pan: c(b.x + b.s / 2, b.y + b.s / 2), rim: c(b.x + 6, b.y + 6) };
}

/** The centre of a sprite's rect, in client coordinates — where a suite
 * presses to select and turn one. */
export function debugSpriteAt(id) {
  const r = api && api.rectOf(id);
  if (!r || !r[2]) return null;
  const c = toClient();
  return c((r[0] + r[2] / 2) * ovScale + ovX, (r[1] + r[3] / 2) * ovScale + ovY);
}
