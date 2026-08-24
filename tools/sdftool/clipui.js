/**
 * The anim tab: a timeline, a frame cache, and posing through the model tab's
 * own canvas.
 *
 * IT BORROWS THE MODEL TAB'S STAGE, and that is the whole reason a clip needed
 * no new renderer, no new gizmo and no new camera. Entering the tab writes the
 * POSED parts of the frame under the playhead into `state`, so the preview, the
 * part gizmo, the orbit and the two suns all keep working exactly as they do
 * one tab over. Leaving puts the model tab's own document back.
 *
 * WHAT A GESTURE MEANS IS THE ONE THING THAT CHANGES. In the model tab a drag
 * writes a model; here the same drag is a KEY at the playhead. `onEdit` finds
 * every part number that no longer matches what the clip says at this frame and
 * writes it into a channel, making the channel if this is the first time that
 * field has moved. There is no record button, because a record button is a mode
 * you forget you are not in and an hour of posing that went nowhere.
 *
 * THE FRAME CACHE IS THE SHIPPED BAKE. Every frame is baked once through
 * `clipSheet` and `sheetBaker` — the game's two modules, not copies of them —
 * into one strip. That strip is the timeline's thumbnails AND the picture
 * playback shows, which is why ten frames a second is possible: the preview
 * renderer makes one picture at a time and could never keep up, and the baked
 * pixels are what the game will draw anyway.
 *
 * The draft rules carry over. Rule 1 — a coarse
 * picture while changes arrive — is the model canvas's own and applies to the
 * pose without a line here. Rule 2 — never show a half-finished picture when a
 * finished one exists — is `held` below, as in the sheet tab.
 */
import SDF from '/src/js/core/sdf.js';
import { sheetBaker } from '/src/js/core/sdfsheet.js';
import { clipSheet } from '/src/js/core/sdfanim.js';
import * as canvas from './canvas.js';
import * as glr from './glrender.js';
import * as ui from './ui.js';
import { numRow as field, scrubbable } from './numfield.js';
import { models, VIEW_DIALS, listModels, loadModel } from './sheet.js';
import { state, STRIDE, COL, FIELDS, emit } from './state.js';
import {
  clip, MODES, ONION, modelOf, baseParts, partCount, effectiveView,
  refuse, isHeader, chanFor, addChannel, removeChannel, key, keyed, setFrames,
  setModel, clipArray, posedParts, fitClip, fileText, listClips, loadClip,
  saveClip, pushUndo, undo, clearUndo,
  selGroup, addGroup, removeGroup, toggleMember, setPivot, applyGroup,
} from './clip.js';

const $ = id => document.getElementById(id);
const el = {};
const setStatus = m => { $('status').textContent = m; };
const COLNAME = Object.keys(COL);

let baker = null, held = null, modelNames = [], ms = 0, t0 = 0;
/** The single-frame renderer a scrub re-bakes through, and whether it is the
 * GPU one — so flipping the toggle mid-session rebuilds it. */
let one = null, oneGpu = false;
/** The model tab's document, held while this tab borrows `state`. */
let saved = null;
/** When the last playback frame was shown. */
let lastStep = 0;

// --- the bake ------------------------------------------------------------------

/** The GPU factory, or undefined for the CPU renderer. The same per-bake
 * question the sheet tab asks, and for the same reason: a context can be lost. */
function renderFactory() {
  if (!canvas.view.gpu || !glr.available()) return undefined;
  const m = modelOf();
  if (!m || !glr.supports(m[0], m[1])) return undefined;
  return (w, h, pal, opts) => glr.create(w, h, pal, opts);
}

/**
 * Bake every frame again.
 *
 * The strip is one row wide on purpose — `sheetBaker` shelf-packs tallest
 * first and every frame is the same height, so a width of `w * frames` lays
 * them out left to right in frame order. That makes the timeline a filmstrip
 * rather than a lookup.
 */
export function restart() {
  const arr = clipArray();
  if (!arr) { baker = null; return; }
  baker = sheetBaker(clipSheet(arr), canvas.view.pal,
    Math.max(1, clip.w * clip.frames), {}, renderFactory());
  t0 = performance.now();
  ms = 0;
}

