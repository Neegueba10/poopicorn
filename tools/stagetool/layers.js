// The layers panel: one row per parallax layer, in DRAW ORDER, far to near.
//
// A stage is a stack of layers, and the layer is where the parallax rate and
// the draw order live — the file has no per-stamp rate or depth at all. So
// this panel is not a view of the document, it IS the document's spine: the
// row order is the order the game draws in, and a stamp's layer is the only
// thing that says how fast it scrolls.
//
// The rates are saved. The NAMES, the hide/lock/solo flags and the
// player-split marker are editor-only (see prefs.js), because a stage stores
// which sprite, not what the editor called its layer.
import {
  state, commit, emit, D, D_ALL, layerRate, layerLocked,
  toggleLayerHidden, toggleLayerLocked, toggleLayerSolo, stampsOnLayer,
  addLayer, removeLayer, moveLayer, moveStampsToLayer,
  setMultiStamps, selStampIxs,
} from './state.js';
import { layerColor } from './overview.js';
import { layerName, setLayerName, spliceLayerNames, swapLayerNames, splitAt, setSplit } from './prefs.js';
import { setStatus } from './status.js';

const $ = id => document.getElementById(id);

/** Move every selected stamp onto layer `li`, each one keeping its position
 * ON SCREEN at the current camera (see moveStampsToLayer). */
export function replaneSelection(li) {
  const ixs = selStampIxs();
  if (!ixs.length) return setStatus('select some stamps first');
  commit(() => setMultiStamps(moveStampsToLayer(ixs, li)));
  setStatus(`${ixs.length} stamps moved to layer ${li}`);
}

function row(li) {
  const ixs = stampsOnLayer(li);
  const hidden = state.hiddenLayers.includes(li);
  const locked = layerLocked(li);
  const solo = state.soloLayer === li;
  const active = state.arm.l === li;

  const el = document.createElement('div');
  el.className = 'plane-row' + (active ? ' active' : '') + (hidden ? ' off' : '');
  el.dataset.layer = li;
  el.dataset.rate = layerRate(li);

  const eye = document.createElement('button');
  eye.textContent = hidden ? '🚫' : '👁';
  eye.title = 'hide this layer (it also stops taking clicks)';
  eye.onclick = e => { e.stopPropagation(); toggleLayerHidden(li); emit(); };

  const lock = document.createElement('button');
  lock.textContent = locked ? '🔒' : '🔓';
  lock.title = 'lock this layer against clicks and marquees';
  lock.onclick = e => { e.stopPropagation(); toggleLayerLocked(li); emit(); };

  const chip = document.createElement('button');
  chip.className = 'plane-rate' + (solo ? ' solo' : '');
  chip.textContent = layerRate(li).toFixed(2);
  chip.style.borderColor = layerColor(li);
  chip.title = 'solo: show only this layer';
  chip.onclick = e => { e.stopPropagation(); toggleLayerSolo(li); emit(); };

  const name = document.createElement('input');
  name.type = 'text';
  name.className = 'plane-name';
  name.value = layerName(li);
  name.placeholder = layerRate(li) === 1 ? 'gameplay'
    : layerRate(li) < 1 ? 'background' : 'foreground';
  name.spellcheck = false;
  name.oninput = () => setLayerName(li, name.value);
  name.onclick = e => e.stopPropagation();

  const count = document.createElement('button');
  count.className = 'plane-count';
  count.textContent = ixs.length;
  count.title = `select all ${ixs.length} stamps on this layer`;
  count.onclick = e => {
    e.stopPropagation();
    setMultiStamps(ixs);
    setStatus(`${ixs.length} stamps on layer ${li}`);
    emit();
  };

  const to = document.createElement('button');
  to.textContent = '⇥';
  to.title = 'move the selected stamps onto this layer';
  to.onclick = e => { e.stopPropagation(); replaneSelection(li); };

  // clicking the row arms this layer, so the next placement lands on it
  el.onclick = () => {
    state.arm.l = li;
    emit(D.VALUES | D.LISTS | D.CANVAS);
  };
  el.append(eye, lock, chip, name, count, to);
  return el;
}

/** The "the player draws here" divider, between two layer rows. */
function splitRow(li) {
  const el = document.createElement('div');
  el.className = 'split-row';
  el.dataset.split = li;
  el.title = 'the layer index the game splits its actors at — pass it to drawStage';
  const line = document.createElement('span');
  line.textContent = `─── actors draw here (${li}) ───`;
  el.append(line);
  return el;
}

export function rebuildLayers() {
  const box = $('layers');
  if (!box) return;
  box.replaceChildren();
  const split = Math.min(splitAt(), state.layers.length);
  // FAR TO NEAR IS TOP TO BOTTOM, matching the panel's own reading order and
  // the file's. The row you can see last is the one drawn last.
  for (let li = 0; li < state.layers.length; li++) {
    if (li === split) box.append(splitRow(li));
    box.append(row(li));
  }
  if (split >= state.layers.length) box.append(splitRow(split));
  $('layer-solo-note').style.display = state.soloLayer == null ? 'none' : '';
  $('layer-rate').value = layerRate(state.arm.l);
  $('layer-split').value = split;
}

/** Show every layer again (the escape hatch from a solo or a stack of hidden
 * layers). */
export function showAllLayers() {
  state.hiddenLayers = [];
  state.soloLayer = null;
  emit(D_ALL);
}

// --- panel buttons --------------------------------------------------------
export function newLayer() {
  commit(() => {
    const at = addLayer(layerRate(state.arm.l), state.arm.l + 1);
    spliceLayerNames(at, 0, true);
  });
  setStatus(`layer ${state.arm.l} added`);
}

export function dropLayer() {
  const li = state.arm.l;
  let why = null;
  commit(() => {
    why = removeLayer(li);
    if (!why) spliceLayerNames(li, 1);
  });
  setStatus(why || `layer ${li} removed`);
}

export function shiftLayer(dir) {
  const li = state.arm.l;
  commit(() => {
    const to = moveLayer(li, dir);
    if (to !== li) swapLayerNames(li, to);
  });
}

export function setArmedRate(rate) {
  const li = state.arm.l;
  const r = Math.max(0, Math.min(8, Math.round(rate * 100) / 100));
  if (r === layerRate(li)) return;
  commit(() => { state.layers[li].rate = r; });
}

export function setSplitAt(li) {
  setSplit(Math.max(0, Math.min(state.layers.length, li)));
  emit(D.LISTS | D.CANVAS);
}
