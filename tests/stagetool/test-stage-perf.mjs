// The stagetool's render budget. This is the one suite that guards a
// NEGATIVE: what the editor must NOT do while you drag something.
//
// `emit()` used to mean "rebuild every panel", and a drag calls it on every
// pointer move. On a 500-stamp stage that was one freshly allocated canvas
// per sprite thumbnail, one DOM row per stamp and a deflate of the whole
// generated file, sixty times a second. Dragging is the main verb of level
// design, so the cost landed exactly where it hurt most.
//
// Each mutation now declares which panels it can have changed (D in
// state.js) and ui.js coalesces the flags into one requestAnimationFrame
// pass. The counts below are what that buys; they regress silently, hence
// this suite.
import { unlinkSync } from 'node:fs';
import { launch } from '../cdp.mjs';
import { BASE, ROOT, sleep } from '../helpers.mjs';

const SHEETS = ROOT + 'src/js/sheets/';
const MODELS = ROOT + 'src/js/models/';
const N = 500;

let pass = 0, fail = 0;
const check = (name, ok, note = '') => {
  ok ? pass++ : fail++;
  console.log(`${ok ? 'ok ' : 'FAIL'} ${name}${note ? ' — ' + note : ''}`);
};

{
  const res = await fetch(BASE + '/api/save-model', {
    method: 'POST',
    body: JSON.stringify({
      name: '_pf_ball',
      parts: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.9, 0, 0],
      mats: [[0.9, 0.3, 0.3]],
      view: { scale: 2 },
    }),
  });
  if (!res.ok) throw new Error('fixture model: ' + await res.text());
}
{
  // twelve sprites, so the palette is a wall of thumbnails worth not rebuilding
  const sprites = [];
  for (let i = 0; i < 12; i++) sprites.push({ model: '_pf_ball', view: {}, w: 8 + i, h: 8 + i });
  const res = await fetch(BASE + '/api/save-sheet', {
    method: 'POST',
    body: JSON.stringify({ name: '_pf_sheet', sprites }),
  });
  if (!res.ok) throw new Error('fixture sheet: ' + await res.text());
}

