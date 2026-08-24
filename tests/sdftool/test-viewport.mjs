// The editing viewport (tools/sdftool/viewport.js): how big the picture is
// drawn and which part of it you are looking at, in both tabs.
//
// The thing this suite really protects is the separation. The model tab has a
// CAMERA — yaw, pitch, scale, vx/vy — that is saved with the model, and a
// VIEWPORT that is not saved at all. They both zoom and both pan, so every
// check here that asserts "the document did not change" is load-bearing.
import { launch } from '../cdp.mjs';
import { BASE, sleep } from '../helpers.mjs';

let pass = 0, fail = 0;
const check = (name, ok) => { ok ? pass++ : fail++; console.log(`${ok ? 'ok ' : 'FAIL'} ${name}`); };

const p = await launch(BASE + '/sdf');
const q = async expr => JSON.parse(await p.evaluate(expr));
const key = k => p.evaluate(
  `document.body.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(k)}, bubbles: true })), 'ok'`);
const keyUp = k => p.evaluate(
  `document.body.dispatchEvent(new KeyboardEvent('keyup', { key: ${JSON.stringify(k)}, bubbles: true })), 'ok'`);

// Everything about the model picture's placement, read from the DOM rather
// than from the module — the point is what is on screen.
const shot = () => q(`(()=>{
  const st = document.getElementById('stage'), d = document.getElementById('display');
  const o = document.getElementById('overlay');
  const r = d.getBoundingClientRect(), sr = st.getBoundingClientRect();
  const v = window.sdftool.canvas.viewport.state;
  return JSON.stringify({
    hw: st.clientWidth, hh: st.clientHeight,
    dw: Math.round(r.width), dh: Math.round(r.height),
    // clientLeft/Top: the host has a 1px border, and an absolutely positioned
    // child sits at the PADDING box, not the border box.
    dx: Math.round(r.left - sr.left - st.clientLeft),
    dy: Math.round(r.top - sr.top - st.clientTop),
    vx: v.x, vy: v.y,
    ow: o.width, oh: o.height,
    size: window.sdftool.canvas.view.size, z: v.z, fitting: v.fitting,
  });})()`);

