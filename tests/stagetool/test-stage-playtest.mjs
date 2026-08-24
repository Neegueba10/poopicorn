// The stagetool's playtest probe. It runs against `hitStage` — the same
// collision call the game makes — so a gap that clears here clears there.
// That is the whole claim, and these are the three ways it could be false:
// the body could sink into a floor, tunnel through one at speed, or leave
// the editor's camera somewhere else than it found it.
//
// No sheet fixture: the probe reads collision boxes only, and a stage needs
// no art to be walkable.
import { launch } from '../cdp.mjs';
import { BASE, sleep } from '../helpers.mjs';

let pass = 0, fail = 0;
const check = (name, ok) => { ok ? pass++ : fail++; console.log(`${ok ? 'ok ' : 'FAIL'} ${name}`); };

const b = await launch(BASE + '/stage');
try {
  for (let i = 0; i < 60; i++) {
    if (await b.evaluate(`typeof stagetool !== 'undefined' && stagetool.ready`).catch(() => false)) break;
    await sleep(200);
  }
  const st = async expr => JSON.parse(await b.evaluate(`JSON.stringify(${expr})`));
  // The probe steps on requestAnimationFrame, and headless Chrome does not
  // promise 60 of those a second — poll for the resting state instead of
  // sleeping a guessed number of frames.
  const settle = async (pred, ms = 12000) => {
    for (let t = 0; t < ms; t += 100) {
      const body = await st('stagetool.playtest.bodyOf()');
      if (body && pred(body)) return body;
      await sleep(100);
    }
    return await st('stagetool.playtest.bodyOf()');
  };

  // a floor 8 px thick at y = 200, and a second one far below to catch a
  // tunnelling body
  const floors = () => b.evaluate(`{
    Object.assign(stagetool.state, {
      stamps: [], objects: [], sel: null, multi: [], multiA: [], multiO: [],
      cam: [0, 0], zoom: 1,
      aabbs: [
        { type: 0, x0: -200, y0: 200, x1: 600, y1: 208 },
        { type: 1, x0: -200, y0: 400, x1: 600, y1: 408 },
      ],
    });
    stagetool.emit();
    'ok'
  }`);

  // --- lands on the box, not in it -----------------------------------------
  await floors();
  await sleep(150);
  await b.evaluate(`{ stagetool.playtest.play.h = 24; stagetool.playtest.start(100, 100); 'ok' }`);
  const body = await settle(p => p.ground);
  check('the body falls and stands on the box\'s top edge, not inside it',
    body && body.y + 24 === 200 && body.ground === true);
  check('the fall stopped the vertical speed', body && body.vy === 0);

  // --- a fast fall does not tunnel -----------------------------------------
  await b.evaluate(`{ stagetool.playtest.stop(); 'ok' }`);
  await sleep(150);
  await floors();
  await b.evaluate(`{
    Object.assign(stagetool.playtest.play, { grav: 3, maxFall: 60 });
    stagetool.playtest.start(100, -400);
    'ok'
  }`);
  const fast = await settle(p => p.ground);
  check('a 60 px-per-frame fall still stops on the first floor',
    fast && fast.y + 24 === 200);
  await b.evaluate(`{
    Object.assign(stagetool.playtest.play, { grav: 0.5, maxFall: 8 });
    'ok'
  }`);

  // --- the collision TYPE is honoured --------------------------------------
  await b.evaluate(`{ stagetool.playtest.stop(); 'ok' }`);
  await sleep(150);
  await floors();
  await b.evaluate(`{
    stagetool.playtest.play.type = 1;         // only the lower floor is solid now
    stagetool.playtest.start(100, 100);
    'ok'
  }`);
  const typed = await settle(p => p.ground);
  check('the body falls through a box of another type and lands on its own',
    typed && typed.y + 24 === 400);
  await b.evaluate(`{ stagetool.playtest.play.type = 0; 'ok' }`);

  // --- exit restores the camera --------------------------------------------
  await b.evaluate(`{ stagetool.playtest.stop(); 'ok' }`);
  await sleep(150);
  await floors();
  await b.evaluate(`{ stagetool.state.cam = [777, 333]; 'ok' }`);
  await b.evaluate(`{ stagetool.playtest.start(100, 100); 'ok' }`);
  await settle(p => p.y > 80);
  const moved = await st('stagetool.state.cam');
  check('the camera follows the body while playing',
    moved[0] !== 777 || moved[1] !== 333);
  await b.evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })), 'ok'`);
  await sleep(250);
  check('Escape ends the playtest', await st('stagetool.playtest.active()') === false);
  check('and puts the camera back exactly where it was',
    JSON.stringify(await st('stagetool.state.cam')) === '[777,333]');

  // --- the editor is inert while playing -----------------------------------
  await b.evaluate(`{ stagetool.playtest.start(100, 100); 'ok' }`);
  await sleep(200);
  const n0 = await st('stagetool.state.aabbs.length');
  await b.evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete' })), 'ok'`);
  await sleep(200);
  check('editor keys do nothing while the playtest owns the keyboard',
    await st('stagetool.state.aabbs.length') === n0);
  await b.evaluate(`{ stagetool.playtest.stop(); 'ok' }`);

  console.log('console:', b.consoleMsgs.length ? b.consoleMsgs : '(clean)');
  if (b.consoleMsgs.length) fail++;
} finally {
  await b.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
