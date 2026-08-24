/**
 * The sheet tab: the sprite list, the sprite inspector, and a preview that is
 * the shipped bake.
 *
 * IT PREVIEWS THROUGH src/js/core/sdfsheet.js — the same `sheetBaker` the game
 * calls, not a copy of it. So the packing you see, the order sprites finish
 * in, and the pixels in each rect are the game's, and a bug in either can only
 * be a bug in both. That is worth more than any convenience the tool could
 * gain by rendering the sprites its own way.
 *
 * The bake is stepped from the same rAF loop as the model preview, for the
 * same reason: a 40-sprite sheet is a few hundred milliseconds, and freezing
 * the tab for it would make the sizes hard to feel.
 */
import SDF from '/src/js/core/sdf.js';
import { sheetBaker } from '/src/js/core/sdfsheet.js';
import * as canvas from './canvas.js';
import * as glr from './glrender.js';
import * as sw from './sheetwidgets.js';
import { createViewport } from './viewport.js';
import { numRow as field } from './numfield.js';
import {
  sheet, models, VIEW_DIALS, POV_DIALS, LIGHT_DIALS, DEFAULT_SIZE, selSlot,
  liveCount, effectiveView, lightDirs, fillLinked, addSlot, addFacings,
  deleteSlot, reuseSlot, setSlot, setDial, setLightCam, fitSlot, fitSlots, sameModel,
  copyDialsToSet, bakeSheet, fileText, listSheets, listModels, loadModel,
  loadSheet, saveSheet,
} from './sheet.js';
import { LIGHT_DEFAULTS } from './state.js';

const $ = id => document.getElementById(id);
const el = {};
const setStatus = m => { $('status').textContent = m; };

let baker = null, ctx = null, modelNames = [], t0 = 0, ms = 0;
/** The single-sprite renderer a widget drag re-bakes through, and whether it
 * is the GPU one — so flipping the toggle mid-session rebuilds it. */
let one = null, oneGpu = false;

/**
 * The last COMPLETED bake, held while the next one runs.
 *
 * The model preview's second rule, applied here: never show a half-finished picture when a finished one exists.
 * Scrubbing a sprite dial rebakes the whole sheet, which is a few hundred
 * milliseconds, and blitting it mid-bake made the sheet flicker and repopulate
 * sprite by sprite.
 *
 * The FIRST rule — drop to a draft resolution — deliberately does NOT apply. A
 * sheet's packing is derived from the sprite sizes, so a half-resolution sheet
 * is a different LAYOUT rather than a coarser picture of the same one, and the
 * layout is half of what this tab is for.
 */
let held = null;

/** The sheet picture's size and position on screen — its own viewport, because
 * a sheet is a different shape from a model preview and wants a different
 * magnification. See viewport.js. */
export let viewport = null;

// --- the bake -----------------------------------------------------------------

/**
 * The renderer the bake uses, or undefined for the CPU one.
 *
 * IT IS PASSED INTO `sheetBaker` RATHER THAN REPLACING IT. The packing, the
 * order sprites finish in and the rect table are the GAME's code either way —
 * which is the promise this tab has always made — and only the pixels inside
 * each rect come from somewhere else.
 */
function renderFactory() {
  // Asked per bake, not once: `available()` also reports a context that has
  // been LOST since, and a bake through a dead context produces nothing.
  if (!canvas.view.gpu || !glr.available()) return undefined;
  // A model past the shader's limits has to fall back, and the fallback is per
  // sheet rather than per sprite: a sheet baked half one way and half the other
  // would be impossible to reason about.
  const ok = sheet.slots.every(s => {
    const m = s && models.get(s.model);
    return !m || glr.supports(m[0], m[1]);
  });
  return ok ? (w, h, pal, opts) => glr.create(w, h, pal, opts) : undefined;
}

/** Which back end the last bake used — for the status line and the suites. */
export const backend = () => (renderFactory() ? 'gpu' : 'cpu');

