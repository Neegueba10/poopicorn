/**
 * Panels: the part list, the inspector, materials, the view, and save/load.
 *
 * Every number here is a SCRUBBER you can also type into — see numfield.js,
 * which the sheet and anim panels share.
 */
import {
  state, KINDS, FIELDS, COL, STRIDE, SUBTRACT, PAINT, MIRROR, count, get, set, kindOf,
  isCut, isPaint, isMirror, isScatter, isTemplate,
  selection, multi, isSelected, selectOnly, toggleSelect,
  addPart, addScatter, duplicatePart, deletePart, deleteSelection, canDelete,
  movePart, setFlag, setKind, bakeMirror, mirrorCrosses,
  addMat, setMat, deleteMat, dial, setDial, fillLinked, fillDir,
  fileText, listModels, loadModel, saveModel, pushUndo, undo, emit, onChange,
} from './state.js';
import { numRow as field } from './numfield.js';
import * as canvas from './canvas.js';
import * as sheetui from './sheetui.js';

const $ = id => document.getElementById(id);
const el = {};
const setStatus = m => { el.status.textContent = m; };

/**
 * What a gesture on the canvas means to the MODEL tab: a snapshot at the start
 * of a drag, the panels refreshed as it runs, a full rebuild when it settles.
 *
 * It is exported because `canvas.setOnEdit` has ONE owner, and the anim tab
 * takes it while it is up — the same gesture there is a key on a channel rather
 * than a write to a model. Switching back re-arms this.
 */
export const modelOnEdit = (settled, snapshot) => {
  if (snapshot) pushUndo();
  if (settled) { state.dirty = true; render(); }
  else { rebuildInspector(); updateBytes(); }
};

/** Ctrl+Z's owner while a tab claims it; null means the model tab's undo. */
let undoOwner = null;
export const setUndoOwner = fn => { undoOwner = fn; };

/** The tool's shared number field, with this panel's undo and settle. */
const numRow = (label, value, step, apply) =>
  field(label, value, step, apply, { settle: emit, snapshot: pushUndo });

// --- the colour picker -------------------------------------------------------
/**
 * FULL RGB, and the browser's own dialog — not a grid of the 256.
 *
 * A material is not a palette entry and never had to be. `sdf.js` shades in
 * true colour and quantises the RESULT: the material is multiplied by the
 * lights, the specular and the fog, and only that goes through `lut` and the
 * dither. The one colour that must exist in the palette is the PIXEL. So the
 * old grid restricted the source to protect the output, which was never in
 * danger — and it cost the reds and bright purples this palette is thinnest
 * on, since a swatch you cannot click is a colour you cannot ask for.
 *
 * Judge the choice in the preview, which is quantised and dithered exactly as
 * the game bakes it. Out-of-gamut simply lands on the nearest entry.
 */
const hex2 = v => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0');
const toHex = rgb => '#' + rgb.map(hex2).join('');
const fromHex = s => [1, 3, 5].map(i => parseInt(s.slice(i, i + 2), 16) / 255);

let rgbInput = null;
/**
 * Open it on `rgb` and call `apply` with `[r, g, b]` 0..1 as the hand moves.
 *
 * ONE INPUT, REUSED, and it stays in the DOM: `showPicker()` needs a connected
 * element and a live user gesture, so it cannot be built on demand off screen.
 * The undo snapshot is taken on the FIRST change rather than on opening, so a
 * picker opened and dismissed leaves no step behind — a native dialog has no
 * cancel event to hang that on.
 */
function pickRgb(rgb, apply) {
  if (!rgbInput) {
    rgbInput = document.createElement('input');
    rgbInput.type = 'color';
    rgbInput.id = 'rgbpick';
    rgbInput.style.cssText = 'position:fixed;left:0;bottom:0;width:1px;height:1px;'
      + 'opacity:0;border:0;padding:0';
    document.body.append(rgbInput);
  }
  rgbInput.value = toHex(rgb);
  let snapped = false;
  rgbInput.oninput = () => {
    if (!snapped) { pushUndo(); snapped = true; }
    apply(fromHex(rgbInput.value));
    emit();
  };
  if (rgbInput.showPicker) rgbInput.showPicker();
  else rgbInput.click();
}

