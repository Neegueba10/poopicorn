// src/js/core/stage.js — the stage runtime: baking sheets into offscreen
// canvases, view-culled layer-windowed drawImage stamps, parallax offsets,
// horizontal flip, box collision and the object walk.
//
// Stage data is built inline here from a one-sphere model rather than loaded
// from src/js/stages/ — the runtime's contract is the array shape; the tool's
// codegen is pinned separately by test-stage-basics.mjs.
import { launch } from '../cdp.mjs';
import { BASE, sleep } from '../helpers.mjs';

let pass = 0, fail = 0;
const check = (name, ok) => { ok ? pass++ : fail++; console.log(`${ok ? 'ok ' : 'FAIL'} ${name}`); };

const b = await launch(BASE + '/draw');
try {
  await sleep(1500); // page load — import() needs a real document base URL

  const out = JSON.parse(await b.evaluate(`
    (async () => {
      const S = await import('/src/js/core/stage.js');
      const { genPalette } = await import('/src/js/core/palette.js');
      const pal = genPalette();

      // One sphere, one material, filling its frame — the cheapest thing that
      // still produces ink, so the suite is about the runtime and not the
      // renderer.
      const ball = [[0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.9, 0, 0], [[0.9, 0.3, 0.3]], { scale: 2 }];
      const sheet = [[ball, {}, 8, 8], [ball, {}, 6, 10], 0];

      // one layer per band, in draw order — the rate lives on the layer and
      // the draw order IS this list's order
      const layers = [
        [1, 0, 0, 10, 10, 0],            // L0: id 0 at (10,10), rate 1
        [1, 0, 0, 5000, 5000, 0],        // L1: way off screen
        [0.5, 0, 1, 60, 12, 0],          // L2: id 1 at (60,12), rate .5
        [1,
          0, 2, 30, 40, 0,               // L3: TOMBSTONED id
          0, 9, 40, 40, 0],              //     and an id past the end
        [1, 0, 1, 90, 40, 1],            // L4: id 1 at (90,40), FLIPPED
      ];
      const aabbs = [0, 0, 100, 50, 120,  5, 60, 60, 80, 80];
      const objects = [12, 34, 0, 1, 0, 1, 'pickup', 7,  90, 90, -2, 0, 0, 0];
      const stage = [[sheet], layers, aabbs, objects];

      const art = S.stageBaker(stage, pal, 64);
      const r0 = [...art.srcs[0].rects];      // BEFORE any marching
      const p0 = art.progress();
      let guard = 0;
      while (!art.done() && guard++ < 500) art.step(50);

      const c = document.createElement('canvas');
      c.width = 160; c.height = 90;
      const ctx = c.getContext('2d');
      const shot = fn => {
        ctx.clearRect(0, 0, 160, 90);
        fn();
        return ctx.getImageData(0, 0, 160, 90).data;
      };
      const at = (px, x, y) => {
        const i = (y * 160 + x) * 4;
        return [px[i], px[i + 1], px[i + 2], px[i + 3]];
      };
      const ink = px => { let n = 0; for (let i = 3; i < px.length; i += 4) if (px[i]) n++; return n; };
      // Bounding box of every opaque pixel, or null.
      const box = px => {
        let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
        for (let y = 0; y < 90; y++) for (let x = 0; x < 160; x++) {
          if (!px[(y * 160 + x) * 4 + 3]) continue;
          if (x < x0) x0 = x; if (x > x1) x1 = x;
          if (y < y0) y0 = y; if (y > y1) y1 = y;
        }
        return x1 < 0 ? null : [x0, y0, x1, y1];
      };

      const all = shot(() => S.drawStage(ctx, stage, art.srcs, 0, 0, 160, 90));
      const under = shot(() => S.drawStage(ctx, stage, art.srcs, 0, 0, 160, 90, 0, 3));
      const over = shot(() => S.drawStage(ctx, stage, art.srcs, 0, 0, 160, 90, 3, 9));
      const one = shot(() => S.drawStage(ctx, stage, art.srcs, 0, 0, 160, 90, 0, 1));
      const offscreen = shot(() => S.drawStage(ctx, stage, art.srcs, 0, 0, 160, 90, 1, 2));
      // the rate-.5 layer alone, at two cameras
      const far0 = shot(() => S.drawStage(ctx, stage, art.srcs, 0, 0, 160, 90, 2, 3));
      const far20 = shot(() => S.drawStage(ctx, stage, art.srcs, 20, 0, 160, 90, 2, 3));

      // Just the flipped sprite, and the same sprite unflipped in its place.
      const flipL = [[1, 0, 1, 90, 40, 1]];
      const plainL = [[1, 0, 1, 90, 40, 0]];
      const flipped = shot(() => S.drawStage(ctx, [[sheet], flipL, []], art.srcs, 0, 0, 160, 90));
      const plain = shot(() => S.drawStage(ctx, [[sheet], plainL, []], art.srcs, 0, 0, 160, 90));
      let mirrorOk = true;
      for (let y = 40; y < 50; y++) for (let x = 0; x < 6; x++) {
        const a = at(flipped, 90 + x, y), q = at(plain, 90 + 5 - x, y);
        if (a.join() !== q.join()) mirrorOk = false;
      }

      const objs = [];
      S.eachObject(stage, (i, x, y, k, id, fx) => objs.push([i, x, y, k, id, fx]));

      return JSON.stringify({
        rectsBeforeBake: r0,
        p0, p1: art.progress(), done: art.done(),
        sheetH: art.srcs[0].canvas.height,
        boxAll: box(all), boxOne: box(one), boxFar0: box(far0), boxFar20: box(far20),
        inkAll: ink(all), inkUnder: ink(under), inkOver: ink(over),
        inkOffscreen: ink(offscreen),
        inkPastEnd: ink(shot(() => S.drawStage(ctx, stage, art.srcs, 0, 0, 160, 90, 9, 20))),
        // layer 3 is the tombstone and the out-of-range id; layer 1 is off screen
        opaqueAt40_40: at(all, 40, 40)[3], opaqueAt30_40: at(all, 30, 40)[3],
        mirrorOk,
        hitGround: S.hitStage(stage, 10, 95, 20, 105, 0),
        hitMiss: S.hitStage(stage, 200, 200, 210, 210, 0),
        hitTyped: S.hitStage(stage, 65, 65, 70, 70, 5),
        hitWrongType: S.hitStage(stage, 65, 65, 70, 70, 0),
        objs,
        kv: S.kvOf(stage, 0, 'pickup'), kvMissing: S.kvOf(stage, 0, 'nope'),
      });
    })()
  `));

  // --- the bake -------------------------------------------------------------
  // shelf-packed tallest first, so the 6x10 sprite claims x 0 and the 8x8 sits
  // beside it — the packing is the baker's, and it happens in its constructor
  check('rect table exists before a single ray is marched',
    out.rectsBeforeBake.slice(0, 8).join() === '6,0,8,8,0,0,6,10');
  check('a tombstoned sprite gets a zero rect',
    out.rectsBeforeBake.slice(8, 12).join() === '0,0,0,0');
  check('the sheet canvas is only as tall as the shelves need', out.sheetH === 10);
  check('progress starts at 0 and ends at 1', out.p0 === 0 && out.p1 === 1 && out.done);

  // --- drawing --------------------------------------------------------------
  // id 0 (8x8) at (10,10), id 1 (6x10) at (60,12) rate .5, and id 1 at (90,40)
  // flipped — nothing drawn may fall outside the union of those three rects
  check('every stamp lands inside its own rect',
    out.boxAll && out.boxAll[0] >= 10 && out.boxAll[1] >= 10
    && out.boxAll[2] <= 95 && out.boxAll[3] <= 49);
  check('a stamp 5000 px away is culled, not drawn', out.inkOffscreen === 0);
  check('a layer at rate .5 moves half as far as the camera',
    out.boxFar0 && out.boxFar20 && out.boxFar0[0] - out.boxFar20[0] === 10
    && out.boxFar0[1] === out.boxFar20[1]);
  check('a tombstoned id draws nothing', out.opaqueAt30_40 === 0);
  check('an id past the end of the sheet draws nothing', out.opaqueAt40_40 === 0);

  // --- the layer window -----------------------------------------------------
  check('a layer split covers every stamp exactly once',
    out.inkUnder + out.inkOver === out.inkAll && out.inkUnder > 0 && out.inkOver > 0);
  check('a one-layer window draws only that layer',
    out.boxOne && out.boxOne.join() === '10,10,17,17');
  check('a layer window past the end is not an error', out.inkPastEnd === 0);
  check('flipping mirrors the sprite in place', out.mirrorOk);

  // --- collision and objects ------------------------------------------------
  check('hitStage finds the box under the feet', out.hitGround === 0);
  check('hitStage misses where there is no box', out.hitMiss === -1);
  check('hitStage matches on type', out.hitTyped === 5 && out.hitWrongType === -1);
  check('eachObject walks the variable stride',
    JSON.stringify(out.objs) === JSON.stringify([[0, 12, 34, 0, 1, 0], [8, 90, 90, -2, 0, 0]]));
  check('kvOf reads a tagged value', out.kv === 7 && out.kvMissing === undefined);

  console.log('\nconsole messages:', b.consoleMsgs.length ? b.consoleMsgs : '(clean)');
  if (b.consoleMsgs.length) fail++;
} finally {
  await b.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
