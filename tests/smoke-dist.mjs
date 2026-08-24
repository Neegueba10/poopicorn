// Load the minified dist build in headless Chrome and verify the active
// game boots and runs a few frames without exceptions. Run `npm run build`
// first — this exercises the terser/roadroller output, not the dev bundle.
import { existsSync } from 'node:fs';
import { launch } from './cdp.mjs';
import { ROOT, artifact, sleep } from './helpers.mjs';

const dist = ROOT + 'dist/index.html';
if (!existsSync(dist)) {
  console.error('dist/index.html missing — run `npm run build` first');
  process.exit(1);
}

const b = await launch('file://' + dist);
try {
  await sleep(2500);
  // click to get past any start gate, then let it render a few frames
  await b.click(300, 200);
  await sleep(1500);
  const errs = b.consoleMsgs.filter(m => m.startsWith('EXCEPTION'));
  console.log('console messages:', b.consoleMsgs.length ? b.consoleMsgs : '(clean)');
  await b.screenshot(artifact('dist.png'));
  console.log(errs.length ? 'FAIL: exceptions' : 'ok: no exceptions');
  process.exitCode = errs.length ? 1 : 0;
} finally {
  b.close();
}