// --- the part list -----------------------------------------------------------
function rebuildParts() {
  el.parts.replaceChildren(...Array.from({ length: count() }, (_, i) => {
    const row = document.createElement('div');
    // ANCHOR vs MEMBER. The inspector edits one row and the gizmo carries all
    // of them, so the list has to show which one the fields below belong to.
    row.className = 'op-row' + (isSelected(i) ? ' selected' : '')
      + (state.sel === i && multi() ? ' anchor' : '');
    const sw = document.createElement('span');
    sw.className = 'chip';
    // A header's own material column is a SPREAD, so its chip shows the colour
    // its instances start from — the template's.
    const src = isScatter(i) && i + 1 < count() ? i + 1 : i;
    const m = state.mats[get(src, COL.mat)] || [1, 0, 1];
    sw.style.background = `rgb(${m.map(v => Math.round(v * 255)).join(',')})`;
    const lbl = document.createElement('span');
    // A scatter reads as one thing in the list because it is one thing: the
    // header says how many, and its template is indented under it.
    lbl.textContent = isScatter(i)
      // The shape is named on the header too: it belongs to the template, and
      // the list is where you look to see what a model is made of.
      ? `${i} ⁘ scatter ×${Math.abs(get(i, 2))}`
        + (src === i ? '' : ` ${KINDS[kindOf(src)]}`)
      : `${i} ${isTemplate(i) ? '↳ ' : ''}${isCut(i) ? '− ' : isPaint(i) ? '◍ ' : ''}`
        + `${KINDS[kindOf(i)]}${isMirror(i) ? ' ⇔' : ''}`;
    // Shift adds or removes; a plain click is still one part and only one.
    lbl.onclick = e => {
      if (e.shiftKey) toggleSelect(i);
      else selectOnly(i);
      emit();
    };
    row.append(sw, lbl);
    const btns = document.createElement('span');
    for (const [t, title, fn] of [
      ['▲', 'earlier — order decides what blends and what cuts', () => { pushUndo(); movePart(i, -1); }],
      ['▼', 'later', () => { pushUndo(); movePart(i, 1); }],
      ['⧉', 'duplicate', () => { pushUndo(); duplicatePart(i); }],
      ['✕', 'delete', () => { pushUndo(); deletePart(i); }],
    ]) {
      const b = document.createElement('button');
      b.textContent = t;
      b.title = title;
      b.onclick = () => { fn(); emit(); };
      btns.append(b);
    }
    row.append(btns);
    return row;
  }));
}

// --- the inspector -----------------------------------------------------------
/**
 * The scatter header's own panel: a seed, a count, and one spread per column.
 *
 * IT IS NOT A PART, so it does not get a part's inspector. It has no position,
 * no primitive and no dimensions — those belong to the template below it, which
 * is edited exactly like any other part.
 *
 * The dimension spreads are labelled from the TEMPLATE's primitive and only the
 * fields that primitive reads are offered, which is the same rule the part
 * inspector follows: a spread on a number the shape ignores is a control that
 * does nothing.
 */
