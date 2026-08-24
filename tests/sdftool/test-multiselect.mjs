/**
 * sdftool — selecting several parts and moving them as one.
 *
 * The load-bearing property is RIGIDITY: a group move and a group turn must not
 * change the arrangement of the parts inside the selection. Every check below
 * that measures a distance is measuring that, because the failure mode of a
 * group transform is not "nothing happened" — it is parts drifting apart a
 * thousandth at a time under the hand, which looks fine for one drag.
 *
 * The maths is the anim tab's `rig.js`, already proved by tests/sdftool/
 * test-rig.mjs. What is under test here is that a multiple selection reaches
 * it: the pivot is the centroid, the drag is absolute, and the world axes are
 * used rather than the anchor's own frame.
 *
 * REAL CDP INPUT, and the handles are found through `debugHandles()` — the same
 * reason test-widgets.mjs gives: a dispatched event fires wherever its
 * coordinates say, so a widget drawn out of reach would pass.
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

/**
 * Three spheres: a pair either side of the origin, and one above.
 *
 * THE PAIR IS DELIBERATELY OFF EVERY AXIS. On the x axis they would sit ON the
 * x rotation ring's axis, so an x turn about the centroid would leave both
 * positions exactly where they were — a correct result that reads as a dead
 * gizmo, and the ring a press resolves to is whichever is nearest under the
 * pointer.
 */
const MODEL = `(() => {
  window.sdftool.state.parts = [
    0, -0.3, 0.1,  0,    0, 0, 0, 0, 0, 0, 0.15, 0, 0,
    0,  0.3, -0.05, 0.12, 0, 0, 0, 0, 0, 0, 0.15, 0, 0,
    0,  0, 0.4, 0, 0, 0, 0, 0, 0, 0, 0.1,  0, 0,
  ];
  window.sdftool.selectOnly(0);
  window.sdftool.emit();
})()`;

const parts = () => q('JSON.stringify(window.sdftool.state.parts)');
const sel = () => q('JSON.stringify(window.sdftool.selection())');
const handles = () => q('JSON.stringify(window.sdftool.canvas.debugHandles())');
const rowClick = (i, opts = {}) => p.evaluate(
  `document.querySelectorAll('#parts .op-row')[${i}].querySelector('span:nth-child(2)')
    .dispatchEvent(new MouseEvent('click', { bubbles: true, ${
  opts.shift ? 'shiftKey: true' : ''} }))`).then(() => sleep(250));
const setMode = key => p.evaluate(`document.body.dispatchEvent(
  new KeyboardEvent('keydown', { key: '${key}', bubbles: true }))`).then(() => sleep(150));

async function realDrag(x, y, dx, dy) {
  await p.press(x, y);
  await p.move(x + dx / 2, y + dy / 2);
  await p.move(x + dx, y + dy);
  await p.release(x + dx, y + dy);
  await sleep(350);
}

/** Distance between the centres of parts a and b. */
const gap = (m, a, b) => Math.hypot(m[a * 13 + 1] - m[b * 13 + 1],
  m[a * 13 + 2] - m[b * 13 + 2], m[a * 13 + 3] - m[b * 13 + 3]);

