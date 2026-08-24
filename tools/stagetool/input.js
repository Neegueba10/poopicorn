// Pointer/keyboard handling for the stage editor: select/move stamps, AABBs
// and objects, place armed stamps (optionally snapped to nearby stamps'
// edges, optionally painted along a drag), drag out collision boxes,
// rubber-band/shift-click multi-select for bulk parallax edits, group moves,
// Alt+drag duplication and Ctrl+C/V copy-paste. The event plumbing (pointer
// capture on #center, space/middle-drag pan, cursor-anchored wheel zoom) is
// adapted from tools/worldtool/input.js — but panning here moves the editing
// CAMERA rather than a scroll offset, because the world is unbounded and only
// a viewport of it is ever rendered.
import {
  state, commit, pushUndo, undo, redo, emit, snapTo, addStamp, addAabb, addObject,
  offsetSel, deleteSel, eyedrop, aabbEdgeAt, aabbHandles, objectAt,
  stampAtView, selStampIxs, selAabbIxs, selObjIxs, setSelection,
  clearSelection, toggleMultiStamp, srcDims, brushSource, layerRate,
  snapToSprites, copySelection, pasteClipboard, dragOffsetStamps,
  cellOf, cellRect, paintCell, eraseCell, fillCells, bakeTiles, D, D_DRAG,
} from './state.js';
import {
  display, blit, refresh, rebuildView, setGhost, setTileHover,
  viewFromEvent, worldFromEvent, placeFromEvent, stampsInBox, aabbsInBox,
  objectsInBox, centerOn, fitStage, frameSelection,
} from './canvas.js';
import {
  toggleRuntimeView, setTool, setCoords, repeatSelection, boxStamps,
  saveCurrentStage, orderStamps,
} from './ui.js';
import { setStatus } from './status.js';
import { markOf, setMark } from './prefs.js';
import { toggleShortcuts } from './shortcuts.js';
import * as playtest from './playtest.js';

const center = document.getElementById('center');

let dragHandle = null;   // AABB corner handle being dragged (resize)
let dragMove = null;     // { last: [x, y] } whole-selection drag
let dragged = false;     // first movement pushes one undo snapshot per drag
let boxAnchor = null;    // rubber-band start (aabb tool / marquee)
let marquee = false;
let marqueeBase = null;  // selection the in-progress marquee extends (shift), else null
let painting = false;    // a stamp-tool drag is laying a run
let paintLast = null;    // world position of the last stamp the run laid
let tileAnchor = null;   // [cx, cy] rect-fill start (tile tool, Shift-drag)
let tileLast = null;     // [cx, cy] last hovered cell (tile tool)
let tilePainting = false; // a freehand tile stroke is in progress
let tileErase = false;   // this tile stroke erases (right-click or Ctrl)
let spaceDown = false;
let panning = false;
let panStart = null;     // [clientX, clientY, camX, camY]

const armedSource = () => state.arm.k > -2;

/** Where the armed stamp lands for this event: grid-snap by default, or
 * (sprite-snap on) aligned per axis to the nearest edge/corner of an
 * existing same-rate stamp within a few screen px, falling back to grid
 * snap on whichever axis nothing was close enough to. */
function placedPos(e) {
  const [px, py] = placeFromEvent(e);
  let sx = snapTo(px), sy = snapTo(py);
  if (state.spriteSnap) {
    const [w, h] = srcDims(state.arm.k, state.arm.i);
    const [tx, ty] = snapToSprites(px, py, w, h, state.arm.l, 6 / state.zoom);
    if (tx != null) sx = tx;
    if (ty != null) sy = ty;
  }
  return [sx, sy];
}

/** Lay one stamp of a drag-painted run, if the cursor has moved far enough
 * from the last one. The default gap is the sprite's own size, which is what
 * makes a ground run one drag instead of thirty clicks. */
function paintStep(e) {
  const [px, py] = placedPos(e);
  const [w, h] = srcDims(state.arm.k, state.arm.i);
  const gap = state.paintSpacing || Math.max(4, Math.min(w || 8, h || 8));
  if (paintLast) {
    const dx = px - paintLast[0], dy = py - paintLast[1];
    if (dx * dx + dy * dy < gap * gap) return;
  }
  paintLast = [px, py];
  commit(() => addStamp(px, py, brushSource()), false, D_DRAG | D.LISTS);
}