function scatterInspector(box, i) {
  const t = i + 1;
  const tk = t < count() ? kindOf(t) : 0;

  // THE SHAPE IS THE TEMPLATE'S, and it is offered here because here is where
  // people look for it. Every primitive works — the four the renderer inlines
  // (sphere, box, capsule, torus) are the cheap ones to make a mass of, and the
  // rest cost a call per sample. Editing the row itself still works too; this
  // writes the same number.
  if (t < count()) {
    const kindSel = document.createElement('select');
    KINDS.forEach((k, ix) => kindSel.append(new Option(k, ix)));
    kindSel.value = tk;
    kindSel.title = 'the primitive every instance is a copy of. The first four '
      + 'are inlined in the renderer and march fastest';
    kindSel.onchange = () => { pushUndo(); setKind(t, +kindSel.value); emit(); };
    const kl = document.createElement('label');
    kl.className = 'num';
    kl.textContent = 'shape';
    kl.append(kindSel);
    box.append(kl);
  }

  const seed = numRow('seed', get(i, 1), 1,
    v => { set(i, 1, Math.max(1, Math.round(v))); canvas.restart(); });
  const die = document.createElement('button');
  die.textContent = '🎲';
  die.title = 'a different arrangement of the same mass';
  die.onclick = () => {
    pushUndo();
    set(i, 1, 1 + Math.floor(Math.random() * 65534));
    emit();
  };
  seed.append(die);
  box.append(seed);

  // The count's SIGN is the distribution, which is the drawtool's own
  // convention (op 5) — so the panel offers the two as two controls and keeps
  // them in one number.
  box.append(numRow('count', Math.abs(get(i, 2)), 1, v => {
    const n = Math.max(1, Math.min(64, Math.round(v)));
    set(i, 2, get(i, 2) < 0 ? -n : n);
    canvas.restart();
  }));
  // NOT A SHAPE — the volume the instances land in. The label says what it
  // spreads and the options say where.
  const dist = document.createElement('select');
  dist.append(new Option('a box', '1'), new Option('an ellipsoid', '-1'));
  dist.value = get(i, 2) < 0 ? '-1' : '1';
  dist.title = 'the volume the instances land in — not their shape. A big count '
    + 'in an ellipsoid reads as an organic clump; a box reads as a filled rectangle';
  dist.onchange = () => {
    pushUndo();
    set(i, 2, Math.abs(get(i, 2)) * +dist.value);
    emit();
  };
  const bl = document.createElement('label');
  bl.className = 'num';
  bl.textContent = 'scatter in';
  bl.append(dist);
  box.append(bl);

  for (const [c, label] of [[3, 'spread x'], [4, 'spread y'], [5, 'spread z']]) {
    box.append(numRow(label, get(i, c), 0.01, v => { set(i, c, v); canvas.restart(); }));
  }
  // One spread for all three axes: random rotation is one decision, and the
  // slot it frees is what pays for the material spread below.
  box.append(numRow('spin ±', get(i, 6), 0.005,
    v => { set(i, 6, v); canvas.restart(); }));
  for (const [k, label] of Object.entries(FIELDS[tk])) {
    box.append(numRow(`${label} ±`, get(i, COL[k]), 0.01,
      v => { set(i, COL[k], v); canvas.restart(); }));
  }
  box.append(numRow('blend ±', get(i, COL.blend), 0.01,
    v => { set(i, COL.blend, v); canvas.restart(); }));
  const mat = numRow('material +', get(i, COL.mat), 1, v => {
    set(i, COL.mat, Math.max(0, Math.min(state.mats.length - 1, Math.round(v))));
    canvas.restart();
  });
  mat.title = 'choose from this many materials past the template\'s own';
  box.append(mat);
}

