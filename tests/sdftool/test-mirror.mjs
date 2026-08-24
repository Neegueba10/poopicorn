/**
 * sdftool — mirror symmetry: one row, two shapes.
 *
 * The renderer's half of this is in tests/sdftool/test-sdf.mjs, which proves
 * the fold. This is the editing half, and the assertion that carries it is the
 * X CLAMP: a mirrored part folds `x -> |x|`, so a mirrored part at a negative x
 * has no half left to mirror and disappears. The renderer does not pay a second
 * abs to hide that, so the editor must make it unreachable — from the
 * inspector, from a drag, and from ticking the box over a part already there.
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

/** The mirror checkbox, found the way a person finds it: by its label. */
const BOX = `[...document.querySelectorAll('#inspector .num')]
  .find(l => l.firstChild.textContent === 'mirror x').querySelector('input')`;

/** Is the bake button in the inspector? It is the only button there. */
const BAKE_EXISTS = `JSON.stringify([...document.querySelectorAll('#inspector button')]
  .some(b => b.textContent === 'bake mirror'))`;

const OVERLAY_INK = `(()=>{const o = document.getElementById('overlay');
  const c = o.getContext('2d').getImageData(0, 0, o.width, o.height).data;
  let n = 0; for (let i = 3; i < c.length; i += 4) if (c[i]) n++;
  return JSON.stringify(n);})()`;

/** Wait for the progressive preview to finish, then report what it drew. */
async function settled() {
  for (let i = 0; i < 60; i++) {
    await sleep(100);
    if (await p.evaluate('window.sdftool.canvas.view.rb.done()')) break;
  }
  return q('JSON.stringify(window.sdftool.canvas.view.rb.px)');
}

try {
  // `settled` reads the CPU renderer's buffer, so the tool is held on it.
  await bootCPU(p);

  // A capsule off to one side. A part centred on the plane is its own mirror
  // image, so it would pass every check below while proving nothing.
  //
  // EVERY DIMENSION IS WRITTEN HERE, including the radius. Leaving one to the
  // add-part default tied the size of the mirrored copy — and so the pixel
  // margin the check below asserts — to a number that belongs to another
  // feature entirely.
  await p.evaluate(`(()=>{const s=document.getElementById('addpart');
    s.value='2'; s.dispatchEvent(new Event('change'));
    window.sdftool.set(1, 1, 0.5);
    window.sdftool.set(1, 8, 0.35);
    window.sdftool.set(1, 10, 0.2);
    window.sdftool.emit();})()`);
  const before = await settled();
  const plainInk = await q(OVERLAY_INK);

  // --- the flag ---------------------------------------------------------------
  check('the inspector offers mirror x',
    await q(`JSON.stringify(!!(${BOX}))`));
  await p.evaluate(`${BOX}.click()`);
  await sleep(200);
  check('ticking it sets bit 128 and keeps the primitive',
    await q('JSON.stringify(window.sdftool.get(1, 0) === 130)'));
  check('the part list marks it',
    await q(`JSON.stringify([...document.querySelectorAll('#parts .op-row')]
      .some(r => r.textContent.includes('⇔')))`));

  // The mirror plane is drawn while a mirrored part is selected, because the
  // plane is the thing you are placing against and it is otherwise invisible.
  const mirrorInk = await q(OVERLAY_INK);
  check(`the mirror plane draws (${plainInk} -> ${mirrorInk} px of overlay)`,
    mirrorInk > plainInk + 50);

  const after = await settled();
  check(`the copy renders (${before} -> ${after} px)`, after > before * 1.2);

  // --- the x clamp ------------------------------------------------------------
  // Every writer goes through `set`, which is where the clamp lives, so this
  // covers the inspector, the plane drag and both gizmo handles at once.
  await p.evaluate('window.sdftool.set(1, 1, -0.5); window.sdftool.emit()');
  await sleep(150);
  check('a mirrored part cannot be pushed to a negative x',
    await q('JSON.stringify(window.sdftool.get(1, 1) === 0)'));

  // Turning the flag ON over a part already on the far side has to clamp too,
  // or the part vanishes the moment the box is ticked.
  await p.evaluate(`${BOX}.click()`);
  await sleep(150);
  check('unticking clears the bit', await q('JSON.stringify(window.sdftool.get(1, 0) === 2)'));
  await p.evaluate('window.sdftool.set(1, 1, -0.5); window.sdftool.emit()');
  await sleep(150);
  check('and an unmirrored part may sit anywhere',
    await q('JSON.stringify(window.sdftool.get(1, 1) === -0.5)'));
  await p.evaluate(`${BOX}.click()`);
  await sleep(200);
  check('ticking it over a part on the far side pulls it back to the plane',
    await q('JSON.stringify(window.sdftool.get(1, 1) === 0)'));

  // --- undo -------------------------------------------------------------------
  await p.evaluate(`document.getElementById('undo').click()`);
  await sleep(250);
  check('undo takes the flag back',
    await q('JSON.stringify(!(window.sdftool.get(1, 0) & 128))'));

  // --- bake mirror ------------------------------------------------------------
  // The maths is proved in tests/sdftool/test-bakemirror.mjs, against `map()`
  // itself. What is checked here is that the button is reachable, offered only
  // where it means something, and that the warning shows on a part the fold is
  // clipping.
  check('no bake button while the part is not mirrored', !(await q(BAKE_EXISTS)));
  await p.evaluate(`window.sdftool.set(1, 1, 0.5); window.sdftool.emit()`);
  await p.evaluate(`${BOX}.click()`);
  await sleep(250);
  check('the button appears with the flag', await q(BAKE_EXISTS));
  check('and a part clear of the plane draws no warning',
    !(await q(`JSON.stringify(!!document.querySelector('#inspector .warn'))`)));

  await p.evaluate(`document.querySelector('#inspector button').click()`);
  await sleep(400);
  const baked = await q(`JSON.stringify({
    n: window.sdftool.count(), sel: window.sdftool.state.sel,
    a: window.sdftool.get(1, 0), b: window.sdftool.get(2, 0),
    ax: window.sdftool.get(1, 1), bx: window.sdftool.get(2, 1) })`);
  check('baking adds a row and selects it', baked.n === 3 && baked.sel === 2);
  check('neither row is mirrored any more', !(baked.a & 128) && !(baked.b & 128));
  check('and the copy sits on the far side', baked.ax === 0.5 && baked.bx === -0.5);
  check('the bake button is gone with the flag', !(await q(BAKE_EXISTS)));

  await p.evaluate(`document.getElementById('undo').click()`);
  await sleep(250);
  check('undo takes the whole bake back',
    await q('JSON.stringify(window.sdftool.count() === 2)'));

  // A part reaching over the plane warns, because the fold is clipping it and
  // two real rows are not clipped.
  await p.evaluate(`window.sdftool.state.sel = 1;
    window.sdftool.set(1, 1, 0.02); window.sdftool.set(1, 8, 0.4);
    window.sdftool.emit()`);
  await sleep(300);
  check('a part straddling the plane warns before you bake it',
    await q(`JSON.stringify(!!document.querySelector('#inspector .warn'))`));
} finally {
  await p.close();
}

console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);