/** One frame of the strip, re-rendered in place. What a scrub calls, sixty
 * times a second: a channel value at frame 4 cannot change frame 5. */
export function rebakeFrame(f) {
  const arr = clipArray();
  if (!baker || !arr || f < 0 || f >= clip.frames) return;
  const r = baker.rects, i = f * 4;
  const w = r[i + 2], h = r[i + 3];
  if (!w || !h) return;
  const make = renderFactory();
  const opts = { lo: 1, rampSize: 8 };
  if (!one || oneGpu !== !!make) {
    one = make ? make(w, h, canvas.view.pal, opts) : new SDF(w, h, canvas.view.pal, opts);
    oneGpu = !!make;
  }
  if (one.w !== w || one.h !== h) one.setSize(w, h);
  const row = clipSheet(arr)[f];
  one.render(row[0][0], row[0][1], { ...row[0][2], ...row[1] });
  const c = baker.canvas.getContext('2d');
  const img = c.createImageData(w, h);
  one.toRGBA(new Uint8ClampedArray(img.data.buffer));
  c.putImageData(img, r[i], r[i + 1]);
  if (held) held.getContext('2d').drawImage(baker.canvas, 0, 0);
  drawStrip();
}

/** Test hooks, the `window.drawtool` convention (tests/README.md). */
export const rects = () => (baker ? [...baker.rects] : []);
export const baked = () => !!baker && baker.done();

/** One frame of bake work and, if it is playing, one frame of playback. */
export function tick(budget = 8) {
  let busy = false;
  if (baker && !baker.done()) {
    baker.step(budget);
    ms = performance.now() - t0;
    if (baker.done()) {
      if (!held) held = document.createElement('canvas');
      held.width = baker.canvas.width;
      held.height = baker.canvas.height;
      held.getContext('2d').drawImage(baker.canvas, 0, 0);
      updateStats();
    }
    drawStrip();
    canvas.paint();
    busy = true;
  }
  if (clip.playing) {
    const now = performance.now();
    if (now - lastStep >= 1000 / Math.max(1, clip.fps)) {
      lastStep = now;
      advance();
      busy = true;
    }
  }
  return busy;
}

/** The next frame, by mode. `mode` is core/Animation.js's numbering: 0 loop,
 * 1 pingpong, 2 once. */
let pingDir = 1;
function advance() {
  const n = clip.frames;
  if (clip.mode === 1) {
    if (clip.frame + pingDir < 0 || clip.frame + pingDir >= n) pingDir = -pingDir;
    clip.frame += pingDir;
  } else if (clip.mode === 2 && clip.frame >= n - 1) {
    setPlaying(false);
    return;
  } else {
    clip.frame = (clip.frame + 1) % n;
  }
  markPlayhead();
  canvas.paint();
}

export function setPlaying(on) {
  clip.playing = on;
  pingDir = 1;
  lastStep = performance.now();
  $('aplay').textContent = on ? '⏸' : '▶';
  $('aplay').classList.toggle('on', on);
  // Playing shows baked pixels, so the live render has nothing to do; stopping
  // needs it back, at the pose the playhead landed on.
  if (!on) { pose(); canvas.restart(); }
  canvas.paint();
}

// --- the picture ---------------------------------------------------------------

/**
 * Draw the frame `f` of the strip into the preview box, aligned with the live
 * render.
 *
 * THE TWO ARE THE SAME CAMERA at different pixel densities. `scale` is world
 * units across the SHORT axis, so the preview shows `scale` units over
 * `view.size` pixels and a frame shows the same `scale` over `min(w, h)`. The
 * magnification between them is therefore exactly the ratio of those two, and
 * both are centred on the same world point — so a ghost lands on the pose it is
 * a ghost of, to the pixel.
 */
function blitFrame(cx, f, boxW, boxH, alpha) {
  const src = baker.done() || !held ? baker.canvas : held;
  const r = baker.rects, i = f * 4;
  if (!r[i + 2]) return;
  const k = Math.min(boxW, boxH) / Math.min(clip.w, clip.h);
  const dw = clip.w * k, dh = clip.h * k;
  cx.save();
  cx.globalAlpha = alpha;
  cx.imageSmoothingEnabled = false;
  cx.drawImage(src, r[i], r[i + 1], clip.w, clip.h,
    Math.round((boxW - dw) / 2), Math.round((boxH - dh) / 2), dw, dh);
  cx.restore();
}