function rebuildInspector() {
  const box = el.inspector;
  box.replaceChildren();
  const i = state.sel;
  if (i < 0 || i >= count()) return;

  // WHAT THE FIELDS BELOW APPLY TO. A group gesture is the gizmo's; every
  // number in this panel still writes one row, and a panel that silently edited
  // the anchor of a five-part selection would be a trap.
  if (multi()) {
    const n = selection().length;
    const bar = document.createElement('div');
    bar.className = 'hint';
    bar.textContent = `${n} parts selected — the widget moves, turns and scales `
      + `them together. The fields below are part ${i} only.`;
    const one = document.createElement('button');
    one.textContent = 'just this one';
    one.onclick = () => { selectOnly(i); emit(); };
    box.append(bar, one);
  }

  if (isScatter(i)) return scatterInspector(box, i);

  const kindSel = document.createElement('select');
  KINDS.forEach((k, ix) => kindSel.append(new Option(k, ix)));
  kindSel.value = kindOf(i);
  kindSel.onchange = () => { pushUndo(); setKind(i, +kindSel.value); emit(); };
  const kl = document.createElement('label');
  kl.className = 'num';
  kl.textContent = 'kind';
  kl.append(kindSel);
  box.append(kl);

  for (const [flag, label, on, title] of [
    [SUBTRACT, 'subtract', isCut(i), 'remove this shape from everything ABOVE it in the list'],
    [PAINT, 'paint only', isPaint(i),
      'colour with no shape: blends into the material and leaves the silhouette alone'],
    [MIRROR, 'mirror x', isMirror(i),
      'one row, two shapes: the sample folds across x = 0, so the part and its '
      + 'mirror image are the same numbers. x is held at 0 or above — a mirrored '
      + 'part on the far side has no half left to mirror'],
  ]) {
    const l = document.createElement('label');
    l.className = 'num';
    l.textContent = label;
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = on;
    cb.title = title;
    cb.onchange = () => { pushUndo(); setFlag(i, flag, cb.checked); emit(); };
    l.append(cb);
    box.append(l);
  }

  // Offered only where it means something. The fold is free and this costs a
  // whole row, so it is the deliberate act of giving the two sides separate
  // numbers — which is what an animated pair of arms needs.
  if (isMirror(i) && !isScatter(i) && !isTemplate(i) && kindOf(i) !== 13) {
    const b = document.createElement('button');
    b.textContent = 'bake mirror';
    b.title = 'spend a row to make the mirror image a REAL part: same shape, '
      + 'placed and rotated to match, but its own numbers. Do this when the two '
      + 'sides have to move apart — a clip channel writes one row, so a mirrored '
      + 'pair can only ever be animated in step';
    b.onclick = () => {
      pushUndo();
      bakeMirror(i);
      emit();
      setStatus(`part ${i} baked into ${i} and ${i + 1} — the mirror is a real part now`);
    };
    const l = document.createElement('label');
    l.className = 'num';
    l.textContent = 'symmetry';
    l.append(b);
    box.append(l);
    // THE SHAPE WILL CHANGE, and the warning has to outlive the click — the
    // renderer overwrites the status line as soon as the next frame lands. The
    // fold clips each half at x = 0; two real rows are not clipped, so a part
    // straddling the plane gets its far half handed back.
    if (mirrorCrosses(i)) {
      const w = document.createElement('div');
      w.className = 'hint warn';
      w.textContent = 'this part crosses x = 0, so the fold is clipping each '
        + 'half at the plane. Two real rows are not clipped, so baking can '
        + 'change the shape — move it clear of the plane for an exact bake.';
      box.append(w);
    }
  }

  for (const [k, label] of [['x', 'x'], ['y', 'y'], ['z', 'z']]) {
    box.append(numRow(label, get(i, COL[k]), 0.01, v => { set(i, COL[k], v); canvas.restart(); }));
  }
  // Rotation is in TURNS, so thousandths are the useful step — the same
  // reasoning as the noodletool's orbit.
  for (const k of ['rx', 'ry', 'rz']) {
    box.append(numRow(k, get(i, COL[k]), 0.005,
      v => { set(i, COL[k], v); canvas.restart(); }));
  }
  // Only the fields this primitive actually reads — see FIELDS.
  for (const [k, label] of Object.entries(FIELDS[kindOf(i)])) {
    box.append(numRow(label, get(i, COL[k]), 0.01, v => { set(i, COL[k], v); canvas.restart(); }));
  }
  // For a PAINT part `blend` is how far its colour reaches, not how softly it
  // joins — same column, different meaning, so the label says which.
  box.append(numRow(isPaint(i) ? 'reach' : 'blend', get(i, COL.blend), 0.01,
    v => { set(i, COL.blend, v); canvas.restart(); }));

  const matSel = document.createElement('select');
  state.mats.forEach((_, ix) => matSel.append(new Option(String(ix), ix)));
  matSel.value = get(i, COL.mat);
  matSel.onchange = () => { pushUndo(); set(i, COL.mat, +matSel.value); emit(); };
  const ml = document.createElement('label');
  ml.className = 'num';
  ml.textContent = 'material';
  ml.append(matSel);
  box.append(ml);
}

// --- materials ---------------------------------------------------------------
/**
 * The palette of the model's own materials.
 *
 * CLICK ASSIGNS. Painting the selected part is the thing you do constantly;
 * changing what a colour IS is the thing you do once. So a plain click puts
 * this material on the selected part, and editing the colour is the
 * double-click — the same gesture the noodletool uses to pick a colour, so the
 * two editors agree.
 */
/** Outline whichever swatch the selected part is using — no DOM churn, so it
 * is safe to call between the two halves of a double-click. */
function markMats() {
  const cur = state.sel >= 0 && state.sel < count() ? get(state.sel, COL.mat) : -1;
  [...el.mats.children].forEach((b, ix) => b.classList.toggle('on', ix === cur));
}