center.addEventListener('pointerdown', e => {
  if (state.runtimeView || playtest.active()) return; // no editing while previewing
  if (e.button === 1 || (e.button === 0 && spaceDown)) {
    e.preventDefault();
    display.setPointerCapture(e.pointerId);
    panning = true;
    panStart = [e.clientX, e.clientY, state.cam[0], state.cam[1]];
    center.style.cursor = 'grabbing';
    return;
  }
  // right-click has no meaning except tile erase, so every other tool still
  // ignores it (and the browser's own context menu)
  if (e.button === 2 && state.tool !== 'tile') return;
  if (e.button !== 0 && e.button !== 2) return;
  display.setPointerCapture(e.pointerId);
  const [wx, wy] = worldFromEvent(e);
  const [vx, vy] = viewFromEvent(e);

  // Alt+click eyedrops: adopt a placed stamp's sprite AND its rate, depth
  // and flip, which is the only sane way to extend an existing parallax
  // band. With the select tool and something already selected, Alt starts a
  // duplicate-drag instead — the standard gesture everywhere else.
  if (e.altKey) {
    if (state.tool === 'select' && selStampIxs().length
      && selStampIxs().includes(stampAtView(vx, vy))) {
      pushUndo();
      pasteFromSelection();
      state.lastStep = [0, 0];
      dragMove = { last: [wx, wy] };
      dragged = true;
      setStatus('duplicating');
      return;
    }
    const ix = stampAtView(vx, vy);
    if (ix < 0) return setStatus('nothing to eyedrop here');
    eyedrop(ix);
    setTool('stamp');
    return;
  }

  if (state.tool === 'tile') {
    pushUndo();
    tileErase = e.button === 2 || e.ctrlKey;
    const [ccx, ccy] = cellOf(wx, wy);
    tileLast = [ccx, ccy];
    if (e.shiftKey) {
      tileAnchor = [ccx, ccy];
      const [rx0, ry0, rx1, ry1] = cellRect(ccx, ccy);
      state.dragBox = [rx0, ry0, rx1 - 1, ry1 - 1];
    } else if (document.getElementById('tile-fill').checked && !tileErase) {
      const n = fillCells(ccx, ccy, state.tileType);
      setStatus(n ? `filled ${n} cells` : 'that cell is already painted');
      commit(bakeTiles, false);
    } else {
      tilePainting = true;
      commit(() => { tileErase ? eraseCell(ccx, ccy) : paintCell(ccx, ccy, state.tileType); }, false, D_DRAG);
    }
    blit();
    return;
  }

  if (state.tool === 'stamp') {
    if (!armedSource()) return setStatus('pick a sprite from the palette first');
    const [px, py] = placedPos(e);
    pushUndo();
    painting = true;
    paintLast = [px, py];
    commit(() => addStamp(px, py, brushSource()), false); // stays armed for repeats
    return;
  }
  if (state.tool === 'aabb') {
    boxAnchor = [snapTo(wx), snapTo(wy)];
    state.dragBox = [boxAnchor[0], boxAnchor[1], boxAnchor[0], boxAnchor[1]];
    blit();
    return;
  }
  if (state.tool === 'object') {
    commit(() => addObject(snapTo(wx), snapTo(wy)));
    return;
  }

  // select tool. Priority: a resize handle of the selected AABB, then
  // whatever's under the pointer (AABB edge > object > stamp), then an
  // empty-space rubber band. On a stamp, shift toggles it in/out of the
  // selection; plain-clicking one already in the selection keeps the group
  // so it drags as one, otherwise the click replaces the selection. On
  // empty space, the drag rubber-bands stamps, boxes AND objects — shift
  // extends the current selection, a plain drag replaces it (same
  // conventions as drawtool's op list/canvas).
  dragged = false;
  dragHandle = null;
  state.lastStep = [0, 0];   // a fresh drag starts a fresh repeat step
  if (state.sel?.kind === 'aabb') {
    const hs = aabbHandles();
    for (let i = 0; i < hs.length; i++) {
      const [hx, hy] = hs[i].get();
      if (Math.abs(wx - hx) * state.zoom <= 6 && Math.abs(wy - hy) * state.zoom <= 6) {
        dragHandle = hs[i];
        return;
      }
    }
  }
  const ai = aabbEdgeAt(wx, wy);
  const oi = ai < 0 ? objectAt(wx, wy) : -1;
  const si = ai < 0 && oi < 0 ? stampAtView(vx, vy) : -1;
  if (si >= 0) {
    if (e.shiftKey) toggleMultiStamp(si);
    else if (!selStampIxs().includes(si)) setSelection([si]);
    // else: clicked an already-selected stamp -> keep the group, drag it as one
    if (selStampIxs().length) dragMove = { last: [wx, wy] };
  } else if (ai >= 0 || oi >= 0) {
    if (ai >= 0) setSelection([], [ai], []);
    else setSelection([], [], [oi]);
    dragMove = { last: [wx, wy] };
  } else {
    marquee = true;
    marqueeBase = e.shiftKey
      ? [selStampIxs().slice(), selAabbIxs().slice(), selObjIxs().slice()] : null;
    if (!e.shiftKey) clearSelection();
    boxAnchor = [wx, wy];
    state.dragBox = [wx, wy, wx, wy];
  }
  emit();
});