/** Throw the current bake away and start again. Every edit calls this. */
export function restart() {
  if (!ctx) return;
  const src = bakeSheet();
  baker = src.some(Boolean)
    ? sheetBaker(src, canvas.view.pal, sheet.width, {}, renderFactory())
    : null;
  t0 = performance.now();
  ms = 0;
  draw();
}

/**
 * ONE SPRITE, re-rendered in place. What a widget drag calls, sixty times a
 * second.
 *
 * A full `restart()` re-renders every sprite in the sheet to move one light,
 * and on a forty-sprite sheet that is the difference between a drag you can
 * aim and a slideshow. It is only safe because the gestures that use it —
 * orbit, pan, aim — cannot change a sprite's SIZE, so the packing that is
 * already on screen stays correct. `fit` changes a rect, and `fit` is a button.
 */
export function rebakeOne(id) {
  const s = sheet.slots[id], m = s && models.get(s.model);
  if (!baker || !m) return;
  const r = baker.rects, i = id * 4;
  const w = r[i + 2], h = r[i + 3];
  if (!w || !h) return;
  const make = renderFactory();
  const opts = { lo: 1, rampSize: 8 };
  if (!one || oneGpu !== !!make) {
    one = make ? make(w, h, canvas.view.pal, opts) : new SDF(w, h, canvas.view.pal, opts);
    oneGpu = !!make;
  }
  if (one.w !== w || one.h !== h) one.setSize(w, h);
  one.render(m[0], m[1], { ...m[2], ...s.view });
  const c = baker.canvas.getContext('2d');
  const img = c.createImageData(w, h);
  one.toRGBA(new Uint8ClampedArray(img.data.buffer));
  c.putImageData(img, r[i], r[i + 1]);
  // `held` is what `draw` shows while a full bake runs, and no full bake is
  // running — but the next one will hold this, so keep the two in step.
  if (held) held.getContext('2d').drawImage(baker.canvas, 0, 0);
  draw();
}

/** One frame of bake work, then a redraw. Returns false when idle. */
export function tick(budget = 8) {
  if (!baker || baker.done()) return false;
  baker.step(budget);
  ms = performance.now() - t0;
  if (baker.done()) {
    // Keep it: it is what stays on screen through the NEXT bake.
    if (!held) held = document.createElement('canvas');
    held.width = baker.canvas.width;
    held.height = baker.canvas.height;
    held.getContext('2d').drawImage(baker.canvas, 0, 0);
  }
  draw();
  if (baker.done()) updateStats();
  return true;
}

// Test hooks (tests/README.md's `window.drawtool` convention): the rect table
// the bake produced, whether it has finished, and a fingerprint of the pixels.
export const rects = () => (baker ? [...baker.rects] : []);
export const done = () => !!baker && baker.done();

/** FNV-1a over the baked RGBA — the same fingerprint the noodletool's sheet
 * suite uses, so "identical bake" means the same thing in both tools. */