function rebuildMats() {
  const cur = state.sel >= 0 && state.sel < count() ? get(state.sel, COL.mat) : -1;
  el.mats.replaceChildren(...state.mats.map((m, ix) => {
    const b = document.createElement('button');
    b.className = 'swatch' + (ix === cur ? ' on' : '');
    b.style.background = `rgb(${m.map(v => Math.round(v * 255)).join(',')})`;
    b.title = `material ${ix} — click to paint the selected part, `
      + 'double-click to pick a colour, shift-click to delete';
    b.onclick = e => {
      if (e.shiftKey) { pushUndo(); deleteMat(ix); emit(); return; }
      if (state.sel < 0 || state.sel >= count()) return;
      pushUndo();
      set(state.sel, COL.mat, ix);
      // NOT emit(). A full render replaceChildren()s this row, and a browser
      // only fires dblclick when both clicks land on the SAME element — so
      // rebuilding here silently killed the double-click that edits the
      // colour. Update exactly what changed instead, and leave these buttons
      // where they are.
      markMats();
      rebuildParts();
      updateBytes();
      canvas.restart();
    };
    b.ondblclick = () => pickRgb(m, rgb => setMat(ix, rgb));
    return b;
  }));
  const add = document.createElement('button');
  add.textContent = '+';
  add.title = 'add a material';
  add.onclick = () => { pushUndo(); addMat(); emit(); };
  el.mats.append(add);
}

// --- view --------------------------------------------------------------------
function rebuildView() {
  el.viewbox.replaceChildren(
    numRow('yaw', state.view.yaw, 0.005, v => { state.view.yaw = v; canvas.restart(); }),
    numRow('pitch', state.view.pitch, 0.005, v => { state.view.pitch = v; canvas.restart(); }),
    numRow('zoom', state.view.scale, 0.02, v => { state.view.scale = v; canvas.restart(); }),
    // Where the centre of the frame looks, in world units along the camera's
    // own right and up. The view widget's pan writes these, and a sheet crops
    // with them; both are 0 for a model centred on its origin.
    numRow('pan x', state.view.vx ?? 0, 0.01, v => { state.view.vx = v; canvas.restart(); }),
    numRow('pan y', state.view.vy ?? 0, 0.01, v => { state.view.vy = v; canvas.restart(); }),
    numRow('specular', state.view.spec, 0.02, v => { state.view.spec = v; canvas.restart(); }),
    numRow('occlusion', state.view.ao, 0.05, v => { state.view.ao = v; canvas.restart(); }),
    numRow('exposure', state.view.exposure ?? 1, 0.02,
      v => { state.view.exposure = v; canvas.restart(); }),
    // Both default to off, and both are measured: an outline past 1 step
    // fringes on the dither, and a shadow costs 45% more time for something
    // occlusion already implies at sprite sizes.
    numRow('outline', state.view.outline ?? 0, 1,
      v => { state.view.outline = Math.max(0, Math.round(v)); canvas.restart(); }),
    numRow('shadow', state.view.shadow ?? 0, 1,
      v => { state.view.shadow = v ? 1 : 0; canvas.restart(); }),
    ...lightRows(),
  );
}

/**
 * The lights and the fog.
 *
 * A DIAL SITTING ON ITS DEFAULT IS NOT IN THE FILE (see LIGHT_DEFAULTS), so
 * these rows read through `dial` and write through `setDial` rather than
 * touching `state.view` — a scrub back to the default has to take the key out
 * again, or a model collects eighteen numbers it does not use.
 */
function dialRow(label, key, step) {
  return numRow(label, dial(key) ?? 0, step, v => { setDial(key, v); canvas.restart(); });
}

/** A colour swatch, in full RGB — see `pickRgb`. A light is not a surface and
 * was never going to be a palette entry anyway. */
function colourRow(label, keys) {
  const rgb = keys.map(k => dial(k));
  const l = document.createElement('label');
  l.className = 'num';
  l.textContent = label;
  const b = document.createElement('button');
  b.className = 'swatch';
  b.style.background = `rgb(${rgb.map(v => Math.round(Math.max(0, Math.min(1, v)) * 255)).join(',')})`;
  b.title = 'click to pick this colour';
  b.onclick = () => pickRgb(rgb, c => keys.forEach((k, i) => setDial(k, +c[i].toFixed(3))));
  l.append(b);
  return l;
}

/**
 * Which groups are open. The panel is rebuilt from scratch after every edit, so
 * without this a group would fold itself the moment you finished scrubbing a
 * dial inside it — which is every drag.
 */
const openGroups = new Set();

function group(title, rows) {
  const d = document.createElement('details');
  // Folded by default: a light is aimed once for a model, and the dials a model
  // is SHAPED with have to stay at the top of the panel.
  d.open = openGroups.has(title);
  d.ontoggle = () => (d.open ? openGroups.add(title) : openGroups.delete(title));
  const s = document.createElement('summary');
  s.textContent = title;
  d.append(s, ...rows);
  return d;
}

