/**
 * sdftool — the two light suns, and the dials behind them.
 *
 * Headless Chrome, pressing where the tool itself says the suns are, the same
 * indirection tests/sdftool/test-gizmo.mjs uses: a suite that called the aiming
 * maths directly would pass while the glyph sat somewhere nobody could press.
 *
 * The two assertions that carry the feature are the UNLINK and the PRUNE. The
 * fill faces the key until it is dragged, so the first drag has to write its
 * three keys and stop it following; and a dial sitting on its default must not
 * reach the file, or every model collects eighteen numbers it does not use.
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

const view = () => q('JSON.stringify(window.sdftool.state.view)');
const suns = () => q('JSON.stringify(window.sdftool.canvas.debugLights())');
const key = () => p.evaluate(`document.body.dispatchEvent(
  new KeyboardEvent('keydown', { key: 'l', bubbles: true }))`);

try {
  // The dial checks below read the CPU renderer's buffer, so the tool is held
  // on it.
  await bootCPU(p);

  // --- hidden by default ------------------------------------------------------
  // A light is aimed once and a part is moved all day, so the suns must not sit
  // over the model waiting to be grabbed by mistake.
  check('the lights start hidden', !(await q('JSON.stringify(window.sdftool.canvas.view.lights)')));
  const hidden = await suns();
  const before = await view();
  await p.evaluate(DRAG(hidden[0].x, hidden[0].y, 40, 0));
  await sleep(250);
  const afterHidden = await view();
  check('a hidden sun cannot be grabbed',
    afterHidden.lx === before.lx && afterHidden.lz === before.lz);

  await key();
  await sleep(150);
  check('l shows them', await q('JSON.stringify(window.sdftool.canvas.view.lights)'));
  const ink = await q(`(()=>{const o = document.getElementById('overlay');
    const c = o.getContext('2d').getImageData(0, 0, o.width, o.height).data;
    let n = 0; for (let i = 3; i < c.length; i += 4) if (c[i]) n++;
    return JSON.stringify(n);})()`);
  check(`and they draw (${ink} px of overlay)`, ink > 200);

  // --- aiming the key ---------------------------------------------------------
  // THE SUN STAYS UNDER THE POINTER. That is the contract every drag in this
  // tool has, and the reason the gesture is an arcball rather than a rate: the
  // camera is orthographic, so the screen-to-sphere mapping is exact.
  const s0 = await suns();
  check('there are two suns', s0.length === 2);
  // Inward, toward the model: the default light sits close to the silhouette,
  // and outside it there is no sphere point to track — the gesture rides the
  // rim there, which is the case the wild drag below covers.
  const inward = (s, k) => {
    const dx = s.cx - s.x, dy = s.cy - s.y, d = Math.hypot(dx, dy) || 1;
    return [dx / d * k, dy / d * k];
  };
  const [dx0, dy0] = inward(s0[0], 60);
  await p.evaluate(DRAG(s0[0].x, s0[0].y, dx0, dy0));
  await sleep(300);
  const landed = await suns();
  check(`the key sun follows the pointer (${(landed[0].x - s0[0].x).toFixed(1)},`
    + ` ${(landed[0].y - s0[0].y).toFixed(1)} for ${dx0.toFixed(0)},${dy0.toFixed(0)})`,
    Math.hypot(landed[0].x - s0[0].x - dx0, landed[0].y - s0[0].y - dy0) < 3);

  const v1 = await view();
  // The direction stays a unit vector, so the dials read as a direction rather
  // than as a length the renderer will normalise away.
  check(`it stays normalised (${Math.hypot(v1.lx, v1.ly, v1.lz).toFixed(3)})`,
    Math.abs(Math.hypot(v1.lx, v1.ly, v1.lz) - 1) < 0.01);

  // Grabbing a sun off centre must keep that offset: an arcball turns the light
  // by the rotation the POINTER made, so nothing snaps under the hand.
  const off = await suns();
  const [dx1, dy1] = inward(off[0], 30);
  await p.evaluate(DRAG(off[0].x + 7, off[0].y, dx1, dy1));
  await sleep(300);
  const kept = await suns();
  check(`an off-centre grab keeps its offset (moved ${(kept[0].x - off[0].x).toFixed(1)},`
    + `${(kept[0].y - off[0].y).toFixed(1)} for ${dx1.toFixed(0)},${dy1.toFixed(0)})`,
    Math.hypot(kept[0].x - off[0].x - dx1, kept[0].y - off[0].y - dy1) < 4);

  // A drag HOLDS its hemisphere — two sphere points project to every pixel, and
  // picking the other root mid-drag reads as the light jumping. So dragging
  // never takes a light round the back...
  const front = await suns();
  check('the key sun is in front', !front[0].behind);
  await p.evaluate(DRAG(front[0].x, front[0].y, 600, 0));
  await sleep(300);
  const wild = await suns();
  check('and no drag turns it round the back', !wild[0].behind);
  // ...and a drag far past the silhouette parks it on the rim rather than
  // sending it somewhere arbitrary.
  check(`a wild drag rides the rim (${(wild[0].x - front[0].x).toFixed(0)} px for a 600 px drag)`,
    wild[0].x > front[0].x && wild[0].x - front[0].x < 600);

  // --- flip is how a rim is made ----------------------------------------------
  const beforeFlip = await suns();
  await p.evaluate(`[...document.querySelectorAll('#viewbox button')]
    .find(b => b.textContent === 'flip front / back').click()`);
  await sleep(300);
  const flipped = await suns();
  check('flip sends the key behind the model', flipped[0].behind);
  // Mirroring through the camera plane is invisible in projection: under an
  // orthographic camera only the depth changes.
  check(`and leaves it where it was on screen `
    + `(${Math.hypot(flipped[0].x - beforeFlip[0].x, flipped[0].y - beforeFlip[0].y).toFixed(1)} px)`,
    Math.hypot(flipped[0].x - beforeFlip[0].x, flipped[0].y - beforeFlip[0].y) < 2);
  // And a light that is behind can be dragged there, still holding its side.
  const [dx2, dy2] = inward(flipped[0], 40);
  await p.evaluate(DRAG(flipped[0].x, flipped[0].y, dx2, dy2));
  await sleep(300);
  const back = await suns();
  check(`a light behind the model drags without coming forward `
    + `(${(back[0].x - flipped[0].x).toFixed(0)},${(back[0].y - flipped[0].y).toFixed(0)}`
    + ` for ${dx2.toFixed(0)},${dy2.toFixed(0)})`,
    back[0].behind && Math.hypot(back[0].x - flipped[0].x - dx2, back[0].y - flipped[0].y - dy2) < 4);

  // --- undo covers the view ---------------------------------------------------
  // It did not, so no dial was undoable. A light is dragged the way a part is
  // dragged, so Ctrl+Z has to take it back the way it takes a part back.
  const beforeUndo = await view();
  await p.evaluate(`document.getElementById('undo').click()`);
  await sleep(250);
  const undone = await view();
  check(`undo takes the last drag back (${beforeUndo.lx} -> ${undone.lx})`,
    undone.lx !== beforeUndo.lx);
  const backSuns = await suns();
  check('and puts the sun where it was before that drag',
    Math.hypot(backSuns[0].x - flipped[0].x, backSuns[0].y - flipped[0].y) < 2);

  // --- the fill follows the key until it is dragged ----------------------------
  await p.evaluate(`(()=>{ const s = window.sdftool.state;
    s.view = { yaw: 0.06, pitch: 0.09, scale: 1.7, spec: 0.35, ao: 1 };
    window.sdftool.emit(); })()`);
  await sleep(300);
  const linked = await view();
  check('a fresh view sets no light dial at all',
    linked.lx === undefined && linked.l2x === undefined && linked.fog === undefined);

  const f0 = await suns();
  // Linked, the fill sits exactly opposite the key: same distance from the
  // model's centre, on the other side of it.
  check('the fill sun faces the key across the model',
    Math.abs(f0[0].x + f0[1].x - 2 * (f0[0].x + f0[1].x) / 2) < 1e-6
    && Math.hypot(f0[0].x - f0[1].x, f0[0].y - f0[1].y) > 20);
  await p.evaluate(DRAG(f0[0].x, f0[0].y, 50, 0));
  await sleep(300);
  const moved = await suns();
  check('moving the key swings the fill with it',
    Math.hypot(moved[1].x - f0[1].x, moved[1].y - f0[1].y) > 4);
  check('and writes no l2 dial while it is linked',
    (await view()).l2x === undefined);

  // Drag the fill: it must write its own three and stop following.
  await p.evaluate(DRAG(moved[1].x, moved[1].y, 40, 20));
  await sleep(300);
  const unlinked = await view();
  check(`dragging the fill writes its direction (${unlinked.l2x}, ${unlinked.l2y}, ${unlinked.l2z})`,
    typeof unlinked.l2x === 'number' && typeof unlinked.l2y === 'number'
    && typeof unlinked.l2z === 'number');
  const fixed = await suns();
  await p.evaluate(DRAG(fixed[0].x, fixed[0].y, 50, 0));
  await sleep(300);
  const after = await suns();
  check('and then the key can be moved without it',
    Math.hypot(after[1].x - fixed[1].x, after[1].y - fixed[1].y) < 1);

  // relink puts it back to facing the key, by DELETING the three keys — a
  // number that happened to face the key would follow nothing.
  await p.evaluate(`[...document.querySelectorAll('#viewbox button')]
    .find(b => b.textContent === 'relink').click()`);
  await sleep(300);
  const relinked = await view();
  check('relink clears the three dials rather than restating them',
    relinked.l2x === undefined && relinked.l2y === undefined && relinked.l2z === undefined);

  // --- lock to camera ----------------------------------------------------------
  // The point of the flag: orbit for the next facing and the suns stay where
  // they are, so the whole set is lit from one side of the screen. Ticking it
  // must not move them either — it converts the aim rather than restating it.
  await p.evaluate(`(()=>{ const s = window.sdftool.state;
    s.view = { yaw: 0.06, pitch: 0.09, scale: 1.7, spec: 0.35, ao: 1 };
    window.sdftool.emit(); })()`);
  await sleep(300);
  const lockBox = `[...document.querySelectorAll('#viewbox label')]
    .find(l => l.textContent.trim().startsWith('lock to camera')).querySelector('input')`;
  const loose = await suns();
  await p.evaluate(`(()=>{ const b = ${lockBox}; b.checked = true;
    b.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await sleep(300);
  const locked = await suns();
  check(`ticking the lock leaves the suns where they are `
    + `(${Math.hypot(locked[0].x - loose[0].x, locked[0].y - loose[0].y).toFixed(1)} px)`,
    Math.hypot(locked[0].x - loose[0].x, locked[0].y - loose[0].y) < 1);
  check('and writes the dial', (await view()).lcam === 1);

  const spin = async yaw => {
    await p.evaluate(`(()=>{ window.sdftool.state.view.yaw = ${yaw};
      window.sdftool.emit(); })()`);
    await sleep(300);
    return suns();
  };
  const held = await spin(0.31);
  check(`orbiting does not move a locked sun `
    + `(${Math.hypot(held[0].x - locked[0].x, held[0].y - locked[0].y).toFixed(1)} px)`,
    Math.hypot(held[0].x - locked[0].x, held[0].y - locked[0].y) < 1.5);

  // Untick at the turned-round yaw: the aim converts back to world, so again
  // nothing moves — and now the next orbit carries the light with the model.
  await p.evaluate(`(()=>{ const b = ${lockBox}; b.checked = false;
    b.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await sleep(300);
  const freed = await suns();
  check(`unticking it leaves them where they are too `
    + `(${Math.hypot(freed[0].x - held[0].x, freed[0].y - held[0].y).toFixed(1)} px)`,
    Math.hypot(freed[0].x - held[0].x, freed[0].y - held[0].y) < 1);
  check('and takes the dial back out of the file',
    (await view()).lcam === undefined);
  const drifted = await spin(0.06);
  check(`and then an orbit moves them again `
    + `(${Math.hypot(drifted[0].x - freed[0].x, drifted[0].y - freed[0].y).toFixed(1)} px)`,
    Math.hypot(drifted[0].x - freed[0].x, drifted[0].y - freed[0].y) > 4);

  // --- the file only carries what is not a default -----------------------------
  await p.evaluate(`(()=>{ const s = window.sdftool.state;
    s.view = { yaw: 0.06, pitch: 0.09, scale: 1.7, spec: 0.35, ao: 1 };
    window.sdftool.emit(); })()`);
  await sleep(250);
  const clean = await p.evaluate('window.sdftool.fileText()');
  check('an untouched model writes no light dials',
    !/\bl2?[xyzrgbiw]\s*:/.test(clean) && !/\bfog/.test(clean));
  await p.evaluate(`(()=>{ window.sdftool.setDial('fog', 0.4);
    window.sdftool.setDial('l2i', 0.3); window.sdftool.emit(); })()`);
  await sleep(200);
  const dirty = await p.evaluate('window.sdftool.fileText()');
  check('a dial that was set is written', /fog: 0\.4/.test(dirty) && /l2i: 0\.3/.test(dirty));
  await p.evaluate(`(()=>{ window.sdftool.setDial('l2i', 0.1); window.sdftool.emit(); })()`);
  await sleep(200);
  const pruned = await p.evaluate('window.sdftool.fileText()');
  check('and scrubbing it back to the default takes it out again',
    !/l2i/.test(pruned) && /fog: 0\.4/.test(pruned));

  // --- the dials reach the picture --------------------------------------------
  const pixels = `(()=>{ const rb = window.sdftool.canvas.view.rb;
    let n = 0, sum = 0;
    for (let i = 0; i < rb.col.length; i++) if (rb.col[i]) {
      n++; sum += rb.pal[rb.col[i] * 3] + rb.pal[rb.col[i] * 3 + 1] + rb.pal[rb.col[i] * 3 + 2];
    }
    return JSON.stringify({ n, mean: n ? sum / n / 3 : 0 });})()`;
  const settle = async () => {
    for (let i = 0; i < 40; i++) {
      await sleep(100);
      if (await p.evaluate('window.sdftool.canvas.view.rb.done()')) break;
    }
  };
  await p.evaluate(`(()=>{ window.sdftool.setDial('fog', 0); window.sdftool.emit(); })()`);
  await settle();
  const dark = await q(pixels);
  await p.evaluate(`(()=>{ ['fogr', 'fogg', 'fogb'].forEach(k => window.sdftool.setDial(k, 1));
    window.sdftool.setDial('fog', 1); window.sdftool.emit(); })()`);
  await settle();
  const hazy = await q(pixels);
  check(`fog in the panel reaches the preview (${dark.mean.toFixed(0)} -> ${hazy.mean.toFixed(0)})`,
    dark.n > 100 && hazy.mean > dark.mean + 20);
} finally {
  await p.close();
}

console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);
