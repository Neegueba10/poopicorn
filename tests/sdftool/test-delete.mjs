/**
 * sdftool — the Delete key.
 *
 * It removes the SELECTION, which is the same thing the ✕ button removes, so a
 * scatter still goes as a pair. Two guards carry this suite: the key must not
 * fire while a field has focus (Backspace there is an edit), and it must not
 * fire while the part list is off screen — the sheet and anim tabs hide it, and
 * a key that deletes something you cannot see is a key that loses work.
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
const count = () => q('JSON.stringify(window.sdftool.count())');
const add = kind => p.evaluate(`(()=>{const s=document.getElementById('addpart');
  s.value='${kind}'; s.dispatchEvent(new Event('change'));})()`);
const press = async (key, target = 'document.body') => {
  await p.evaluate(`${target}.dispatchEvent(
    new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, bubbles: true }))`);
  await sleep(200);
};

try {
  await bootCPU(p);

  await add(2);
  await sleep(300);
  check('two parts, the new one selected',
    await count() === 2 && await q('JSON.stringify(window.sdftool.state.sel)') === 1);

  // --- it deletes the selection ----------------------------------------------
  await press('Delete');
  check('Delete removes the selected part', await count() === 1);
  check('and the selection lands on what is left',
    await q('JSON.stringify(window.sdftool.state.sel)') === 0);

  await p.evaluate(`document.getElementById('undo').click()`);
  await sleep(250);
  check('undo brings it back', await count() === 2);

  await press('Backspace');
  check('Backspace does the same, for the keyboards with no Delete',
    await count() === 1);

  // --- the last part stays ----------------------------------------------------
  // A model with no parts renders nothing at all, so the key refuses rather
  // than emptying the document — and it must not mark the file dirty doing it.
  // The renderer owns the status line and writes its march stats there every
  // frame, so the refusal's message only survives once the picture has settled.
  // Without this wait the check below raced the last frame of the previous edit.
  await waitFor(p, 'window.sdftool.canvas.view.rb.done()');
  await p.evaluate(`window.sdftool.state.dirty = false`);
  await press('Delete');
  check('the last part cannot be deleted', await count() === 1);
  check('and refusing does not dirty the model',
    await q('JSON.stringify(window.sdftool.state.dirty)') === false);
  check('the status line says why',
    (await q(`JSON.stringify(document.getElementById('status').textContent)`))
      .includes('at least one part'));

  // --- a scatter goes as a pair ----------------------------------------------
  await p.evaluate(`document.getElementById('addscatter').click()`);
  await sleep(300);
  check('a scatter is two rows', await count() === 3);
  await press('Delete');
  check('Delete takes the header and its template together', await count() === 1);

  // --- the guards -------------------------------------------------------------
  await add(1);
  await sleep(300);
  const before = await count();
  await press('Delete', `document.querySelector('#inspector input')`);
  check('a field with focus keeps the key', await count() === before);

  await p.evaluate(`window.sdftool.setMode('sheet')`);
  await sleep(400);
  check('the sheet tab hides the part list',
    await q(`JSON.stringify(!document.getElementById('parts').offsetParent)`));
  await press('Delete');
  check('so Delete does nothing there', await count() === before);

  await p.evaluate(`window.sdftool.setMode('model')`);
  await sleep(400);
  await press('Delete');
  check('and it works again back on the model tab', await count() === before - 1);
} finally {
  await p.close();
}

console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);