/**
 * Send a light through the model to the other side, keeping where it is on
 * screen. A drag holds its hemisphere on purpose (see lightwidget.js), so this
 * is how a key becomes a rim: aim it, then flip it.
 */
function flipRow(which) {
  const b = document.createElement('button');
  b.textContent = 'flip front / back';
  b.title = 'mirror the light through the camera plane: same place on screen, '
    + 'other side of the model — which is how a rim is made';
  b.onclick = () => { pushUndo(); canvas.flipLight(which); emit(); };
  const l = document.createElement('label');
  l.className = 'num';
  l.textContent = 'side';
  l.append(b);
  return l;
}

/**
 * Lock both lights to the camera.
 *
 * ON is what a facing set wants: aim the key once and every yaw is lit from the
 * same side of the screen, so eight facings stay eight rows of one number. OFF
 * is what a prop wants — a lamp lit by its own flame keeps its aim in the world
 * while you orbit around it.
 */
function lightCamRow() {
  const l = document.createElement('label');
  l.className = 'num';
  l.textContent = 'lock to camera';
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = !!dial('lcam');
  cb.title = 'aim the lights against the SCREEN instead of the world: they stay '
    + 'put while you orbit, so every facing of a set is lit from the same side. '
    + 'Ticking it does not move the lights — it converts them';
  cb.onchange = () => { pushUndo(); canvas.setLightCam(cb.checked); emit(); };
  l.append(cb);
  return l;
}

function lightRows() {
  // The sum the light weights are chosen against. Over 1 clips a pale material
  // to flat white, so the panel SAYS so rather than clamping — over-driving is
  // a choice, and a silent clamp is not.
  const sum = dial('amb') + dial('li') + dial('l2i');
  const amb = dialRow('ambient', 'amb', 0.01);
  const tot = document.createElement('span');
  tot.textContent = ` Σ ${sum.toFixed(2)}`;
  tot.className = 'hint' + (sum > 1.001 ? ' warn' : '');
  tot.title = sum > 1.001
    ? 'above 1: a pale material can clip to flat white'
    : 'ambient + key + fill; 1 is the headroom the renderer was tuned for';
  amb.append(tot);

  const relink = document.createElement('button');
  relink.textContent = 'relink';
  relink.disabled = fillLinked();
  relink.title = 'point the second light back at the key, and let it follow again';
  relink.onclick = () => {
    pushUndo();
    for (const k of ['l2x', 'l2y', 'l2z']) setDial(k, null);
    emit();
  };
  const link = document.createElement('label');
  link.className = 'num';
  link.textContent = fillLinked() ? 'facing the key' : 'aimed';
  link.append(relink);

  return [
    lightCamRow(),
    group('key light', [
      dialRow('x', 'lx', 0.01), dialRow('y', 'ly', 0.01), dialRow('z', 'lz', 0.01),
      colourRow('colour', ['lr', 'lg', 'lb']),
      dialRow('strength', 'li', 0.01),
      // 0 is lambert, 1 is the half-lambert wrap. One dial covers a key, a
      // fill and a rim, so there is no light TYPE to store.
      dialRow('wrap', 'lw', 0.02),
      flipRow(0),
    ]),
    group('fill / rim', [
      // While it is linked these three are not in the file at all, so the rows
      // show the direction the RENDERER will use — the key's, negated. Scrubbing
      // one writes it, which unlinks, which is the same rule the widget follows.
      ...['x', 'y', 'z'].map((ax, i) => numRow(ax, fillDir()[i], 0.01,
        v => { setDial('l2' + ax, v); canvas.restart(); })),
      colourRow('colour', ['l2r', 'l2g', 'l2b']),
      dialRow('strength', 'l2i', 0.01),
      dialRow('wrap', 'l2w', 0.02),
      flipRow(1),
      link,
    ]),
    group('fog', [
      dialRow('depth haze', 'fog', 0.02),
      colourRow('colour', ['fogr', 'fogg', 'fogb']),
    ]),
    amb,
  ];
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
  const names = await listModels();
  el.files.replaceChildren(...names.map(n => {
    const d = document.createElement('div');
    d.className = 'file-row' + (n === state.name ? ' current' : '');
    d.textContent = n;
    d.dataset.name = n;
    d.onclick = async () => {
      try {
        await loadModel(n);
        el.name.value = state.name;
        canvas.restart();
        emit();
        setStatus(`loaded ${n}.js`);
      } catch (e) { setStatus(`load failed: ${e.message}`); }
    };
    return d;
  }));
}

