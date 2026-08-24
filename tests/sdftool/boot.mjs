/**
 * Boot the sdftool page for a suite, and hold it on the CPU renderer.
 *
 * THE TOOL PREFERS THE GPU WHEN THERE IS ONE (`view.gpu` in
 * tools/sdftool/canvas.js), and headless Chrome has one: tests/cdp.mjs asks
 * for SwiftShader on purpose, so tests/sdftool/test-gl.mjs has something to
 * compare against. So the back end under test is the GPU unless a suite says
 * otherwise, and a check written against `canvas.view.rb` — the CPU
 * renderer's buffer — then reads a renderer that never ran. `rb.px` is
 * `undefined` rather than 0, which is why this showed as a crash in the eval
 * and not as a bad number.
 *
 * The CPU renderer is the authority: it is what the game bakes with, and the
 * two agree only to within a dither step. So every suite that asserts on
 * pixels asks for it here. `test-gl.mjs` is the one suite whose subject IS the
 * GPU, and it boots itself.
 */
import { sleep } from '../helpers.mjs';

/** Poll `expr` in the page until it is true. Returns false on timeout. */
export async function waitFor(p, expr, ms = 12000) {
  for (let i = 0; i * 100 < ms; i++) {
    await sleep(100);
    if (await p.evaluate(`!!(${expr})`)) return true;
  }
  return false;
}

/**
 * Wait for the tool to boot, force the CPU back end, and wait for the first
 * full frame from it.
 *
 * The wait is a poll rather than a sleep because a cold boot loads the module
 * graph and builds a 32,768-entry colour lookup before the first frame.
 */
export async function bootCPU(p, ms = 12000) {
  if (!await waitFor(p, 'window.sdftool && window.sdftool.ready', ms))
    throw new Error('sdftool did not boot');
  await p.evaluate(`(() => { window.sdftool.canvas.view.gpu = false;
    window.sdftool.canvas.restart(); })()`);
  if (!await waitFor(p, `window.sdftool.canvas.view.rb
    && window.sdftool.canvas.view.rb.done() && window.sdftool.canvas.view.rb.px`, ms))
    throw new Error('the CPU renderer drew nothing');
}
