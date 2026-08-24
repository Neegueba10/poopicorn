/**
 * sdftool — the 3D widget, and the view cross in the corner.
 *
 * Headless Chrome, driving real pointer events at the coordinates the tool
 * itself says its handles are at. That indirection is on purpose: a test that
 * called the drag maths directly would pass while the handle sat somewhere
 * nobody could press.
 *
 * The assertion that justifies the whole widget is the PAINT-ONLY one. A paint
 * part has colour and no surface, so the ray picker cannot hit it — it was
 * selectable from the list and then not movable at all. The suite checks both
 * halves of that: the picker still refuses it, and the widget still moves it.
 */
import { launch } from '../cdp.mjs';
import { BASE, sleep } from '../helpers.mjs';
import { bootCPU } from './boot.mjs';

let fail = 0;
const check = (name, ok) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`);
  if (!ok) fail++;
};

const p = await launch(`${BASE}/sdf`);
const q = async expr => JSON.parse(await p.evaluate(expr));

/** Press at (x, y), drag by (dx, dy), release — on the display, which is where
 * the tool listens. */
const DRAG = (x, y, dx, dy, mods = {}) => `(()=>{
  const cv = document.getElementById('display');
  cv.setPointerCapture = () => {};
  const ev = (t, ox, oy) => new PointerEvent(t, Object.assign(
    { clientX: ${x} + ox, clientY: ${y} + oy, button: 0, buttons: 1,
      bubbles: true, pointerId: 1 }, ${JSON.stringify(mods)}));
  cv.dispatchEvent(ev('pointerdown', 0, 0));
  cv.dispatchEvent(ev('pointermove', ${dx}, ${dy}));
  cv.dispatchEvent(ev('pointerup', ${dx}, ${dy}));
  return 'ok';})()`;

const part = i => q(`JSON.stringify(window.sdftool.part(${i}))`);
const setMode = async m => {
  await p.evaluate(`document.getElementById('mode-${m}').click()`);
  await sleep(120);
};
const handles = () => q(`JSON.stringify(window.sdftool.canvas.debugHandles())`);
const find = (hs, type, axis) => hs.find(h => h.type === type && h.axis === axis);

try {
  // The pan check below measures the CPU renderer's buffer, so the tool is
  // held on it.
  await bootCPU(p);

  // --- the overlay ----------------------------------------------------------
  const ov = await q(`(()=>{const o = document.getElementById('overlay');
    const st = document.getElementById('stage');
    const c = o.getContext('2d').getImageData(0, 0, o.width, o.height).data;
    let ink = 0;
    for (let i = 3; i < c.length; i += 4) if (c[i]) ink++;
    return JSON.stringify({ w: o.width, h: o.height,
      hw: st.clientWidth, hh: st.clientHeight, ink,
      events: getComputedStyle(o).pointerEvents });})()`);
  // The overlay is screen-resolution and PANE-sized, not picture-sized: the
  // camera cross belongs in the corner of the window you are working in, so it
  // must not scroll away when the picture is zoomed (tools/sdftool/canvas.js's
  // place()).
  check(`the overlay covers the pane at 1:1 (${ov.w}x${ov.h})`,
    ov.w === ov.hw && ov.h === ov.hh && ov.w > 160);
  check(`the widget draws (${ov.ink} px)`, ov.ink > 200);
  // It must never swallow a pointer: the display owns the gesture, and the
  // handles are hit-tested inside it.
  check('the overlay takes no pointer events', ov.events === 'none');

  // --- move along one axis --------------------------------------------------
  await setMode('move');
  const before = await part(0);
  const hs = await handles();
  check('the move widget offers a free handle and three arms',
    hs.length === 4 && hs.some(h => h.type === 'free'));
  const armX = find(hs, 'move', 0);
  await p.evaluate(DRAG(armX.x, armX.y, 30, 0));
  await sleep(250);
  const moved = await part(0);
  check(`dragging the X arm moves the part on X (${before[1]} -> ${moved[1]})`,
    Math.abs(moved[1] - before[1]) > 0.05);
  // The other two must not drift: an arm that moves all three axes is a
  // projection error that looks fine until you check the numbers.
  check('and leaves Y and Z alone',
    moved[2] === before[2] && moved[3] === before[3]);

  // The round trip. Same rule the part drag has: press, drag back, and the
  // numbers must return exactly, because the camera is orthographic.
  const hs2 = await handles();
  const armX2 = find(hs2, 'move', 0);
  await p.evaluate(DRAG(armX2.x, armX2.y, -30, 0));
  await sleep(250);
  const back = await part(0);
  check('dragging it back restores the number exactly',
    Math.abs(back[1] - before[1]) < 1e-9);

  // --- rotate ---------------------------------------------------------------
  await setMode('rotate');
  const rHs = await handles();
  const ring = find(rHs, 'rotate', 2);
  const rBefore = await part(0);
  await p.evaluate(DRAG(ring.x, ring.y, 0, 40));
  await sleep(250);
  const rAfter = await part(0);
  check(`dragging the Z ring turns the part about Z (${rAfter[6]})`,
    Math.abs(rAfter[6] - rBefore[6]) > 0.01);
  check('and moves nothing else',
    rAfter[1] === rBefore[1] && rAfter[4] === rBefore[4] && rAfter[5] === rBefore[5]);
  await p.evaluate(`(()=>{window.sdftool.set(0, 6, 0); window.sdftool.emit();})()`);
  await sleep(200);

  // --- scale edits the dimension, not a transform ---------------------------
  // A box, so the three axes are three different numbers and a mix-up shows.
  await p.evaluate(`(()=>{
    window.sdftool.state.parts = [1, 0, 0, 0, 0, 0, 0, 0.3, 0.3, 0.3, 0.02, 0, 0];
    window.sdftool.state.sel = 0; window.sdftool.emit();})()`);
  await sleep(300);
  await setMode('scale');
  const sHs = await handles();
  // Three arms and the centre. The box also grows a `round` handle in this
  // mode, which is counted separately below.
  check('the scale widget offers an arm per axis',
    sHs.filter(h => h.type === 'scale' || h.type === 'free').length === 4);
  const armY = find(sHs, 'scale', 1);
  const sBefore = await part(0);
  await p.evaluate(DRAG(armY.x, armY.y, 0, -30));
  await sleep(250);
  const sAfter = await part(0);
  check(`the Y arm changes the box's half height (${sBefore[8]} -> ${sAfter[8]})`,
    sAfter[8] > sBefore[8] + 0.05);
  check('and not its width, depth or position',
    sAfter[7] === sBefore[7] && sAfter[9] === sBefore[9] && sAfter[2] === sBefore[2]);

  // A dimension may not go negative: an inside-out half-extent fills the frame.
  const armY2 = find(await handles(), 'scale', 1);
  await p.evaluate(DRAG(armY2.x, armY2.y, 0, 400));
  await sleep(250);
  const squashed = await part(0);
  check(`scaling past zero stops at zero (${squashed[8]})`, squashed[8] === 0);

  // A sphere has one dimension, so every arm edits the same number.
  await p.evaluate(`(()=>{
    window.sdftool.state.parts = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.3, 0, 0];
    window.sdftool.state.sel = 0; window.sdftool.emit();})()`);
  await sleep(300);
  const sph = find(await handles(), 'scale', 0);
  await p.evaluate(DRAG(sph.x, sph.y, 30, 0));
  await sleep(250);
  const grown = await part(0);
  check(`a sphere's arm edits its radius (${grown[10]})`, grown[10] > 0.35);

  // --- a paint-only part, the reason the widget exists ----------------------
  await p.evaluate(`(()=>{
    window.sdftool.state.parts = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.4, 0, 0,
      64, 0.1, 0.1, 0, 0, 0, 0, 0, 0, 0, 0.2, 0.15, 0];
    window.sdftool.state.sel = 1; window.sdftool.emit();})()`);
  await sleep(400);
  await setMode('move');
  const picked = await q(`JSON.stringify({
    centre: window.sdftool.canvas.pick(80, 80),
    isPaint: window.sdftool.isPaint(1) })`);
  check('the ray picker still refuses a paint part (it has no surface)',
    picked.isPaint && picked.centre === 0);
  const pHs = await handles();
  const free = find(pHs, 'free', -1);
  const pBefore = await part(1);
  await p.evaluate(DRAG(free.x, free.y, 40, 20));
  await sleep(250);
  const pAfter = await part(1);
  check(`the centre handle moves the paint part anyway (${pBefore[1]} -> ${pAfter[1]})`,
    Math.abs(pAfter[1] - pBefore[1]) > 0.05 || Math.abs(pAfter[2] - pBefore[2]) > 0.05);

  // --- the cage, drawn in shape mode ----------------------------------------
  // Its geometry is proved against `map()` in tests/sdftool/test-cage.mjs. What
  // is checked here is that it reaches the overlay, and only where it should.
  // The paint part from above is still selected — it is the case the cage
  // exists for, since it has no surface to look at.
  const ink = () => q(`(()=>{const o = document.getElementById('overlay');
    const d = o.getContext('2d').getImageData(0, 0, o.width, o.height).data;
    let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i]) n++;
    return JSON.stringify(n);})()`);
  const inkMove = await ink();
  await setMode('scale');
  await sleep(250);
  const inkShape = await ink();
  check(`shape mode draws the cage (${inkMove} -> ${inkShape} px of overlay)`,
    inkShape > inkMove + 50);
  await setMode('move');
  await sleep(250);
  check('and move mode does not', (await ink()) < inkShape - 50);

  // --- the round handle -----------------------------------------------------
  // Its placement and its gain are proved against `map()` in
  // tests/sdftool/test-dilate.mjs. What is checked here is the contract that
  // only a real pane can show: the handle is reachable, it writes the column it
  // says it writes, and it STAYS UNDER THE POINTER — a gain applied the wrong
  // way round still moves the number, just not by what your hand did.
  await p.evaluate(`(()=>{
    window.sdftool.state.parts = [1, 0, 0, 0, 0, 0, 0, 0.3, 0.2, 0.25, 0.04, 0, 0];
    window.sdftool.selectOnly(0); window.sdftool.emit();})()`);
  await sleep(350);
  await setMode('scale');
  await sleep(200);
  const dil = find(await handles(), 'dilate', -1);
  check('a box offers a round handle', !!dil);
  // ALONG THE HANDLE'S OWN DIRECTION. A fixed screen delta would be asserting
  // about which way the camera happens to be pointing, and would grow the
  // corner or shrink it depending on how the model was turned.
  const OUT = 26;
  const pull = (h, s) => DRAG(h.x, h.y, h.dir[0] * OUT * s, h.dir[1] * OUT * s);
  const cBefore = await part(0);
  await p.evaluate(pull(dil, 1));
  await sleep(250);
  const cAfter = await part(0);
  check(`dragging it out grows the corner (${cBefore[10]} -> ${cAfter[10]})`,
    cAfter[10] > cBefore[10] + 0.01);
  check('and nothing else about the part',
    [1, 2, 3, 4, 5, 6, 7, 8, 9].every(k => cAfter[k] === cBefore[k]));
  // The handle followed the number, so it has to be where the pointer left it.
  const tracked = find(await handles(), 'dilate', -1);
  const off = Math.hypot(tracked.x - (dil.x + dil.dir[0] * OUT),
    tracked.y - (dil.y + dil.dir[1] * OUT));
  check(`the handle stayed under the pointer (${off.toFixed(1)} px off)`, off < 4);

  await p.evaluate(pull(tracked, -1));
  await sleep(250);
  check(`and dragging back restores it exactly (${(await part(0))[10]})`,
    (await part(0))[10] === cBefore[10]);

  // A corner may not go negative: an inside-out fillet is a shape turned
  // through itself, the same rule the scale arms take.
  const neg = find(await handles(), 'dilate', -1);
  await p.evaluate(DRAG(neg.x, neg.y, neg.dir[0] * -900, neg.dir[1] * -900));
  await sleep(250);
  check(`past zero it stops at zero (${(await part(0))[10]})`, (await part(0))[10] === 0);

  // --- a face handle, pressed for real --------------------------------------
  // The algebra is proved in tests/sdftool/test-faces.mjs. What only a real
  // pane can show is that the handle is reachable and that the drag reaches the
  // TWO numbers a face drag writes — the dimension and the centre.
  await p.evaluate(`(()=>{
    window.sdftool.state.parts = [1, 0, 0, 0, 0, 0, 0, 0.25, 0.18, 0.2, 0, 0, 0];
    window.sdftool.selectOnly(0); window.sdftool.emit();})()`);
  await sleep(350);
  const fx = (await handles()).find(h => h.type === 'face');
  check('a box offers face handles', !!fx);
  const fBefore = await part(0);
  await p.evaluate(DRAG(fx.x, fx.y, fx.dir[0] * 24, fx.dir[1] * 24));
  await sleep(250);
  const fAfter = await part(0);
  check(`dragging a face grows the box (${fBefore[fx.col]} -> ${fAfter[fx.col]})`,
    fAfter[fx.col] > fBefore[fx.col] + 0.01);
  check('and moves the part, which is what keeps the far face still',
    [1, 2, 3].some(k => fAfter[k] !== fBefore[k]));
  // Half each: that split IS the asymmetry.
  const dDim = fAfter[fx.col] - fBefore[fx.col];
  const dPos = Math.hypot(fAfter[1] - fBefore[1], fAfter[2] - fBefore[2],
    fAfter[3] - fBefore[3]);
  check(`the drag is split evenly between them (${dDim.toFixed(3)} / ${dPos.toFixed(3)})`,
    Math.abs(dDim - dPos) < 2e-3);

  // Alt resizes about the centre instead — the arms' behaviour, on a face.
  await p.evaluate(`(()=>{
    window.sdftool.state.parts = [1, 0, 0, 0, 0, 0, 0, 0.25, 0.18, 0.2, 0, 0, 0];
    window.sdftool.selectOnly(0); window.sdftool.emit();})()`);
  await sleep(350);
  const fa = (await handles()).find(h => h.type === 'face');
  await p.evaluate(DRAG(fa.x, fa.y, fa.dir[0] * 24, fa.dir[1] * 24, { altKey: true }));
  await sleep(250);
  const alt = await part(0);
  check('Alt-dragging a face leaves the part where it is',
    alt[1] === 0 && alt[2] === 0 && alt[3] === 0);
  check(`and puts the whole drag into the dimension (${alt[fa.col]})`,
    Math.abs((alt[fa.col] - 0.25) - dDim * 2) < 3e-3);

  // --- a capsule's ends -----------------------------------------------------
  // Its algebra is proved in tests/sdftool/test-ends.mjs. Here: the joint is
  // reachable, and the drag is a PLANE drag — placing an end is not a motion
  // along any one axis, so it must follow the pointer in both directions at
  // once, like the gizmo's centre handle.
  await p.evaluate(`(()=>{
    window.sdftool.state.parts = [2, 0, 0, 0, 0, 0, 0, 0.05, 0.25, 0, 0.09, 0, 0];
    window.sdftool.selectOnly(0); window.sdftool.emit();})()`);
  await sleep(350);
  const eHs = (await handles()).filter(h => h.type === 'end');
  check(`a capsule offers two end handles (${eHs.length})`, eHs.length === 2);
  const eBefore = await part(0);
  await p.evaluate(DRAG(eHs[0].x, eHs[0].y, 35, 25));
  await sleep(250);
  const eAfter = await part(0);
  check('dragging an end moves it in both screen directions',
    [1, 2, 3].filter(k => eAfter[k] !== eBefore[k]).length >= 2);
  check('and writes the axis, not a rotation',
    [7, 8, 9].some(k => eAfter[k] !== eBefore[k])
    && [4, 5, 6].every(k => eAfter[k] === eBefore[k]));
  // The other handle must not have moved on screen: that is the whole point.
  const stayed = (await handles()).filter(h => h.type === 'end')
    .find(h => h.sign === eHs[1].sign);
  check(`the far end stayed put on screen`
    + ` (${Math.hypot(stayed.x - eHs[1].x, stayed.y - eHs[1].y).toFixed(1)} px)`,
    Math.hypot(stayed.x - eHs[1].x, stayed.y - eHs[1].y) < 1);

  // A sphere's radius is already on the arms; a second handle writing the same
  // number would be two controls fighting over one column.
  await p.evaluate(`(()=>{
    window.sdftool.state.parts = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.3, 0, 0,
      64, 0.1, 0.1, 0, 0, 0, 0, 0, 0, 0, 0.2, 0.15, 0];
    window.sdftool.selectOnly(0); window.sdftool.emit();})()`);
  await sleep(350);
  check('a sphere offers none — its arms already write round',
    !find(await handles(), 'dilate', -1));
  await p.evaluate(`window.sdftool.selectOnly(1); window.sdftool.emit()`);
  await sleep(300);

  // A group's scale is uniform and has no one part's box to point at, so the
  // cage stays off — two selected parts must not each grow a cage.
  await setMode('scale');
  await sleep(250);
  const inkOne = await ink();
  await p.evaluate(`window.sdftool.toggleSelect(0); window.sdftool.emit()`);
  await sleep(300);
  check(`no cage while several parts are selected (${inkOne} -> ${await ink()})`,
    (await ink()) < inkOne);
  await p.evaluate(`window.sdftool.selectOnly(1); window.sdftool.emit()`);
  await sleep(250);
  await setMode('move');

  // --- the view widget ------------------------------------------------------
  const vwid = await q(`JSON.stringify(window.sdftool.canvas.debugViewWidget())`);
  const v0 = await q(`JSON.stringify(window.sdftool.state.view)`);
  await p.evaluate(DRAG(vwid.rim.x, vwid.rim.y, 40, 0));
  await sleep(250);
  const v1 = await q(`JSON.stringify(window.sdftool.state.view)`);
  check(`the corner cross orbits the camera (yaw ${v0.yaw} -> ${v1.yaw})`,
    Math.abs(v1.yaw - (v0.yaw + 40 * 0.0025)) < 1e-6);
  check('and does not select or move a part', v1.vx === v0.vx || v1.vx === undefined);

  const centroid = `(()=>{
    const rb = window.sdftool.canvas.view.rb;
    let n = 0, sx = 0;
    for (let y = 0; y < rb.h; y++) for (let x = 0; x < rb.w; x++)
      if (rb.col[y * rb.w + x]) { n++; sx += x; }
    return JSON.stringify({ n, cx: n ? sx / n : 0 });})()`;
  const panBefore = await q(centroid);
  await p.evaluate(DRAG(vwid.pan.x, vwid.pan.y, 30, 0));
  await sleep(250);
  const v2 = await q(`JSON.stringify(window.sdftool.state.view)`);
  check(`its middle pans instead (vx ${v2.vx})`, Math.abs(v2.vx) > 0.01);
  check('and leaves the camera angle alone', v2.yaw === v1.yaw);

  // Panning is a real render parameter, not a tool-only offset: the picture
  // has to move with it, or a fitted sprite would crop somewhere else.
  //
  // And it must move by the RIGHT amount. The pan measures the canvas, so 30
  // client pixels across a 480 display is 10 pixels of a 160 render — the model
  // stays under the pointer, which is the whole contract of a pan.
  const shifted = await q(`(()=>{
    const rb = window.sdftool.canvas.view.rb;
    let n = 0, sx = 0;
    for (let y = 0; y < rb.h; y++) for (let x = 0; x < rb.w; x++)
      if (rb.col[y * rb.w + x]) { n++; sx += x; }
    return JSON.stringify({ n, cx: n ? sx / n : 0,
      z: window.sdftool.canvas.viewport.state.z });})()`);
  const want = 30 / shifted.z;   // 30 client px, at whatever whole scale it fits at
  check(`the render followed the pan by ${want.toFixed(1)} px`
    + ` (centroid x ${panBefore.cx.toFixed(1)} -> ${shifted.cx.toFixed(1)})`,
    shifted.n > 100 && Math.abs(shifted.cx - panBefore.cx - want) < 2);

  // --- the mode keys --------------------------------------------------------
  for (const [key, mode] of [['e', 'rotate'], ['r', 'scale'], ['w', 'move']]) {
    await p.evaluate(`document.body.dispatchEvent(
      new KeyboardEvent('keydown', { key: '${key}', bubbles: true }))`);
    await sleep(120);
    const m = await q(`JSON.stringify({ mode: window.sdftool.canvas.view.mode,
      on: [...document.querySelectorAll('#modes .tab')]
        .findIndex(b => b.classList.contains('on')) })`);
    check(`${key} switches the widget to ${mode}`, m.mode === mode);
  }
} finally {
  await p.close();
}

console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);