export function render() {
  rebuildParts();
  rebuildInspector();
  rebuildMats();
  rebuildView();
  updateBytes();
  canvas.restart();
}

export function initUI() {
  for (const id of ['name', 'new', 'save', 'undo', 'bytes', 'files', 'parts',
    'inspector', 'mats', 'viewbox', 'status', 'size', 'addpart']) el[id] = $(id);

  el.name.value = state.name;
  el.name.oninput = () => { state.name = el.name.value.trim(); };

  KINDS.forEach((k, i) => el.addpart.append(new Option(`+ ${k}`, i)));
  el.addpart.onchange = () => {
    pushUndo();
    addPart(+el.addpart.value);
    el.addpart.selectedIndex = 0;
    emit();
  };

  // Its own button, not the last line of the primitive menu: a scatter adds TWO
  // rows and is a different kind of thing from a primitive. Buried in that menu
  // it read as a fifteenth shape, which is how it went unfound.
  $('addscatter').onclick = () => { pushUndo(); addScatter(); emit(); };

  el.new.onclick = () => {
    pushUndo();
    state.parts = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.45, 0, 0];
    state.mats = [[0.45, 0.43, 0.4]];
    selectOnly(0);
    state.name = 'untitled';
    el.name.value = state.name;
    emit();
  };

  el.save.onclick = async () => {
    try {
      const { bytes } = await saveModel();
      setStatus(`saved src/js/models/${state.name}.js (${bytes} B)`);
      refreshFiles();
    } catch (e) { setStatus(`save failed: ${e.message}`); }
  };

  el.undo.onclick = () => { if (undo()) emit(); };

  // w/e/r for move/rotate/scale — the keys every 3D editor uses, so the hand
  // already knows them.
  const MODES = { 'mode-move': 'move', 'mode-rotate': 'rotate', 'mode-scale': 'scale' };
  const KEYS = { w: 'move', e: 'rotate', r: 'scale' };
  const setMode = m => {
    canvas.view.mode = m;
    for (const [id, name] of Object.entries(MODES)) $(id).classList.toggle('on', name === m);
    canvas.drawOverlay();
  };
  for (const [id, name] of Object.entries(MODES)) $(id).onclick = () => setMode(name);

  // The lights are a separate switch and not a fourth mode: they are shown
  // ALONGSIDE whatever the part gizmo is doing, not instead of it. It is ONE
  // switch across both tabs — a light is the same light wherever you aim it —
  // so it lives in sheetui.js, which can reach both overlays.
  const setLights = sheetui.setLights;
  $('mode-lights').onclick = () => setLights(!canvas.view.lights);

  addEventListener('keydown', e => {
    // A field or a menu with focus eats the shortcuts: Backspace in a text box
    // is an edit, and r in a select jumps to an option.
    if (/^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName) || e.target.isContentEditable) return;
    if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
      // The anim tab claims this while it is up. Undo there means the clip's
      // channels; the posed parts sitting in `state` are a rendering of them,
      // and taking those back would put the document and the picture out of
      // step with no way to tell.
      if (undoOwner) undoOwner();
      else if (undo()) emit();
      return;
    }
    if (e.ctrlKey || e.metaKey) return;
    // Delete removes the selection — the same thing the ✕ button does, so a
    // scatter still goes as a pair. GATED ON THE PART LIST BEING ON SCREEN: the
    // sheet and anim tabs hide it, and a key that deletes something you cannot
    // see is a key that loses work. Backspace too, for the laptops with no
    // Delete key.
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (!el.parts.offsetParent || state.sel < 0 || state.sel >= count()) return;
      e.preventDefault();
      if (!canDelete(state.sel)) return setStatus('a model needs at least one part');
      pushUndo();
      deleteSelection();
      emit();
      return;
    }
    // Back to one part. The selection is a working state and there has to be a
    // key that ends it without hunting for a row to click.
    if (e.key === 'Escape' && multi()) { selectOnly(state.sel); emit(); return; }
    if (KEYS[e.key]) setMode(KEYS[e.key]);
    else if (e.key === 'l') setLights(!canvas.view.lights);
  });

  el.size.onchange = () => canvas.resize(+el.size.value);

  canvas.view.onstatus = setStatus;
  canvas.setOnEdit(modelOnEdit);

  onChange(render);
  refreshFiles();
  render();
}
