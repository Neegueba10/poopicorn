/**
 * sdftool — the shared number field: scrub it, or type in it.
 *
 * REAL POINTER AND KEYBOARD INPUT, and it has to be. The bug this suite guards
 * was `preventDefault()` on every press, which stops the browser focusing the
 * field — a dispatched `change` event would have passed against the broken
 * code, because it never went through a focus at all.
 *
 * The rule under test is in tools/sdftool/numfield.js: an unfocused field is a
 * scrubber, a press on it that never moves focuses it and selects what is
 * there, and a focused field is an ordinary text box. All three panels share
 * the one field, so the sheet tab is checked too.
 */
import { launch } from '../cdp.mjs';
import { BASE, sleep } from '../helpers.mjs';
import { bootCPU, waitFor } from './boot.mjs';

let fail = 0;
const check = (name, ok) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`);
  if (!ok) fail++;
};

const p = await launch(`${BASE}/sdf`);
const q = async expr => JSON.parse(await p.evaluate(expr));

/** Where a labelled field is on screen, found the way a person finds it. */
const rowAt = async (pane, label) => q(`(() => {
  const l = [...document.querySelectorAll('#${pane} .num')]
    .find(e => e.firstChild.textContent === ${JSON.stringify(label)});
  const r = l.querySelector('input').getBoundingClientRect();
  return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
})()`);

const valueOf = (pane, label) => q(`(() => {
  const l = [...document.querySelectorAll('#${pane} .num')]
    .find(e => e.firstChild.textContent === ${JSON.stringify(label)});
  return JSON.stringify(l.querySelector('input').value);
})()`);

const focusedLabel = () => q(`JSON.stringify(
  document.activeElement.closest('.num')?.firstChild.textContent ?? null)`);

const radius = () => q('JSON.stringify(window.sdftool.get(0, 10))');

try {
  await bootCPU(p);

  // --- a click focuses the field ---------------------------------------------
  let at = await rowAt('inspector', 'radius');
  await p.click(at.x, at.y);
  await sleep(150);
  check('clicking a field focuses it', await focusedLabel() === 'radius');

  // --- and typing replaces the number ----------------------------------------
  // The click selects what is there, so the insert overwrites rather than
  // appending — 0.31, not 0.450.31.
  await p.type('0.31');
  await p.keyPress('Enter');
  await sleep(300);
  check(`typing writes the model (${await radius()})`, await radius() === 0.31);
  check('and Enter leaves the field', await focusedLabel() === null);

  await p.evaluate(`document.getElementById('undo').click()`);
  await sleep(250);
  check('undo takes a typed value back', await radius() === 0.45);

  // --- Escape abandons the edit ----------------------------------------------
  at = await rowAt('inspector', 'radius');
  await p.click(at.x, at.y);
  await p.type('9');
  await p.keyPress('Escape');
  await sleep(300);
  check('Escape leaves the model alone', await radius() === 0.45);
  check('and puts the old number back in the box',
    +(await valueOf('inspector', 'radius')) === 0.45);

  // --- an empty box is not a value -------------------------------------------
  // `+''` is 0, and writing that into a radius deletes the part from view.
  at = await rowAt('inspector', 'radius');
  await p.click(at.x, at.y);
  await p.keyPress('Backspace');
  await p.keyPress('Enter');
  await sleep(300);
  check('an emptied field does not write 0', await radius() === 0.45);

  // --- the scrub still works --------------------------------------------------
  at = await rowAt('inspector', 'radius');
  await p.press(at.x, at.y);
  await p.move(at.x + 30, at.y);
  await p.release(at.x + 30, at.y);
  await sleep(300);
  check(`dragging still scrubs (${await radius()})`, await radius() > 0.45);
  check('and a scrub does not leave the field focused', await focusedLabel() === null);

  // --- a focused field is a text box -----------------------------------------
  // Otherwise the caret could never be placed: every press would re-select the
  // whole value.
  at = await rowAt('inspector', 'x');
  await p.click(at.x, at.y);
  await sleep(150);
  const beforeX = await q('JSON.stringify(window.sdftool.get(0, 1))');
  await p.press(at.x, at.y);
  await p.move(at.x + 40, at.y);
  await p.release(at.x + 40, at.y);
  await sleep(250);
  check('a drag inside a focused field does not scrub it',
    await q('JSON.stringify(window.sdftool.get(0, 1))') === beforeX);
  check('and it keeps the focus', await focusedLabel() === 'x');

  // --- the sheet tab shares the field ----------------------------------------
  await p.evaluate(`(async () => {
    window.sdftool.setMode('sheet');
    await window.sdftool.sheet.loadSheet('props');
    window.sdftool.sheetui.render();
  })()`);
  await waitFor(p, 'window.sdftool.sheetui.done()', 30000);
  at = await rowAt('sinspector', 'yaw');
  await p.click(at.x, at.y);
  await sleep(150);
  check('a sheet field focuses too', await focusedLabel() === 'yaw');
  await p.type('0.25');
  await p.keyPress('Enter');
  await sleep(400);
  check('and typing writes the sprite\'s own dial',
    await q('JSON.stringify(window.sdftool.sheet.sheet.slots[0].view.yaw)') === 0.25);
} finally {
  await p.close();
}

console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);
