// The stagetool's collision tile tool: greedy meshing, freehand and
// rect-fill painting, erase, bake-on-stroke-end, undo, and the "absorb boxes"
// round trip. The grid is EDITOR-ONLY — it never reaches the saved file — so
// what this suite really pins is that a painted grid becomes the same
// ordinary stride-5 AABBs a hand-drawn box would.
//
// The code under test is a copy of the worldtool's (tools/stagetool/tiles.js,
// and bakeTiles/absorbBoxes in its state.js). It is tested again here because
// it is a SEPARATE copy: an edit to one tool's version must not be assumed to
// hold for the other's. meshCells runs in the page rather than in Node,
// because this tool's state module reaches the browser's palette generator.
import { readFileSync, unlinkSync } from 'node:fs';
import { launch } from '../cdp.mjs';
import { BASE, ROOT, sleep } from '../helpers.mjs';

const STAGES = ROOT + 'src/js/stages/';

let pass = 0, fail = 0;
const check = (name, ok) => { ok ? pass++ : fail++; console.log(`${ok ? 'ok ' : 'FAIL'} ${name}`); };

const b = await launch(BASE + '/stage');
try {
  for (let i = 0; i < 60; i++) {
    if (await b.evaluate(`typeof stagetool !== 'undefined' && stagetool.ready`).catch(() => false)) break;
    await sleep(200);
  }

  const clickId = id => b.evaluate(`document.getElementById('${id}').click(), 'ok'`);
  const key = (k, opts = '') => b.evaluate(
    `window.dispatchEvent(new KeyboardEvent('keydown', { key: '${k}'${opts} })), 'ok'`);
  const st = async expr => JSON.parse(await b.evaluate(`JSON.stringify(${expr})`));
  const reset = () => b.evaluate(`{
    Object.assign(stagetool.state, {
      sheets: [], layers: [{ rate: 1 }], stamps: [], aabbs: [], objects: [],
      sel: null, multi: [], multiA: [], multiO: [],
      tiles: new Map(), tile: 8, tileOrigin: [0, 0], tileType: 0,
    });
    stagetool.emit();
    'ok'
  }`);

  // =======================================================================
  // Section A — meshCells, the pure function under it all
  // =======================================================================
  await reset();
  const mesh = cells => st(`stagetool.tiles.meshCells(new Map(${JSON.stringify(cells)}))`);
  {
    const boxes = await mesh([['0,0', 0], ['1,0', 0], ['2,0', 0]]);
    check('three cells in a row bake to one box',
      boxes.length === 1 && JSON.stringify(boxes[0]) === '{"type":0,"x0":0,"y0":0,"x1":24,"y1":8}');
  }
  {
    const boxes = await mesh([['0,0', 0], ['1,0', 0], ['0,1', 0]]);
    const area = boxes.reduce((a, q) => a + (q.x1 - q.x0) * (q.y1 - q.y0), 0);
    check('an L shape bakes to two boxes covering exactly the painted area',
      boxes.length === 2 && area === 3 * 8 * 8);
  }
  {
    const boxes = await mesh([['0,0', 0], ['1,0', 1]]);
    check('two types touching bake to two boxes, never merged',
      boxes.length === 2 && boxes[0].type !== boxes[1].type);
  }

  // canvas-click -> world-coordinate geometry, same preamble as the other
  // suites: cam is [0,0] and zoom is 1 throughout.
  const [gx, gy, gz, vox, voy] = await st(`(() => {
    const r = document.getElementById('display').getBoundingClientRect();
    return [r.left, r.top, stagetool.state.zoom, ...stagetool.state.origin];
  })()`);
  check('geometry sanity: zoom is 1 (test assumes a 1:1 world<->display map)', gz === 1);
  const at = (wx, wy) => [gx + (wx + vox + .5) * gz, gy + (wy + voy + .5) * gz];
  const cellAt = (cx, cy) => at(cx * 8 + 4, cy * 8 + 4); // tile 8, origin [0,0]

  // =======================================================================
  // Section B — freehand paint bakes on release; erase splits and empties
  // =======================================================================
  await reset();
  await clickId('tool-tile');
  await b.press(...cellAt(0, 0));
  await b.move(...cellAt(1, 0));
  await b.move(...cellAt(2, 0));
  await b.release(...cellAt(2, 0));
  await sleep(150);
  check('a freehand stroke across three cells paints all three',
    await st('stagetool.state.tiles.size') === 3);
  check('bake-on-release meshes the row into one box',
    JSON.stringify(await st('stagetool.state.aabbs.filter(a => a.t)'))
    === '[{"type":0,"x0":0,"y0":0,"x1":24,"y1":8,"t":1}]');

  await b.click(...cellAt(1, 0), { modifiers: 2 }); // Ctrl+click erases
  await sleep(150);
  check('erasing the middle cell splits the row into two boxes',
    await st('stagetool.state.aabbs.filter(a => a.t).length') === 2
    && await st('stagetool.state.tiles.size') === 2);
  await b.click(...cellAt(0, 0), { button: 'right' }); // right-click also erases
  await b.click(...cellAt(2, 0), { button: 'right' });
  await sleep(150);
  check('erasing every cell empties the box list',
    await st('stagetool.state.tiles.size') === 0
    && await st('stagetool.state.aabbs.filter(a => a.t).length') === 0);

  // =======================================================================
  // Section C — a hand-drawn AABB survives a bake untouched
  // =======================================================================
  await reset();
  await clickId('tool-aabb');
  await b.drag(...at(50, 50), ...at(59, 59));
  await sleep(150);
  const handDrawn = await st('stagetool.state.aabbs[0]');
  check('the hand-drawn box has no bake marker', !handDrawn.t);
  await clickId('tool-tile');
  await b.click(...cellAt(0, 0));
  await sleep(150);
  check('the hand-drawn AABB is untouched by an unrelated bake',
    JSON.stringify(await st('stagetool.state.aabbs.find(a => !a.t)')) === JSON.stringify(handDrawn));

  // =======================================================================
  // Section D — one stroke is one undo step
  // =======================================================================
  await reset();
  await clickId('tool-tile');
  await b.press(...cellAt(0, 0), { modifiers: 8 });     // shift: rectangle fill
  await b.move(...cellAt(2, 1), { modifiers: 8 });
  await b.release(...cellAt(2, 1), { modifiers: 8 });
  await sleep(150);
  check('a shift-drag rect-fill paints every cell in the rectangle (3x2)',
    await st('stagetool.state.tiles.size') === 6);
  check('the rect-fill bakes to one box',
    await st('stagetool.state.aabbs.filter(a => a.t).length') === 1);
  await key('z', ', ctrlKey: true');
  await sleep(150);
  check('undo restores the grid and the box list to empty',
    await st('stagetool.state.tiles.size') === 0 && await st('stagetool.state.aabbs.length') === 0);

  // =======================================================================
  // Section E — absorb: aligned boxes become cells, others stay; a second
  // bake is byte-identical to the first
  // =======================================================================
  await reset();
  await clickId('tool-aabb');
  await b.drag(...at(0, 0), ...at(15, 7));        // grid-aligned: 0,0 - 16,8
  await sleep(150);
  await b.drag(...at(100, 100), ...at(104, 102)); // NOT grid-aligned (5x3)
  await sleep(150);
  await clickId('tile-absorb');
  await sleep(150);
  check('the aligned box was absorbed into cells',
    await st('stagetool.state.tiles.size') === 2);
  check('the non-aligned box is untouched (no bake marker, same rect)',
    JSON.stringify(await st('stagetool.state.aabbs.find(a => !a.t)'))
    === '{"type":0,"x0":100,"y0":100,"x1":105,"y1":103}');

  const firstBake = await st('stagetool.state.aabbs');
  await b.evaluate('stagetool.bakeTiles(), "ok"');
  await sleep(100);
  check('a second bake is byte-identical to the first (idempotent)',
    JSON.stringify(await st('stagetool.state.aabbs')) === JSON.stringify(firstBake));

  // =======================================================================
  // Section F — fileText() still matches the server's saveStage with baked
  // boxes present (extends the byte-equality check test-stage-basics pins)
  // =======================================================================
  await b.evaluate(`{ document.getElementById('name').value = '_st_tile'; stagetool.state.name = '_st_tile'; 'ok' }`);
  await clickId('save');
  await sleep(500);
  const text = readFileSync(STAGES + '_st_tile.js', 'utf8');
  check('saved file byte-equals fileText() with baked boxes present',
    text === await st('stagetool.fileText()'));
  check('the saved AABBs include both the hand-drawn and the absorbed-and-baked box',
    text.includes('[0,100,100,105,103,0,0,0,16,8]'));
  check('a stage with no sheets still generates a valid empty source list',
    text.startsWith('const S=[];\n'));

  console.log('console:', b.consoleMsgs.length ? b.consoleMsgs : '(clean)');
  if (b.consoleMsgs.length) fail++;
} finally {
  await b.close();
}

try { unlinkSync(STAGES + '_st_tile.js'); } catch {}

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