export function hash() {
  if (!baker) return '';
  const c = baker.canvas.getContext('2d');
  const d = c.getImageData(0, 0, baker.canvas.width, baker.canvas.height).data;
  let h = 0x811c9dc5;
  for (let i = 0; i < d.length; i++) {
    h ^= d[i];
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** Match the canvas to the picture, and re-place it when that changes — a
 * sheet grows a row taller the moment a sprite no longer fits, so its fit is
 * not a boot-time decision. */
function resizeTo(w, h) {
  const cv = el.display;
  if (cv.width === w && cv.height === h) return;
  cv.width = w;
  cv.height = h;
  viewport?.apply();
}

/** Blit the sheet at its viewport scale and outline the selection. */
function draw() {
  const cv = el.display;
  if (!baker) {
    resizeTo(sheet.width, 64);
    ctx = cv.getContext('2d');
    ctx.clearRect(0, 0, cv.width, cv.height);
    return;
  }
  // Hold the finished bake until the new one lands. Before the first one has
  // ever finished there is nothing to hold, so the bake shows itself arriving —
  // an empty pane at boot would be worse.
  const src = baker.done() || !held ? baker.canvas : held;
  resizeTo(baker.canvas.width, baker.canvas.height);
  ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, cv.width, cv.height);
  ctx.drawImage(src, 0, 0);
  sw.draw();
}

function updateStats() {
  const px = sheet.slots.reduce((n, s) => n + (s ? s.w * s.h : 0), 0);
  const area = baker ? baker.canvas.width * baker.canvas.height : 0;
  el.stats.textContent = `${liveCount()} sprites · ${sheet.width}x${baker ? baker.canvas.height : 0}`
    + ` at ${viewport ? viewport.scale() : 1}x`
    + ` · ${area ? Math.round(100 * px / area) : 0}% used · ${ms.toFixed(0)} ms`
    + ` · ${backend()}`;
}

/** Sprite id under a click on the preview, or -1. Reads the baker's own rects,
 * so picking cannot disagree with what is on screen. */
function idAt(cx, cy) {
  if (!baker) return -1;
  const r = baker.rects;
  for (let id = 0; id < r.length / 4; id++) {
    const i = id * 4;
    if (r[i + 2] && cx >= r[i] && cx < r[i] + r[i + 2] && cy >= r[i + 1] && cy < r[i + 1] + r[i + 3])
      return id;
  }
  return -1;
}

// --- panels -------------------------------------------------------------------

/** The tool's shared number field — see numfield.js. The sheet keeps no undo
 * stack of its own, so there is no snapshot to take. */
function numRow(label, value, step, apply, inherited = false, onClear = null) {
  let clear = null;
  if (onClear) {
    clear = document.createElement('button');
    clear.textContent = '↺';
    clear.title = 'inherit this dial from the model again';
    clear.onclick = onClear;
  }
  const l = field(label, value, step, apply, { settle: render }, ...(clear ? [clear] : []));
  if (inherited) l.querySelector('input').classList.add('inherited');
  return l;
}

function rebuildSprites() {
  el.sprites.replaceChildren(...sheet.slots.map((s, id) => {
    const row = document.createElement('div');
    row.className = 'op-row' + (sheet.sel === id ? ' selected' : '');
    row.dataset.id = id;
    const lbl = document.createElement('span');
    if (s) {
      const yaw = s.view.yaw;
      lbl.textContent = `${id} ${s.model} ${s.w}×${s.h}${yaw == null ? '' : ` @${+yaw.toFixed(3)}`}`;
    } else {
      lbl.textContent = `${id} — tombstone`;
      lbl.className = 'tomb';
    }
    lbl.onclick = () => { sheet.sel = id; render(); };
    row.append(document.createElement('span'), lbl);
    const b = document.createElement('button');
    if (s) {
      b.textContent = '×';
      b.title = 'delete — the id survives as a tombstone';
      b.onclick = () => { deleteSlot(id); render(); };
    } else {
      b.textContent = '↻';
      b.title = 'reuse this id for a new sprite';
      b.onclick = () => { reuseSlot(id, modelNames[0]); render(); };
      b.disabled = !modelNames.length;
    }
    row.append(b);
    return row;
  }));
}

function rebuildInspector() {
  const s = selSlot();
  if (!s) {
    el.inspector.replaceChildren(Object.assign(document.createElement('div'),
      { className: 'hint', textContent: 'no sprite selected' }));
    // Nothing to aim at, so nothing that aims may be pressed.
    for (const b of ['sflip0', 'sflip1', 'srelink', 'sapplyset', 'slights'])
      $(b).disabled = true;
    return;
  }
  const id = sheet.sel;
  const pick = document.createElement('select');
  for (const n of modelNames) pick.append(new Option(n, n));
  pick.value = s.model;
  pick.onchange = async () => {
    await loadModel(pick.value);
    setSlot(id, { model: pick.value });
    render();
  };
  // Crop to the art. A lamp post in a square frame is mostly empty rect, and
  // an empty rect costs sheet space AND bake time — marching pays per pixel,
  // including the ones nothing is in.
  const fit = document.createElement('button');
  fit.id = 'sfit';
  fit.textContent = 'fit';
  fit.title = 'crop this sprite to its art, longest side unchanged';
  fit.onclick = () => { fitSlot(id); render(); };
  // One frame for every sprite of this model — what a facing set wants, since
  // eight separately fitted frames put the origin in eight different places
  // and the character shifts under itself as it turns.
  const fitSetBtn = document.createElement('button');
  fitSetBtn.id = 'sfitset';
  fitSetBtn.textContent = 'fit set';
  fitSetBtn.title = 'one shared frame for every sprite using this model';
  fitSetBtn.onclick = () => { fitSlots(sameModel(id)); render(); };
  const eff = effectiveView(s);
  // The second light's three keys have no numeric default — "unset" IS their
  // default, and it means "face the key". So the row has to show the direction
  // the RENDERER will use, or an unlinked fill reads as a light aimed at the
  // origin. The same resolution the sun on the overlay is drawn at.
  const fill = lightDirs(eff)[1];
  const resolved = { l2x: fill[0], l2y: fill[1], l2z: fill[2] };
  el.inspector.replaceChildren(
    pick,
    fit,
    fitSetBtn,
    numRow('width', s.w, 1, v => setSlot(id, { w: Math.max(1, Math.round(v)) })),
    numRow('height', s.h, 1, v => setSlot(id, { h: Math.max(1, Math.round(v)) })),
    // A dial the model does not set still has a value — the renderer's own —
    // so the row shows THAT rather than 0, which would say the sprite bakes
    // with no key light at all.
    // `lcam` is a flag, and flipping it CONVERTS the aims rather than writing a
    // 1 and letting the lights jump — see setLightCam.
    ...VIEW_DIALS.map(d => numRow(d, eff[d] ?? resolved[d] ?? LIGHT_DEFAULTS[d] ?? 0,
      d === 'scale' ? 0.02 : d === 'lcam' ? 1 : 0.005,
      v => (d === 'lcam' ? setLightCam(id, v > 0) : setDial(id, d, v)),
      s.view[d] == null,
      s.view[d] == null ? null : () => { setDial(id, d, null); render(); })),
  );
  $('srelink').disabled = fillLinked(eff);
  $('sapplyset').disabled = sameModel(id).length < 2;
  for (const b of ['sflip0', 'sflip1', 'slights']) $(b).disabled = false;
}

async function updateBytes() {
  const text = fileText();
  let msg = `${new Blob([text]).size} B raw`;
  if (window.CompressionStream) {
    const gz = await new Response(new Blob([text]).stream()
      .pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer();
    msg += ` · ${gz.byteLength} B deflated`;
  }
  el.bytes.textContent = msg;
}

async function refreshFiles() {
  const names = await listSheets();
  el.files.replaceChildren(...names.map(n => {
    const d = document.createElement('div');
    d.className = 'file-row' + (n === sheet.name ? ' current' : '');
    d.textContent = n;
    d.dataset.name = n;
    d.onclick = async () => {
      try {
        await loadSheet(n);
        el.name.value = sheet.name;
        render();
        setStatus(`loaded ${n}.js`);
      } catch (e) { setStatus(`load failed: ${e.message}`); }
    };
    return d;
  }));
}

/**
 * Show or hide the suns — in BOTH tabs, off one flag.
 *
 * A light is the same light whichever tab you aim it from, so a switch that
 * meant one thing in the model tab and another in the sheet would be two
 * switches wearing one name. ui.js's `l` key and its own button come through
 * here for that reason.
 */
export function setLights(on) {
  canvas.view.lights = on;
  for (const id of ['slights', 'mode-lights']) $(id)?.classList.toggle('on', on);
  canvas.drawOverlay();
  sw.draw();
}
const setSheetLights = setLights;

/** Rebuild every panel and rebake. Any edit ends here. */
export function render() {
  rebuildSprites();
  rebuildInspector();
  updateBytes();
  restart();
}

// --- boot ---------------------------------------------------------------------

export async function initSheetUI() {
  el.display = $('sheetdisplay');
  el.name = $('sname');
  el.bytes = $('sbytes');
  el.files = $('sfiles');
  el.sprites = $('sprites');
  el.inspector = $('sinspector');
  el.stats = $('sstats');
  ctx = el.display.getContext('2d');
  // THE OVERLAY IS NOT A LAYER. Like the model tab's, it covers the PANE at
  // 1:1 — the camera cross belongs in the corner of the window you are working
  // in, not somewhere inside a sheet you have zoomed to 8x. So the viewport
  // hands it the scale and origin instead of sizing it.
  viewport = createViewport($('sheetstage'), [el.display],
    () => [el.display.width, el.display.height], sw.place);
  sw.initSheetWidgets({
    overlay: $('sheetoverlay'),
    host: $('sheetstage'),
    rectOf: id => (baker && id >= 0 && baker.rects[id * 4 + 2]
      ? [...baker.rects.slice(id * 4, id * 4 + 4)] : null),
    idAt,
    onSelect: id => { sheet.sel = id; render(); },
    onLive: rebakeOne,
    // A gesture ends in a full rebuild: the inspector's numbers have moved, the
    // byte counter has changed, and one full bake settles anything the
    // single-sprite path left stale.
    onDone: render,
  });

  el.name.value = sheet.name;
  el.name.oninput = () => { sheet.name = el.name.value.trim(); };

  // Selection and the widget gestures both live on the pane now — see
  // sheetwidgets.js for why a widget drawn outside the picture cannot be
  // hit-tested on the picture.

  $('sflip0').onclick = () => { sw.flipLight(0); render(); };
  $('sflip1').onclick = () => { sw.flipLight(1); render(); };
  $('srelink').onclick = () => { sw.relinkFill(); render(); };
  $('sapplyset').onclick = () => {
    const n = copyDialsToSet(sheet.sel, [...POV_DIALS, ...LIGHT_DIALS]);
    render();
    setStatus(`copied view and lights onto ${n} more sprite${n === 1 ? '' : 's'}`);
  };
  $('slights').onclick = () => setSheetLights(!canvas.view.lights);

  $('snew').onclick = () => {
    sheet.slots = [];
    held = null;
    sheet.sel = -1;
    sheet.name = 'untitled';
    el.name.value = sheet.name;
    render();
  };

  $('ssave').onclick = async () => {
    try {
      const { bytes } = await saveSheet();
      setStatus(`saved src/js/sheets/${sheet.name}.js (${bytes} B)`);
      refreshFiles();
    } catch (e) { setStatus(`save failed: ${e.message}`); }
  };

  $('sbake').onclick = () => restart();

  // Fit every sprite at once. The packing is derived from the sizes, so this
  // is also the one button that makes a whole sheet smaller.
  $('sfitall').onclick = () => {
    sheet.slots.forEach((s, id) => s && fitSlot(id));
    render();
  };

  $('swidth').onchange = e => { sheet.width = +e.target.value; restart(); };

  $('addsprite').onchange = async e => {
    const n = e.target.value;
    e.target.selectedIndex = 0;
    if (!n) return;
    await loadModel(n);
    addSlot(n);
    render();
  };

  $('addfacings').onchange = async e => {
    const n = e.target.value;
    e.target.selectedIndex = 0;
    if (!n) return;
    await loadModel(n);
    addFacings(n, 8, DEFAULT_SIZE);
    render();
  };

  await refreshModels();
  await refreshFiles();
  render();
}

/** Re-read the model list, and re-import every model already in use — the
 * model tab calls this after a save, or the sheet keeps baking the version it
 * imported first. */
export async function refreshModels() {
  modelNames = await listModels();
  for (const n of [...models.keys()]) await loadModel(n, true);
  for (const sel of ['addsprite', 'addfacings']) {
    const s = $(sel);
    const first = s.firstElementChild;
    s.replaceChildren(first);
    for (const n of modelNames) s.append(new Option(n, n));
  }
}