/** Alt+drag: leave a copy behind and drag the copies (paste at zero offset,
 * so the duplicate starts exactly on top of the original). */
function pasteFromSelection() {
  copySelection();
  pasteClipboard(0, 0);
}

center.addEventListener('pointermove', e => {
  if (state.runtimeView || playtest.active()) return;
  if (panning) {
    state.cam[0] = Math.round(panStart[2] - (e.clientX - panStart[0]) / state.zoom);
    state.cam[1] = Math.round(panStart[3] - (e.clientY - panStart[1]) / state.zoom);
    emit(D.CANVAS | D.OVERVIEW);
    return;
  }
  const [wx, wy] = worldFromEvent(e);
  setCoords(wx, wy);
  if (state.tool === 'stamp' && armedSource()) {
    const [px, py] = placedPos(e);
    if (painting) return paintStep(e);
    setStatus('placing (drag to lay a run, Esc exits)');
    setGhost([state.arm.k, state.arm.i, px, py, state.arm.fx]);
    return;
  }
  if (state.tool === 'tile') {
    const [ccx, ccy] = cellOf(wx, wy);
    tileLast = [ccx, ccy];
    setTileHover([ccx, ccy]);
    setStatus(`cell ${ccx},${ccy}`);
    if (tileAnchor) {
      const [ax, ay] = tileAnchor;
      const [rx0, ry0] = cellRect(Math.min(ax, ccx), Math.min(ay, ccy));
      const [, , rx1, ry1] = cellRect(Math.max(ax, ccx), Math.max(ay, ccy));
      state.dragBox = [rx0, ry0, rx1 - 1, ry1 - 1];
      blit();
    } else if (tilePainting) {
      commit(() => { tileErase ? eraseCell(ccx, ccy) : paintCell(ccx, ccy, state.tileType); }, false, D_DRAG);
    }
    return;
  }

  if (dragHandle) {
    const [hx, hy] = dragHandle.get();
    if (hx !== wx || hy !== wy) {
      if (!dragged) { pushUndo(); dragged = true; }
      commit(() => dragHandle.set(snapTo(wx), snapTo(wy)), false, D_DRAG);
    }
  } else if (dragMove) {
    const [lx, ly] = dragMove.last;
    if (lx !== wx || ly !== wy) {
      if (!dragged) { pushUndo(); dragged = true; }
      dragMove.last = [wx, wy];
      state.lastStep = [state.lastStep[0] + (wx - lx), state.lastStep[1] + (wy - ly)];
      // a MULTI-selection of stamps drags with each stamp's own parallax
      // honored (see dragOffsetStamps) instead of everything moving in screen
      // lockstep; a single stamp/AABB/object still tracks the cursor exactly
      const ixs = selStampIxs();
      commit(() => {
        if (ixs.length > 1 && !selAabbIxs().length && !selObjIxs().length)
          dragOffsetStamps(wx - lx, wy - ly, ixs);
        else offsetSel(wx - lx, wy - ly);
      }, false, D_DRAG);
    }
  } else if (boxAnchor) {
    const [ax, ay] = boxAnchor;
    const x = marquee ? wx : snapTo(wx), y = marquee ? wy : snapTo(wy);
    state.dragBox = [Math.min(ax, x), Math.min(ay, y), Math.max(ax, x), Math.max(ay, y)];
    blit();
  }
});