/**
 * Called by `canvas.paint` under the picture. Returns true when it has painted
 * the picture itself, which is what playback does.
 */
function under(cx, w, h) {
  if (!baker) return false;
  if (clip.playing) { blitFrame(cx, clip.frame, w, h, 1); return true; }
  if (!clip.onion) return false;
  const n = clip.frames;
  blitFrame(cx, (clip.frame + n - 1) % n, w, h, 0.45);
  if (clip.onion === 2) blitFrame(cx, (clip.frame + 1) % n, w, h, 0.45);
  return false;
}

// --- the pose ------------------------------------------------------------------

/** Put the frame under the playhead into `state`, where the canvas and the
 * gizmo will find it. The view goes too, so a `vy` or a `yaw` channel moves the
 * live preview and not only the bake. */
function pose() {
  const m = modelOf();
  if (!m) return;
  state.parts = posedParts(clip.frame);
  state.view = effectiveView(clip.frame);
  state.sel = Math.max(0, Math.min(clip.sel, partCount() - 1));
}

/**
 * A gesture on the canvas, read as keys.
 *
 * Every part number that no longer matches what the clip says at this frame is
 * a key. A number the format refuses to animate — `kind`, or any column of a
 * scatter header — is put back and reported rather than written, because the
 * alternative is a file the server rejects at save time, an hour later.
 */
function onEdit(settled, snapshot) {
  if (snapshot) pushUndo();
  const want = posedParts(clip.frame);
  let refused = '';
  for (let i = 0; i < want.length; i++) {
    if (state.parts[i] === want[i]) continue;
    const why = refuse(i);
    if (why) { refused = refused || why; continue; }
    key(i, state.parts[i]);
  }
  // The x clamp on a mirrored part may have moved a number back, and a refused
  // one never moved at all — so the pose on screen comes from the CLIP, always,
  // rather than from what the gesture happened to leave in `state`.
  pose();
  if (refused) setStatus(refused);
  if (settled) { rebakeFrame(clip.frame); render(); } else { rebuildChannels(); }
  canvas.restart(!settled);
}

function onUndo() {
  if (!undo()) return;
  pose();
  canvas.restart();
  render();
}

// --- the rig -------------------------------------------------------------------

/** 'move' | 'rotate' — what the pivot's handles do. Rotate is the default,
 * because turning a group is the thing a group exists for; moving is placing
 * the pivot, which you do once. */
let pivotMode = 'rotate';
/** The pose the group drag started from. A turn is measured from THERE and not
 * from the last frame, or the rotation composes with itself and runs away. */
let groupFrom = null;

/**
 * The pivot gizmo's contract with canvas.js. It knows nothing about groups; it
 * hands over a world point or a turn about a world axis, and this decides what
 * that means.
 */
const rigHooks = {
  at: () => (selGroup() ? selGroup().pivot : null),
  mode: () => pivotMode,
  begin: () => { groupFrom = posedParts(clip.frame); },
  move(p) {
    // Moving the pivot moves NO PART. It is where the next turn will swing
    // from, and a pivot that dragged the arm with it could never be placed.
    setPivot(clip.group, p);
    rebuildRig();
  },
  turn(axis, t) {
    if (!groupFrom) return;
    const { gimbal } = applyGroup(clip.group, groupFrom, 'turn', [axis, t]);
    pose();
    if (gimbal) {
      setStatus('gimbal lock: this pitch is a quarter turn, where the X and Z '
        + 'rotations become the same rotation — the roll has been folded into the yaw');
    }
    rebuildChannels();
  },
};

