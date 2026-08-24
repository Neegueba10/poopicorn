// Minimal CDP driver over Node's built-in WebSocket (headless Chrome).
// No npm dependencies — spawns the system Chrome (override with $CHROME).
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// `opts.window` overrides the default window size ('W,H') -- scripts/
// help-shots.mjs wants a larger one than the suites do, so its screenshots of
// the soundbox UI aren't cramped.
export async function launch(url, opts = {}) {
  const port = 9222 + Math.floor(Math.random() * 500);
  // A fresh profile per launch, NOT one keyed on the port. The port is random
  // out of 500, so a port-keyed profile is reused across runs whenever two
  // draws collide -- and any run that dies before its teardown leaves that
  // profile on disk. Once the soundbox started autosaving songs to
  // localStorage, a colliding profile booted the editor into a previous run's
  // work instead of the demo song, which read as a flaky suite.
  const profile = mkdtempSync(join(tmpdir(), 'drawtool-cdp-'));
  const chrome = spawn(process.env.CHROME || 'google-chrome', [
    '--headless=new', `--remote-debugging-port=${port}`,
    '--no-first-run', '--no-default-browser-check',
    // Headless has no GPU, so WebGL falls to SwiftShader — and recent Chrome
    // refuses to hand out a software context without being told to. Without
    // this the sdftool's GPU back end reports a lost context on every suite,
    // and tests/sdftool/test-gl.mjs has nothing to compare against.
    //
    // NAMING THE BACKEND IS WHAT MAKES IT STABLE. Left to pick for itself,
    // Chrome handed out a context and then lost it on about one launch in six,
    // which read as a flaky suite rather than as a missing flag. Measured over
    // eight launches each: default 7/8, this 8/8.
    //
    // SwiftShader is NOT the renderer any user has, which is why that suite
    // asserts a tolerance rather than a pixel hash.
    '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader',
    '--user-data-dir=' + profile,
    `--window-size=${opts.window || '1400,900'}`, url,
  ], { stdio: 'ignore' });

  let target;
  for (let i = 0; i < 50; i++) {
    await new Promise(r => setTimeout(r, 200));
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      target = list.find(t => t.type === 'page' && t.url.includes(new URL(url).host));
      if (target) break;
    } catch {}
  }
  if (!target) { chrome.kill(); throw new Error('no page target'); }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  let id = 0;
  const pending = new Map();
  const consoleMsgs = [];
  // window.confirm/alert would otherwise pause the renderer waiting for a
  // dialog response that never comes (no real user to click it) — auto-
  // answer every dialog and record its message so tests can assert on it.
  // Tests can flip dialogAccept to false to exercise the Cancel path.
  const dialogs = [];
  let dialogAccept = true;
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    if (m.method === 'Runtime.consoleAPICalled')
      consoleMsgs.push(m.params.args.map(a => a.value ?? a.description).join(' '));
    if (m.method === 'Runtime.exceptionThrown')
      consoleMsgs.push('EXCEPTION: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
    if (m.method === 'Page.javascriptDialogOpening') {
      dialogs.push(m.params.message);
      send('Page.handleJavaScriptDialog', { accept: dialogAccept });
    }
  };
  const send = (method, params = {}) => new Promise(res => {
    const mid = ++id;
    pending.set(mid, res);
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
  await send('Runtime.enable');
  await send('Page.enable');

  async function evaluate(expr) {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.result.exceptionDetails)
      throw new Error('eval failed: ' + JSON.stringify(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text));
    return r.result.result.value;
  }
  // Small gap after each input event so the renderer processes it before the
  // next one (or a state read) — back-to-back dispatches lose races when the
  // machine is loaded, which is how suites end up flaky only in full runs.
  const pace = () => new Promise(r => setTimeout(r, 30));
  async function click(x, y, opts = {}) {
    for (const type of ['mousePressed', 'mouseReleased']) {
      await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, ...opts });
      await pace();
    }
  }
  const press = (x, y, opts = {}) => send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, ...opts }).then(pace);
  const move = (x, y, opts = {}) => send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left', buttons: 1, ...opts }).then(pace);
  const release = (x, y, opts = {}) => send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1, ...opts }).then(pace);
  async function drag(x0, y0, x1, y1, opts = {}) {
    await press(x0, y0, opts); await move(x1, y1, opts); await release(x1, y1, opts);
  }
  // Real keyboard input into whatever has focus. Setting `.value` from an
  // eval skips the focus, the selection and the change event a typed edit
  // goes through, which is exactly what a suite about typing has to exercise.
  const type = text => send('Input.insertText', { text }).then(pace);
  // A named key -- Enter, Escape, Backspace, Tab. `code` and the virtual key
  // code have to agree with `key` or Chrome drops the event.
  const KEYCODES = { Enter: 13, Escape: 27, Backspace: 8, Tab: 9, Delete: 46 };
  async function keyPress(key, opts = {}) {
    const p = { key, code: key, windowsVirtualKeyCode: KEYCODES[key] || 0, ...opts };
    for (const type of ['keyDown', 'keyUp']) {
      await send('Input.dispatchKeyEvent', { type, ...p });
      await pace();
    }
  }
  // `clip` (optional) is CDP's own {x, y, width, height, scale} viewport rect,
  // for capturing one panel instead of the whole page -- see
  // scripts/help-shots.mjs, which reads the rects off getBoundingClientRect().
  async function screenshot(path, clip) {
    const r = await send('Page.captureScreenshot',
      clip ? { format: 'png', clip: { scale: 1, ...clip } } : { format: 'png' });
    const { writeFileSync } = await import('node:fs');
    writeFileSync(path, Buffer.from(r.result.data, 'base64'));
  }
  // Async, and callers must await it: kill() only signals, Chrome writes its
  // profile back out on the way down, and each test runs as its own process
  // (tests/run.mjs) that can exit before an un-awaited background listener
  // ever fires. Wait for the real exit, then wipe.
  async function close() {
    ws.close();
    const exited = new Promise(res => {
      if (chrome.exitCode !== null || chrome.signalCode !== null) return res();
      chrome.once('exit', res);
    });
    chrome.kill();
    await exited;
    // The main process exiting doesn't mean its GPU/renderer/zygote children
    // have released the profile's lock files yet, so an immediate rmSync
    // left a near-complete profile behind more often than not. Retry briefly.
    for (let i = 0; i < 10; i++) {
      try { rmSync(profile, { recursive: true, force: true }); break; }
      catch { await new Promise(r => setTimeout(r, 100)); }
    }
  }
  return {
    evaluate, click, drag, press, move, release, type, keyPress,
    screenshot, consoleMsgs, close, dialogs,
    get dialogAccept() { return dialogAccept; },
    set dialogAccept(v) { dialogAccept = v; },
  };
}