const b = await launch(BASE + '/stage');
try {
  for (let i = 0; i < 60; i++) {
    if (await b.evaluate(`typeof stagetool !== 'undefined' && stagetool.ready
      && document.getElementById('sheet-select').options.length > 1`).catch(() => false)) break;
    await sleep(200);
  }
  const st = async expr => JSON.parse(await b.evaluate(`JSON.stringify(${expr})`));
  const pick = (sel, v) => b.evaluate(`{
    const s = document.getElementById('${sel}');
    s.value = ${JSON.stringify(v)};
    s.dispatchEvent(new Event('change'));
    'ok'
  }`);

  await pick('sheet-select', '_pf_sheet');
  // twelve raymarched sprites take a moment; the editor never waits on a
  // bake, but this suite wants the thumbnails present to prove they are kept
  for (let i = 0; i < 80; i++) {
    if (await st('stagetool.bake.baking()') === false) break;
    await sleep(200);
  }

  // 500 stamps over five layers
  await b.evaluate(`{
    const stamps = [];
    for (let i = 0; i < ${N}; i++) stamps.push({
      k: 0, i: i % 12, x: (i % 50) * 24, y: Math.floor(i / 50) * 24,
      fx: 0, l: i % 5,
    });
    // one known target, on the LAST layer so it draws over everything and the
    // drag below cannot pick up a neighbour instead
    stamps[250] = { k: 0, i: 0, x: 100, y: 60, fx: 0, l: 4 };
    Object.assign(stagetool.state, {
      layers: [0.25, 0.5, 1, 1, 1.5].map(rate => ({ rate })),
      stamps, aabbs: [], objects: [], sel: null, multi: [], multiA: [],
      multiO: [], tool: 'select', cam: [0, 0], zoom: 1, locked: new Set(),
      hiddenLayers: [], lockedLayers: [], soloLayer: null, l0: 0, l1: 1e9,
    });
    stagetool.emit();
    'ok'
  }`);
  await sleep(600);
  check(`${N} stamps are in the document`, await st('stagetool.state.stamps.length') === N);

  // The windowed list is the other half of the fix: 500 rows to show a
  // dozen was the old cost, whether or not anything was moving.
  const rows = await st(`document.querySelectorAll('#stamp-rows .op-row').length`);
  check('the stamp list renders a window, not every row', rows > 0 && rows < 60,
    `${rows} rows in the DOM for ${N} stamps`);

  // --- instrument -----------------------------------------------------------
  // A MutationObserver counts childList churn in the two panels a drag has no
  // business touching, and a wrapper counts document.createElement calls.
  await b.evaluate(`{
    window._perf = { palette: 0, stampRows: 0, created: 0, frames: 0 };
    window._obs = [];
    for (const [id, key] of [['palette', 'palette'], ['stamp-rows', 'stampRows']]) {
      const o = new MutationObserver(ms => { window._perf[key] += ms.length; });
      o.observe(document.getElementById(id), { childList: true, subtree: true });
      window._obs.push(o);
    }
    const create = document.createElement.bind(document);
    document.createElement = tag => { window._perf.created++; return create(tag); };
    'ok'
  }`);

  // select one stamp, then drag it across the canvas
  await b.evaluate(`{ stagetool.setMultiStamps([250]); stagetool.emit(); 'ok' }`);
  await sleep(300);
  await b.evaluate(`{ window._perf = { palette: 0, stampRows: 0, created: 0, frames: 0 }; 'ok' }`);

  // the target's client point, computed through the tool's own camera maths
  // (a stamp is drawn at ITS LAYER's parallax rate, so a flat offset is wrong)
  const [px, py] = await st(`(() => {
    const s = stagetool.state.stamps[250];
    const r = document.getElementById('display').getBoundingClientRect();
    const [cx, cy] = stagetool.effCam();
    const z = stagetool.state.zoom, rate = stagetool.layerRate(s.l);
    return [r.left + (s.x - cx * rate + 3) * z, r.top + (s.y - cy * rate + 3) * z];
  })()`);
  const s = await st('stagetool.state.stamps[250]');

  // The press itself legitimately rebuilds: a selection changed. What must
  // cost nothing is every move after it, which is where the sixty-a-second
  // rebuilds used to live — so the counters reset once the drag has started.
  await b.press(px, py);
  // let the press's own coalesced frame land before the counters start, or a
  // slow machine bills its rebuild to the moves
  await b.evaluate(`new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))`);
  await sleep(200);
  await b.evaluate(`{ window._perf = { palette: 0, stampRows: 0, created: 0, frames: 0 }; 'ok' }`);
  const MOVES = 20;
  for (let i = 1; i <= MOVES; i++) await b.move(px + i * 4, py);
  const during = await st('window._perf');
  await b.release(px + MOVES * 4, py);
  await sleep(300);

  check('the drag actually moved the stamp',
    await st('stagetool.state.stamps[250].x') === s.x + MOVES * 4);
  check('the moves of a drag never rebuild the sprite palette', during.palette === 0,
    `${during.palette} palette mutations over ${MOVES} moves`);
  check('the moves of a drag never rebuild the stamp list', during.stampRows === 0,
    `${during.stampRows} row mutations over ${MOVES} moves`);
  check('the moves of a drag allocate no DOM at all', during.created === 0,
    `${during.created} createElement calls over ${MOVES} moves`);

  // --- the frame cost of one redraw ---------------------------------------
  // Not a wall-clock budget (a loaded CI box would make that flaky) — a
  // ratio: a picture-only redraw must be a fraction of a full panel rebuild.
  const timing = await st(`(() => {
    const t = (fn, n) => { const t0 = performance.now(); for (let i = 0; i < n; i++) fn(); return (performance.now() - t0) / n; };
    const canvasOnly = t(() => stagetool.canvas.blit(), 20);
    const everything = t(() => stagetool.ui.render(), 10);
    return [canvasOnly, everything];
  })()`);
  check('a picture-only redraw is cheaper than a full rebuild',
    timing[0] < timing[1],
    `blit ${timing[0].toFixed(1)} ms vs render ${timing[1].toFixed(1)} ms`);

  // --- the byte counter is debounced, not per-frame ------------------------
  const bytesCalls = await st(`(() => {
    let n = 0;
    const real = window.CompressionStream;
    window.CompressionStream = function (...a) { n++; return new real(...a); };
    for (let i = 0; i < 30; i++) stagetool.emit(stagetool.D.BYTES);
    window.CompressionStream = real;
    return n;
  })()`);
  check('thirty emits do not run thirty deflates', bytesCalls <= 1,
    `${bytesCalls} deflate(s) queued`);

  await b.evaluate(`{ for (const o of window._obs) o.disconnect(); 'ok' }`);
  console.log('console:', b.consoleMsgs.length ? b.consoleMsgs : '(clean)');
  if (b.consoleMsgs.length) fail++;
} finally {
  await b.close();
}

try { unlinkSync(SHEETS + '_pf_sheet.js'); } catch {}
try { unlinkSync(MODELS + '_pf_ball.js'); } catch {}

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
