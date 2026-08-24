// Tool test runner: boots a tools server on TOOLS_PORT (default
// 8788, so it never clashes with a dev server on 8787), runs every
// tests/{sdftool,stagetool}/test-*.mjs sequentially against it, prints a
// summary.
//
//   npm test              run everything
//   npm test -- mirror    run suites whose filename matches "mirror"
//
// Suites need headless Chrome (`google-chrome` on PATH, or set $CHROME).
import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PORT, BASE, ROOT } from './helpers.mjs';

// Some sdftool suites need neither the browser nor the server — the SDF
// runtime has no DOM dependency — but they run here with everything else.
const dirs = ['sdftool', 'stagetool']
  .map(d => fileURLToPath(new URL(`./${d}/`, import.meta.url)));
const filters = process.argv.slice(2);
let suites = dirs.flatMap(dir => {
  let files = [];
  try { files = readdirSync(dir); } catch {}
  return files.filter(f => /^test-.*\.mjs$/.test(f)).sort().map(f => dir + f);
});
if (filters.length) suites = suites.filter(f => filters.some(k => f.includes(k)));
if (!suites.length) {
  console.error('no suites match:', filters.join(' '));
  process.exit(1);
}

const server = spawn('node', [ROOT + 'tools/server.js'], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: 'ignore',
});
let up = false;
for (let i = 0; i < 50 && !up; i++) {
  await new Promise(r => setTimeout(r, 100));
  try { up = (await fetch(`${BASE}/api/models`)).ok; } catch {}
}
if (!up) {
  server.kill();
  console.error(`tools server did not come up on :${PORT}`);
  process.exit(1);
}

// dir-qualified display name (tests/<tool>/<file>)
const label = f => f.split('/').slice(-2).join('/');

const results = [];
for (const f of suites) {
  console.log(`\n=== ${label(f)} ===`);
  const code = await new Promise(res => {
    spawn('node', [f], {
      env: { ...process.env, TOOLS_PORT: String(PORT) },
      stdio: 'inherit',
    }).on('exit', res);
  });
  results.push([f, code]);
}
server.kill();

console.log('\n--- summary ---');
for (const [f, code] of results) console.log(`${code === 0 ? 'PASS' : 'FAIL'} ${label(f)}`);
process.exit(results.some(([, c]) => c !== 0) ? 1 : 0);