try {
  for (let i = 0; i < 60; i++) {
    await sleep(100);
    if (await p.evaluate(`!!(window.sdftool && window.sdftool.ready)`)) break;
  }

  // --- fit ------------------------------------------------------------------
  const a = await shot();
  const wantZ = Math.max(1, Math.min(Math.floor(a.hw / a.size), Math.floor(a.hh / a.size)));
  check(`fit is the largest WHOLE scale that fits (${a.z}x for ${a.size} in ${a.hw}x${a.hh})`,
    a.z === wantZ && a.fitting);
  check('the picture is drawn at exactly that many screen pixels per render pixel',
    a.dw === a.size * a.z && a.dh === a.size * a.z);
  check('and it is inside the pane', a.dw <= a.hw && a.dh <= a.hh);
  check('the overlay covers the pane, not the picture', a.ow === a.hw && a.oh === a.hh);

  // The want, in one check: the picture fills the
  // available area WHATEVER resolution is selected, rather than sitting in a
  // fixed 480px box that means 3x at 160 and 2x at 240.
  for (const size of ['96', '240', '160']) {
    await p.evaluate(`{ const s = document.getElementById('size');
      s.value = '${size}'; s.dispatchEvent(new Event('change')); 'ok' }`);
    await sleep(200);
    const s = await shot();
    const want = Math.max(1, Math.min(Math.floor(s.hw / s.size), Math.floor(s.hh / s.size)));
    // "Fills the pane" means exactly this: it fits, and one step more would
    // not. The non-limiting axis can be far short of the pane and that is not
    // a defect — square pixels are worth more than the empty margin.
    check(`preview ${size} refits to ${s.z}x and one step more would overflow`,
      s.size === +size && s.z === want && s.dw === +size * s.z
      && s.dw <= s.hw && s.dh <= s.hh
      && (s.size * (s.z + 1) > s.hw || s.size * (s.z + 1) > s.hh));
  }

  // --- pan ------------------------------------------------------------------
  // Zoomed well past the pane, so there is somewhere to pan TO on both axes.
  await p.evaluate(`window.sdftool.canvas.viewport.setScale(8), 'ok'`);
  await sleep(150);
  const doc0 = await q(`JSON.stringify([window.sdftool.state.view, window.sdftool.state.parts])`);
  const panned0 = await shot();
  const st = await q(`(()=>{const r = document.getElementById('stage').getBoundingClientRect();
    return JSON.stringify([r.left, r.top, r.width, r.height]);})()`);
  const mid = [st[0] + st[2] / 2, st[1] + st[3] / 2];

  await key(' ');
  await p.drag(mid[0], mid[1], mid[0] - 40, mid[1] - 30);
  await sleep(150);
  await keyUp(' ');
  const panned1 = await shot();
  check(`space-drag pans the picture (${panned0.dx},${panned0.dy} -> ${panned1.dx},${panned1.dy})`,
    panned1.dx === panned0.dx - 40 && panned1.dy === panned0.dy - 30);
  check('and does not orbit, select or move anything',
    JSON.stringify(await q(`JSON.stringify([window.sdftool.state.view, window.sdftool.state.parts])`))
    === JSON.stringify(doc0));

  await p.drag(mid[0], mid[1], mid[0] - 60, mid[1] - 20, { button: 'middle', buttons: 4 });
  await sleep(150);
  const panned2 = await shot();
  check('middle-drag pans it too',
    panned2.dx === panned1.dx - 60 && panned2.dy === panned1.dy - 20);

  // --- wheel zoom, anchored -------------------------------------------------
  // Anchoring is only meaningful where the picture OVERFLOWS the pane: on an
  // axis it fits on, the viewport centres it, and centring is the stronger
  // rule (a picture that fits should sit in the middle, not wherever the last
  // wheel left it). So this runs from the zoomed-and-panned state above.
  const before = await shot();
  const srcAt = (v, clientX, clientY) => q(`(()=>{
    const st = document.getElementById('stage');
    const sr = st.getBoundingClientRect();
    return JSON.stringify([(${clientX} - sr.left - st.clientLeft - ${v.vx}) / ${v.z},
      (${clientY} - sr.top - st.clientTop - ${v.vy}) / ${v.z}]);})()`);
  const srcBefore = await srcAt(before, mid[0], mid[1]);
  await p.evaluate(`document.getElementById('stage').dispatchEvent(
    new WheelEvent('wheel', { deltaY: -100, clientX: ${mid[0]}, clientY: ${mid[1]}, bubbles: true, cancelable: true })), 'ok'`);
  await sleep(150);
  const after = await shot();
  check(`the wheel zooms one whole step (${before.z}x -> ${after.z}x)`,
    after.z === before.z + 1 && !after.fitting);
  const srcAfter = await srcAt(after, mid[0], mid[1]);
  // Measured in SCREEN pixels, because that is where "it did not move" is
  // decided: a fifth of a screen pixel is a layout rect read a frame apart,
  // not the anchor slipping.
  check('and keeps the render pixel under the cursor where it was'
    + ` (${srcBefore.map(v => v.toFixed(2))} -> ${srcAfter.map(v => v.toFixed(2))})`,
    Math.abs(srcAfter[0] - srcBefore[0]) * after.z < 0.5
    && Math.abs(srcAfter[1] - srcBefore[1]) * after.z < 0.5);
  await p.evaluate(`document.getElementById('stage').dispatchEvent(
    new WheelEvent('wheel', { deltaY: 100, clientX: ${mid[0]}, clientY: ${mid[1]}, bubbles: true, cancelable: true })), 'ok'`);
  await sleep(150);
  check('wheeling back down returns the scale', (await shot()).z === before.z);

  // The picture can be pushed to an edge but never off: a pan that ran past
  // the end would otherwise bank slack it has to eat again coming back.
  await p.drag(mid[0], mid[1], mid[0] + 5000, mid[1] + 5000, { button: 'middle', buttons: 4 });
  await sleep(150);
  const edge = await shot();
  check(`pan is clamped to the picture's own edges (${edge.dx},${edge.dy})`,
    edge.dx === 0 && edge.dy === 0);

  // --- f fits ---------------------------------------------------------------
  await key('f');
  await sleep(200);
  const fitted = await shot();
  check(`f fits the picture again (8x -> ${fitted.z}x, centred)`,
    fitted.fitting && fitted.z === wantZ
    && fitted.dx === Math.round((fitted.hw - fitted.dw) / 2));

  // --- the sheet tab has its own ---------------------------------------------
  await p.evaluate(`window.sdftool.setMode('sheet'), 'ok'`);
  await sleep(400);
  const sh = await q(`(()=>{
    const st = document.getElementById('sheetstage'), d = document.getElementById('sheetdisplay');
    const r = d.getBoundingClientRect(), sr = st.getBoundingClientRect();
    return JSON.stringify({ hw: st.clientWidth, hh: st.clientHeight,
      sw: d.width, sh: d.height, dw: Math.round(r.width), dh: Math.round(r.height),
      dx: Math.round(r.left - sr.left),
      z: window.sdftool.sheetui.viewport.state.z });})()`);
  check(`the sheet picture fits its own pane (${sh.sw}x${sh.sh} at ${sh.z}x)`,
    sh.z === Math.max(1, Math.min(Math.floor(sh.hw / sh.sw), Math.floor(sh.hh / sh.sh)))
    && sh.dw === sh.sw * sh.z && sh.dh === sh.sh * sh.z);
  check('and it is a separate viewport from the model tab\'s',
    await q(`JSON.stringify(window.sdftool.sheetui.viewport !== window.sdftool.canvas.viewport)`));

  await p.evaluate(`window.sdftool.sheetui.viewport.setScale(3), 'ok'`);
  await sleep(150);
  await p.evaluate(`window.sdftool.setMode('model'), 'ok'`);
  await sleep(300);
  check('zooming the sheet left the model tab alone',
    (await shot()).z === wantZ);

  console.log('console:', p.consoleMsgs.length ? p.consoleMsgs : '(clean)');
  if (p.consoleMsgs.length) fail++;
} finally {
  await p.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