/** The rig panel: the group list, its pivot, and which parts are in it. */
function rebuildRig() {
  if (!el.rig) return;
  const g = selGroup();
  $('agroupdel').disabled = !g;
  $('apivotmove').classList.toggle('on', pivotMode === 'move');
  $('apivotturn').classList.toggle('on', pivotMode === 'rotate');
  el.groups.replaceChildren(...clip.groups.map((grp, i) => {
    const row = document.createElement('div');
    row.className = 'op-row' + (i === clip.group ? ' selected' : '');
    row.dataset.group = i;
    const lbl = document.createElement('span');
    lbl.textContent = `${grp.name} · ${grp.parts.length}`;
    lbl.style.flex = '1';
    lbl.onclick = () => { clip.group = i; rebuildRig(); canvas.drawOverlay(); };
    row.append(lbl);
    return row;
  }));
  if (!clip.groups.length) {
    el.groups.append(Object.assign(document.createElement('div'), {
      className: 'hint',
      textContent: 'no groups — make one to swing several parts from one point',
    }));
  }
  if (!g) { el.rig.replaceChildren(); return; }
  const name = document.createElement('input');
  name.type = 'text';
  name.id = 'agroupname';
  name.value = g.name;
  name.oninput = () => { g.name = name.value; clip.dirty = true; rebuildRig(); };
  const pivot = ['x', 'y', 'z'].map((ax, k) =>
    numRow(`pivot ${ax}`, g.pivot[k], 0.005,
      v => { const p = [...g.pivot]; p[k] = v; setPivot(clip.group, p); },
      () => { rebuildRig(); canvas.drawOverlay(); }));
  const members = document.createElement('div');
  members.id = 'amembers';
  for (let i = 0; i < partCount(); i++) {
    if (isHeader(i)) continue;      // no centre to swing about, and no column to write
    const l = document.createElement('label');
    l.className = 'num';
    l.textContent = `${i} ${(FIELDS[baseParts()[i * STRIDE] & 31] ? '' : '')}`.trim();
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.dataset.part = i;
    cb.checked = g.parts.includes(i);
    cb.onchange = () => {
      pushUndo();
      toggleMember(clip.group, i);
      rebuildRig();
      canvas.drawOverlay();
    };
    l.append(cb);
    members.append(l);
  }
  el.rig.replaceChildren(name, ...pivot, members);
}

// --- panels --------------------------------------------------------------------

/** The tool's shared number field — see numfield.js — with the clip's undo. */
const numRow = (label, value, step, apply, done) =>
  field(label, value, step, apply, { settle: done || render, snapshot: pushUndo });

/**
 * The filmstrip. One cell per frame, each showing the BAKED sprite — so what
 * you scrub through is what the game will draw, at the size it will draw it.
 */
function rebuildStrip() {
  el.cells = [];
  el.strip.replaceChildren(...Array.from({ length: clip.frames }, (_, f) => {
    const cell = document.createElement('div');
    cell.className = 'frame' + (f === clip.frame ? ' on' : '');
    cell.dataset.frame = f;
    const cv = document.createElement('canvas');
    cv.width = clip.w;
    cv.height = clip.h;
    const tag = document.createElement('span');
    tag.textContent = f;
    cell.append(cv, tag);
    // Click or drag across the strip to scrub. A pointerenter with the button
    // still down is a drag, which is how a scrub reads on a row of cells.
    cell.onpointerdown = e => { e.preventDefault(); goTo(f); };
    cell.onpointerenter = e => { if (e.buttons & 1) goTo(f); };
    el.cells.push({ cell, cv });
    return cell;
  }));
  drawStrip();
}

/** Blit each frame of the bake into its cell, and mark which frames a channel
 * moves at. */
function drawStrip() {
  if (!el.cells || !baker) return;
  const src = baker.done() || !held ? baker.canvas : held;
  const r = baker.rects;
  for (let f = 0; f < el.cells.length; f++) {
    const { cell, cv } = el.cells[f];
    const i = f * 4;
    const cx = cv.getContext('2d');
    cx.clearRect(0, 0, cv.width, cv.height);
    if (r[i + 2]) cx.drawImage(src, r[i], r[i + 1], clip.w, clip.h, 0, 0, clip.w, clip.h);
    cell.classList.toggle('on', f === clip.frame);
    cell.classList.toggle('keyed', clip.channels.some(ch => keyed(ch.target, f)));
  }
}

function markPlayhead() {
  if (!el.cells) return;
  for (let f = 0; f < el.cells.length; f++)
    el.cells[f].cell.classList.toggle('on', f === clip.frame);
  el.frameno.textContent = `frame ${clip.frame + 1}/${clip.frames}`;
  rebuildChannels();
}