center.addEventListener('pointerup', () => {
  if (state.runtimeView || playtest.active()) return;
  if (panning) {
    panning = false;
    center.style.cursor = spaceDown ? 'grab' : '';
    return;
  }
  if (painting) {
    painting = false;
    paintLast = null;
    emit();
    return;
  }
  if (dragHandle) {
    dragHandle = null;
    dragged = false;
    emit();
  } else if (dragMove) {
    dragMove = null;
    dragged = false;
    emit();
  } else if (state.tool === 'tile' && (tilePainting || tileAnchor)) {
    if (tileAnchor) {
      const [ax, ay] = tileAnchor;
      const [lx, ly] = tileLast || tileAnchor;
      const x0 = Math.min(ax, lx), x1 = Math.max(ax, lx);
      const y0 = Math.min(ay, ly), y1 = Math.max(ay, ly);
      commit(() => {
        for (let cy = y0; cy <= y1; cy++)
          for (let cx = x0; cx <= x1; cx++)
            tileErase ? eraseCell(cx, cy) : paintCell(cx, cy, state.tileType);
      }, false);
    }
    tileAnchor = null;
    tilePainting = false;
    state.dragBox = null;
    commit(bakeTiles, false);
  } else if (boxAnchor) {
    const [x0, y0, x1, y1] = state.dragBox;
    boxAnchor = null;
    state.dragBox = null;
    if (marquee) {
      marquee = false;
      const s = stampsInBox(x0, y0, x1 + 1, y1 + 1);
      const a = aabbsInBox(x0, y0, x1 + 1, y1 + 1);
      const o = objectsInBox(x0, y0, x1 + 1, y1 + 1);
      const base = marqueeBase || [[], [], []];
      setSelection(
        [...new Set([...base[0], ...s])],
        [...new Set([...base[1], ...a])],
        [...new Set([...base[2], ...o])]);
      marqueeBase = null;
      setStatus(`${state.multi.length + state.multiA.length + state.multiO.length} selected`);
      emit();
    } else {
      // stored max edge is EXCLUSIVE (see core/world.js), hence the +1
      commit(() => addAabb(x0, y0, x1 + 1, y1 + 1));
    }
  }
});

// Double-click a stamp to open the sdftool, which owns every sprite here —
// the sheet, its models and their views.
center.addEventListener('dblclick', e => {
  if (state.runtimeView || playtest.active()) return;
  const [vx, vy] = viewFromEvent(e);
  if (stampAtView(vx, vy) < 0) return;
  window.open('/sdf');
});

const ARROWS = {
  ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1],
};

window.addEventListener('keydown', e => {
  if (playtest.active()) return;   // playtest.js owns the keyboard while it runs
  const typing = e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA';
  // camera preview: plain Tab only (so Shift+Tab/Ctrl+Tab keep their browser
  // defaults), toggled either way — the only way in or out of the mode
  if (e.key === 'Tab' && !typing && !e.ctrlKey && !e.metaKey && !e.altKey) {
    e.preventDefault();
    toggleRuntimeView();
    return;
  }
  if (state.runtimeView) {
    const dir = ARROWS[e.key];
    if (dir) {
      e.preventDefault();
      state.cam[0] += dir[0] * (e.shiftKey ? 64 : 8);
      state.cam[1] += dir[1] * (e.shiftKey ? 64 : 8);
      blit();
    }
    return;
  }
  // Ctrl+S saves from anywhere, typing included — the one shortcut that has
  // to work while the cursor is in the name box.
  if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
    e.preventDefault();
    saveCurrentStage();
    return;
  }
  if (e.key === 'Escape') {
    if (typing) return e.target.blur();
    boxAnchor = null;
    marquee = false;
    marqueeBase = null;
    dragHandle = dragMove = null;
    tileAnchor = null;
    tilePainting = false;
    painting = false;
    paintLast = null;
    state.dragBox = null;
    clearSelection();
    if (state.tool === 'stamp') state.tool = 'select';
    setGhost(null);
    emit();
    return;
  }
  // EVERY editing shortcut below is behind the typing guard, undo included:
  // Ctrl+Z used to fire while the cursor was in the stage-name box, so
  // undoing a typo destroyed a stage edit instead.
  if (typing) return;
  if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) {
    e.preventDefault();
    e.shiftKey ? redo() : undo();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || e.key === 'Y')) {
    e.preventDefault();
    redo();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key === 'c') {
    e.preventDefault();
    const n = copySelection();
    if (n) setStatus(`copied ${n}`);
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key === 'v') {
    e.preventDefault();
    commit(() => pasteClipboard());
    return;
  }
  if ((e.ctrlKey || e.metaKey) && (e.key === 'd' || e.key === 'D')) {
    e.preventDefault();
    repeatSelection();
    return;
  }
  // Ctrl+1..9 sets a camera bookmark, Alt+1..9 jumps to one. The world is
  // unbounded, so getting back to the bit you were working on is a feature.
  if ((e.ctrlKey || e.metaKey) && /^[1-9]$/.test(e.key)) {
    e.preventDefault();
    setMark(e.key, state.cam[0], state.cam[1], state.zoom);
    setStatus(`bookmark ${e.key} set`);
    return;
  }
  if (e.altKey && /^[1-9]$/.test(e.key)) {
    e.preventDefault();
    const m = markOf(e.key);
    if (!m) return setStatus(`bookmark ${e.key} is empty`);
    state.zoom = m[2];
    rebuildView();
    state.cam[0] = m[0];
    state.cam[1] = m[1];
    emit(D.CANVAS | D.VALUES | D.OVERVIEW);
    return;
  }
  if ((e.key === 'Delete' || e.key === 'Backspace') && state.sel) {
    e.preventDefault();
    commit(deleteSel);
    return;
  }
  // arrows nudge the selection by 1px (Shift = 8), or pan the camera when
  // nothing is selected
  const dir = ARROWS[e.key];
  if (dir) {
    e.preventDefault();
    const k = e.shiftKey ? 8 : 1;
    if (state.sel) {
      state.lastStep = [dir[0] * k, dir[1] * k];
      commit(() => offsetSel(dir[0] * k, dir[1] * k));
    } else {
      state.cam[0] += dir[0] * k * 8;
      state.cam[1] += dir[1] * k * 8;
      emit(D.CANVAS | D.OVERVIEW);
    }
    return;
  }
  // 1..5 switch tools
  const tool = { 1: 'select', 2: 'stamp', 3: 'aabb', 4: 'object', 5: 'tile' }[e.key];
  if (tool) return setTool(tool);
  const plain = !e.ctrlKey && !e.metaKey && !e.altKey;
  if (!plain) return;
  // X flips: the selected stamps if there are any, else the armed one. (F is
  // framing now — the key every other editor gives it.)
  if (e.key === 'x' || e.key === 'X') {
    const ixs = selStampIxs();
    if (ixs.length) commit(() => { for (const i of ixs) state.stamps[i].fx ^= 1; });
    else { state.arm.fx ^= 1; emit(D.VALUES | D.CANVAS); }
    return;
  }
  if (e.key === 'f') {
    if (!frameSelection()) setStatus('nothing selected');
    emit(D.VALUES | D.OVERVIEW);
    return;
  }
  if (e.key === 'F') {
    if (!fitStage()) setStatus('nothing to fit');
    emit(D.VALUES | D.OVERVIEW);
    return;
  }
  if (e.key === 'Home') {
    centerOn(0, 0);
    emit(D.VALUES | D.OVERVIEW);
    return;
  }
  if (e.key === 'b' || e.key === 'B') return boxStamps();
  // draw order is list order now, so raise/lower needs a key of its own
  if (e.key === '[') return orderStamps(-1, e.shiftKey);
  if (e.key === ']') return orderStamps(1, e.shiftKey);
  if (e.key === '?') return toggleShortcuts();
  if (e.key === 'p' || e.key === 'P') {
    const [wx, wy] = lastPointer;
    playtest.start(wx, wy);
    return;
  }
  if (e.key === ' ' && !spaceDown) {
    e.preventDefault();
    spaceDown = true;
    if (!panning) center.style.cursor = 'grab';
  }
});