try {
  await bootCPU(p);
  await p.evaluate(MODEL);
  await sleep(400);

  // --- shift-click builds a selection -----------------------------------------
  await rowClick(1, { shift: true });
  check('shift-clicking a row adds it', JSON.stringify(await sel()) === '[0,1]');
  check('both rows read as selected',
    await q(`JSON.stringify(document.querySelectorAll('#parts .op-row.selected').length)`) === 2);
  check('and the anchor is marked apart from the member',
    await q(`JSON.stringify(document.querySelectorAll('#parts .op-row.anchor').length)`) === 1);
  check('the inspector says how many are selected',
    (await q(`JSON.stringify(document.getElementById('inspector').textContent)`))
      .includes('2 parts selected'));

  // --- move -------------------------------------------------------------------
  await setMode('w');
  let before = await parts();
  let hs = await handles();
  const free = hs.find(h => h.type === 'free');
  await realDrag(free.x, free.y, 60, 0);
  let after = await parts();
  const d0 = after[1] - before[1], d1 = after[14] - before[14];
  check(`a group move carries both parts (${d0.toFixed(3)}, ${d1.toFixed(3)})`,
    Math.abs(d0) > 0.05 && Math.abs(d0 - d1) < 1e-6);
  check('and leaves the part outside the selection alone',
    after[27] === before[27] && after[28] === before[28]);
  check('the arrangement inside the selection is unchanged',
    Math.abs(gap(after, 0, 1) - gap(before, 0, 1)) < 1e-6);

  await p.evaluate(`document.getElementById('undo').click()`);
  await sleep(300);
  check('undo takes the whole group move back',
    (await parts())[1] === -0.3 && (await parts())[14] === 0.3);
  // An undo that renumbered nothing must leave the selection alone, or taking
  // a group drag back and trying it again would be impossible.
  check('and keeps the selection', JSON.stringify(await sel()) === '[0,1]');

  // --- rotate -----------------------------------------------------------------
  // The pivot is the CENTROID, so a turn must swing the pair about the point
  // between them and not about either part.
  await setMode('e');
  before = await parts();
  hs = await handles();
  const ring = hs.filter(h => h.type === 'rotate').pop();
  await realDrag(ring.x, ring.y, 30, 30);
  after = await parts();
  check('a group turn moves both parts',
    [1, 2, 3, 14, 15, 16].some(k => Math.abs(after[k] - before[k]) > 1e-3));
  check('rigidly — the pair keeps its spacing',
    Math.abs(gap(after, 0, 1) - gap(before, 0, 1)) < 2e-3);
  check('and it turns each part as well as carrying it',
    after[4] !== 0 || after[5] !== 0 || after[6] !== 0);
  check('the centroid stays put',
    Math.abs((after[1] + after[14]) / 2 - (before[1] + before[14]) / 2) < 2e-3
    && Math.abs((after[2] + after[15]) / 2 - (before[2] + before[15]) / 2) < 2e-3);

  await p.evaluate(`document.getElementById('undo').click()`);
  await sleep(300);

  // --- scale ------------------------------------------------------------------
  // Uniform, and it has to reach the dimensions as well as the spacing — a
  // group that spreads out without growing is not a scale.
  await setMode('r');
  before = await parts();
  hs = await handles();
  const arm = hs.find(h => h.type === 'scale' && h.axis === 0);
  await realDrag(arm.x, arm.y, 50, 0);
  after = await parts();
  const fGap = gap(after, 0, 1) / gap(before, 0, 1);
  const fRad = after[10] / before[10];
  check(`a group scale spreads the parts (×${fGap.toFixed(3)})`, fGap > 1.05);
  check(`and grows them by the same factor (×${fRad.toFixed(3)})`,
    Math.abs(fGap - fRad) < 0.02);
  // Part 2's radius, at row 2 * 13 + 10.
  check('the unselected part is not scaled', after[36] === before[36]);

  await p.evaluate(`document.getElementById('undo').click()`);
  await sleep(300);

  // --- ctrl-click in the viewport ---------------------------------------------
  // Shift already means "orbit" over the picture, so the add gesture there is
  // ctrl. Selecting from the viewport is how a part with no list row in view
  // joins a group.
  await p.evaluate(MODEL);
  await sleep(400);
  const at = await q(`(() => {
    const c = document.getElementById('display').getBoundingClientRect();
    const s = window.sdftool.canvas;
    const [x, y] = s.project(0.3, -0.05, 0.12);
    const n = window.sdftool.canvas.view.size;
    return JSON.stringify({ x: c.left + (x + 0.5) * c.width / n,
      y: c.top + (y + 0.5) * c.height / n });
  })()`);
  await p.click(at.x, at.y, { modifiers: 2 });          // 2 = Ctrl
  await sleep(300);
  check('ctrl-clicking a part in the viewport adds it',
    JSON.stringify(await sel()) === '[0,1]');
  await p.click(at.x, at.y, { modifiers: 2 });
  await sleep(300);
  check('and ctrl-clicking it again takes it out',
    JSON.stringify(await sel()) === '[0]');

  // --- ending the selection ----------------------------------------------------
  await rowClick(1, { shift: true });
  await p.evaluate(`document.body.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await sleep(250);
  check('Escape goes back to one part', JSON.stringify(await sel()) === '[0]');

  // A row index only means anything against the list it came from, so anything
  // that renumbers rows has to drop the extra selection rather than carry a
  // stale index into the new list.
  await rowClick(1, { shift: true });
  await p.evaluate(`(()=>{const s=document.getElementById('addpart');
    s.value='1'; s.dispatchEvent(new Event('change'));})()`);
  await sleep(350);
  check('adding a part ends the multiple selection',
    JSON.stringify(await sel()) === '[3]');

  // --- delete takes all of them -----------------------------------------------
  await p.evaluate(MODEL);
  await sleep(300);
  await rowClick(1, { shift: true });
  await p.evaluate(`document.body.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }))`);
  await sleep(350);
  check('Delete removes every selected part',
    await q('JSON.stringify(window.sdftool.count())') === 1);
  check('and the survivor is the one that was not selected',
    (await parts())[10] === 0.1);

  // --- a scatter stays out of it ----------------------------------------------
  // Its header's columns 1..6 are a seed, a count and spreads, so a group move
  // would write a translation into the number that says how many pebbles.
  await p.evaluate(MODEL);
  await sleep(300);
  await p.evaluate(`document.getElementById('addscatter').click()`);
  await sleep(350);
  const n = await q('JSON.stringify(window.sdftool.count())');
  await p.evaluate(`window.sdftool.selectOnly(0); window.sdftool.emit()`);
  await sleep(200);
  await rowClick(n - 2, { shift: true });               // the scatter header
  check('a scatter header refuses to join a selection',
    JSON.stringify(await sel()) === '[0]');
} finally {
  await p.close();
}

console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);