/** Move the playhead. The pose follows it, and so does the live render. */
export function goTo(f) {
  const n = clip.frames;
  clip.frame = ((f % n) + n) % n;
  if (clip.playing) setPlaying(false);
  pose();
  markPlayhead();
  // A scrub is a stream of changes, so the preview drops to a draft for it —
  // draft rule 1, with no code here beyond saying that this is a stream.
  canvas.restart(1);
}

/** A label a person can read: `4.rx` for a part column, `vy` for a dial. */
function targetLabel(t) {
  if (typeof t == 'string') return t;
  const col = t % STRIDE, row = (t - col) / STRIDE;
  const named = (FIELDS[baseParts()[row * STRIDE] & 31] || {})[COLNAME[col]];
  return `${row}.${COLNAME[col]}${named ? ` (${named})` : ''}`;
}

function rebuildChannels() {
  if (!el.channels) return;
  el.frameno.textContent = `frame ${clip.frame + 1}/${clip.frames}`;
  el.channels.replaceChildren(...clip.channels.map(ch => {
    const row = document.createElement('div');
    row.className = 'op-row';
    row.dataset.target = ch.target;
    const lbl = document.createElement('span');
    lbl.textContent = targetLabel(ch.target);
    lbl.style.flex = '1';
    const i = document.createElement('input');
    i.type = 'number';
    i.step = typeof ch.target == 'string' && ch.target === 'scale' ? 0.02 : 0.005;
    i.value = +(+ch.values[clip.frame]).toFixed(4);
    i.className = 'chanval';
    scrubbable(i, +i.step, v => { key(ch.target, v); pose(); canvas.restart(1); }, {
      // A value change at frame 4 cannot change frame 5, so only frame 4 is
      // baked again. That is the whole invalidation rule, and the dense table
      // is what makes it this simple.
      settle: () => { rebakeFrame(clip.frame); render(); },
      snapshot: pushUndo,
    });
    const del = document.createElement('button');
    del.textContent = '×';
    del.title = 'stop animating this field';
    del.onclick = () => { pushUndo(); removeChannel(ch.target); pose(); render(); restart(); };
    row.append(lbl, i, del);
    return row;
  }));
  if (!clip.channels.length) {
    el.channels.append(Object.assign(document.createElement('div'),
      { className: 'hint', textContent: 'nothing animated yet — move a part with the gizmo' }));
  }
  rebuildAdd();
}

/** The two ways to start a channel by hand: a column of the selected part, or
 * a view dial. The gizmo is the third and needs no menu. */
function rebuildAdd() {
  const s = el.add;
  s.replaceChildren(new Option('animate…', ''));
  const row = state.sel;
  if (modelOf() && row >= 0 && row < partCount()) {
    const g = document.createElement('optgroup');
    g.label = `part ${row}`;
    for (let c = 1; c < STRIDE; c++) {
      const t = row * STRIDE + c;
      if (refuse(t) || chanFor(t)) continue;
      g.append(new Option(targetLabel(t), String(t)));
    }
    if (g.children.length) s.append(g);
  }
  const g2 = document.createElement('optgroup');
  g2.label = 'view';
  for (const d of VIEW_DIALS) if (!chanFor(d)) g2.append(new Option(d, d));
  if (g2.children.length) s.append(g2);
}

function rebuildParts() {
  const s = el.part;
  s.replaceChildren();
  for (let i = 0; i < partCount(); i++) {
    const k = baseParts()[i * STRIDE];
    s.append(new Option(`${i} ${refuse(i * STRIDE + 1) ? '⁘ scatter' : ''}`.trim()
      + (k & 64 ? ' paint' : '') + (k & 32 ? ' cut' : ''), String(i)));
  }
  s.value = String(state.sel);
}

function rebuildSettings() {
  el.settings.replaceChildren(
    numRow('frames', clip.frames, 1,
      v => setFrames(v),
      () => { pose(); render(); restart(); }),
    numRow('fps', clip.fps, 1,
      v => { clip.fps = Math.max(1, Math.min(60, Math.round(v))); clip.dirty = true; },
      () => render()),
    numRow('width', clip.w, 1,
      v => { clip.w = Math.max(1, Math.round(v)); clip.dirty = true; },
      () => { render(); restart(); }),
    numRow('height', clip.h, 1,
      v => { clip.h = Math.max(1, Math.round(v)); clip.dirty = true; },
      () => { render(); restart(); }),
  );
}