window.addEventListener('keyup', e => {
  if (e.key === ' ') {
    spaceDown = false;
    if (!panning) center.style.cursor = '';
  }
});

// where P drops the playtest body
let lastPointer = [0, 0];
display.addEventListener('pointermove', e => { lastPointer = worldFromEvent(e); });

// clear a lingering place ghost / tile hover when the pointer leaves the canvas
display.addEventListener('pointerleave', () => {
  if (state.tool === 'stamp') setGhost(null);
  if (state.tool === 'tile') setTileHover(null);
});

// the tile tool's right-click erases instead of opening the browser's menu
center.addEventListener('contextmenu', e => {
  if (state.tool === 'tile') e.preventDefault();
});

// mousewheel zoom, anchored on the world point under the cursor
center.addEventListener('wheel', e => {
  if (state.runtimeView || playtest.active()) return;
  e.preventDefault();
  const steps = [0.1, 0.15, 0.25, 0.35, 0.5, 0.75, 1, 2, 3, 4, 6, 8];
  let i = steps.findIndex(s => Math.abs(s - state.zoom) < 1e-6);
  if (i < 0) i = steps.findIndex(s => s > state.zoom);
  if (i < 0) i = steps.length - 1;
  const z = steps[Math.max(0, Math.min(steps.length - 1, i + (e.deltaY < 0 ? 1 : -1)))];
  if (z === state.zoom) return;
  const [wx, wy] = worldFromEvent(e);   // at the OLD zoom/origin
  state.zoom = z;
  rebuildView();            // the viewport (and its centering origin) covers a different world span now
  const rect = display.getBoundingClientRect();
  state.cam[0] = Math.round(wx - (e.clientX - rect.left) / z + state.origin[0]);
  state.cam[1] = Math.round(wy - (e.clientY - rect.top) / z + state.origin[1]);
  refresh();
  emit(D.VALUES | D.OVERVIEW);
}, { passive: false });