async function updateBytes() {
  if (!clip.model) { el.bytes.textContent = '—'; return; }
  const text = fileText();
  let msg = `${new Blob([text]).size} B raw`;
  if (window.CompressionStream) {
    const gz = await new Response(new Blob([text]).stream()
      .pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer();
    msg += ` · ${gz.byteLength} B deflated`;
  }
  el.bytes.textContent = msg;
}

/**
 * The bake estimate, beside the frame count.
 *
 * March cost is linear in the EXPANDED part count and in pixels, so a
 * scatter-heavy model costs per instance and a bigger sprite costs
 * quadratically. Both multiply by the frame count here, which is the one number
 * this tab can quietly make expensive.
 */
function updateStats() {
  const m = modelOf();
  const parts = m ? clipSheet(clipArray())[0][0][0].length / STRIDE : 0;
  const px = clip.w * clip.h * clip.frames;
  el.stats.textContent = `${clip.frames} frames · ${parts} parts · ${px} px`
    + ` · ${ms.toFixed(0)} ms · ${renderFactory() ? 'gpu' : 'cpu'}`;
}

async function refreshFiles() {
  const names = await listClips();
  el.files.replaceChildren(...names.map(n => {
    const d = document.createElement('div');
    d.className = 'file-row' + (n === clip.name ? ' current' : '');
    d.textContent = n;
    d.dataset.name = n;
    d.onclick = async () => {
      try {
        await loadClip(n);
        await loadModel(clip.model);
        el.name.value = clip.name;
        pose();
        canvas.restart();
        render();
        restart();
        setStatus(`loaded ${n}.js`);
      } catch (e) { setStatus(`load failed: ${e.message}`); }
    };
    return d;
  }));
}

/** Rebuild every panel. Any edit ends here. */
export function render() {
  el.model.value = clip.model;
  el.mode.value = String(clip.mode);
  el.onion.value = String(clip.onion);
  rebuildParts();
  rebuildSettings();
  rebuildStrip();
  rebuildChannels();
  rebuildRig();
  updateBytes();
  updateStats();
}

// --- the tab -------------------------------------------------------------------

/**
 * Take the canvas over: borrow `state` for the posed frame, claim the edit hook
 * and the undo key, and hang the onion/playback painter under the picture.
 */
export async function enter() {
  if (!clip.model) {
    if (!modelNames.length) modelNames = await listModels();
    if (!modelNames.length) { setStatus('no models to animate yet'); return; }
    await loadModel(modelNames[0]);
    setModel(modelNames[0]);
  } else if (!models.has(clip.model)) {
    await loadModel(clip.model);
  }
  saved = JSON.stringify({
    name: state.name, parts: state.parts, mats: state.mats,
    view: state.view, sel: state.sel, also: state.also, dirty: state.dirty,
  });
  // A multiple selection belongs to the model tab. Left in place it would give
  // this tab a GROUP gizmo over a posed frame, and a group drag writes six
  // numbers per member straight into `state.parts` — which here is a rendering
  // of the channels, not the document.
  state.also = [];
  const m = modelOf();
  state.name = clip.model;
  state.mats = m[1].map(x => [...x]);
  pose();
  canvas.setOnEdit(onEdit);
  canvas.setRig(rigHooks);
  canvas.view.under = under;
  ui.setUndoOwner(onUndo);
  canvas.restart();
  render();
  restart();
}

/** Hand the canvas back exactly as it was found. */
export function leave() {
  if (clip.playing) setPlaying(false);
  canvas.view.under = null;
  canvas.setRig(null);
  canvas.setOnEdit(ui.modelOnEdit);
  ui.setUndoOwner(null);
  if (!saved) return;
  Object.assign(state, JSON.parse(saved));
  saved = null;
  // The model tab's panels are still showing the POSED numbers this tab left
  // in `state`. Telling them the document changed is what puts the model's own
  // back on screen.
  emit();
}

export async function initClipUI() {
  el.name = $('aname');
  el.bytes = $('abytes');
  el.files = $('afiles');
  el.model = $('amodel');
  el.part = $('apart');
  el.settings = $('asettings');
  el.channels = $('achannels');
  el.add = $('aadd');
  el.strip = $('astrip');
  el.stats = $('astats');
  el.frameno = $('aframeno');
  el.mode = $('amode');
  el.onion = $('aonion');
  el.groups = $('agroups');
  el.rig = $('arig');

  for (const [i, n] of MODES.entries()) el.mode.append(new Option(n, String(i)));
  for (const [i, n] of ONION.entries()) el.onion.append(new Option(n, String(i)));

  el.name.oninput = () => { clip.name = el.name.value.trim(); };
  el.mode.onchange = () => { clip.mode = +el.mode.value; clip.dirty = true; updateBytes(); };
  el.onion.onchange = () => { clip.onion = +el.onion.value; canvas.paint(); };

  el.model.onchange = async () => {
    pushUndo();
    await loadModel(el.model.value);
    setModel(el.model.value);
    const m = modelOf();
    state.mats = m[1].map(x => [...x]);
    pose();
    canvas.restart();
    render();
    restart();
  };

  el.part.onchange = () => {
    clip.sel = +el.part.value;
    state.sel = clip.sel;
    canvas.drawOverlay();
    rebuildChannels();
  };

  el.add.onchange = () => {
    const v = el.add.value;
    el.add.selectedIndex = 0;
    if (!v) return;
    pushUndo();
    const t = /^\d+$/.test(v) ? +v : v;
    if (!addChannel(t)) { setStatus(refuse(t)); return; }
    render();
  };

  // A group starts from whatever part is selected — that is the one you were
  // just looking at, and adding the rest is a checkbox each.
  $('agroupnew').onclick = () => { pushUndo(); addGroup([state.sel]); render(); };
  $('agroupdel').onclick = () => { pushUndo(); removeGroup(clip.group); render(); canvas.drawOverlay(); };
  $('apivotmove').onclick = () => { pivotMode = 'move'; rebuildRig(); canvas.drawOverlay(); };
  $('apivotturn').onclick = () => { pivotMode = 'rotate'; rebuildRig(); canvas.drawOverlay(); };

  $('aplay').onclick = () => setPlaying(!clip.playing);
  $('aprev').onclick = () => goTo(clip.frame - 1);
  $('anext').onclick = () => goTo(clip.frame + 1);
  $('abake').onclick = () => restart();

  // ONE frame for every pose. Per-frame fitting would centre each pose on its
  // own art and the character would shift under itself as it played.
  $('afit').onclick = () => {
    pushUndo();
    const f = fitClip();
    if (!f) { setStatus('nothing to fit'); return; }
    pose();
    canvas.restart();
    render();
    restart();
    setStatus(`fit to ${f.w}x${f.h}${f.warn ? ` — ${f.warn}` : ''}`);
  };

  $('anew').onclick = () => {
    clip.name = 'untitled';
    clip.view = {};
    clip.frames = 6;
    clip.fps = 10;
    clip.mode = 0;
    clip.channels = [];
    clip.groups = [];
    clip.frame = 0;
    clip.group = -1;
    clip.dirty = false;
    clearUndo();
    el.name.value = clip.name;
    pose();
    canvas.restart();
    render();
    restart();
  };

  $('asave').onclick = async () => {
    try {
      const { bytes } = await saveClip();
      setStatus(`saved src/js/clips/${clip.name}.js (${bytes} B)`);
      refreshFiles();
    } catch (e) { setStatus(`save failed: ${e.message}`); }
  };

  // Space plays and pauses, and the arrows step a frame. Only while this tab is
  // up, and never while a number input has the caret.
  addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT' || e.ctrlKey || e.metaKey) return;
    if (window.sdftool?.getMode?.() !== 'anim') return;
    if (e.key === ' ') { e.preventDefault(); setPlaying(!clip.playing); }
    else if (e.key === ',') goTo(clip.frame - 1);
    else if (e.key === '.') goTo(clip.frame + 1);
  });

  await refreshModels();
  await refreshFiles();
  el.name.value = clip.name;
}

/** Re-read the model list. The model tab calls this after a save, so a clip
 * follows an edit to the model it poses. */
export async function refreshModels() {
  modelNames = await listModels();
  el.model.replaceChildren(...modelNames.map(n => new Option(n, n)));
  if (clip.model) el.model.value = clip.model;
}
