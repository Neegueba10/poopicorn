/**
 * sdftool — a scatter: one header, one template, forty parts.
 *
 * The renderer's half is in tests/sdftool/test-sdf.mjs, which proves the
 * expansion. This is the editing half, and what carries it is that A SCATTER IS
 * ONE THING TO THE HANDS. It is two rows in the file, so reorder, duplicate and
 * delete have to move both — a header left pointing at whatever fell in behind
 * it is a file the server refuses and a model nobody meant.
 *
 * The second load-bearing assertion is the SELECTION: an instance is not a row
 * anyone can edit, so clicking one in the view has to select the template.
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

const ROWS = `[...document.querySelectorAll('#parts .op-row')].map(r => r.textContent)`;
const LABELS = `[...document.querySelectorAll('#inspector .num')]
  .map(l => l.firstChild.textContent)`;

/** Press the nth button of the part row `i`, by its glyph. */
const rowButton = (i, glyph) => `[...document.querySelectorAll('#parts .op-row')[${i}]
  .querySelectorAll('button')].find(b => b.textContent === ${JSON.stringify(glyph)}).click()`;

async function settled() {
  for (let i = 0; i < 80; i++) {
    await sleep(100);
    if (await p.evaluate('window.sdftool.canvas.view.rb.done()')) break;
  }
}

try {
  // `settled` and the march count below read the CPU renderer's buffer, so the
  // tool is held on it.
  await bootCPU(p);

  // --- adding one ------------------------------------------------------------
  // Its own button, not the last line of the primitive menu: a scatter adds two
  // rows and is a different kind of thing. Buried in that menu it went unfound.
  await p.evaluate(`document.getElementById('addscatter').click()`);
  await sleep(300);
  const added = await q(`JSON.stringify({
    n: window.sdftool.count(),
    sel: window.sdftool.state.sel,
    head: window.sdftool.isScatter(1),
    tmpl: window.sdftool.isTemplate(2),
    rows: ${ROWS} })`);
  check('adding a scatter appends two rows and selects the header',
    added.n === 3 && added.sel === 1 && added.head && added.tmpl);
  check(`the list shows the header and indents its template (${added.rows[1]?.trim()})`,
    /scatter ×\d+/.test(added.rows[1]) && added.rows[2].includes('↳'));

  // --- the header's own panel ------------------------------------------------
  // It is not a part. It has no position, no primitive and no dimensions —
  // those are the template's, and the template is edited like any other part.
  const hdr = await q(`JSON.stringify(${LABELS})`);
  check(`the header offers a seed and a count (${hdr.join(', ')})`,
    hdr.includes('seed') && hdr.includes('count') && hdr.includes('spread x')
    && !hdr.includes('subtract'));
  // Labelled from the TEMPLATE's primitive: a spread on a number the shape
  // ignores is a control that does nothing.
  check('and it labels the dimension spread from the template',
    hdr.includes('radius ±') && !hdr.includes('half w ±'));

  // THE SHAPE IS CHOSEN ON THE HEADER, because that is where people look for
  // it. It writes the template's kind, and the spread labels follow — the
  // distribution row is a separate control and must not read as the shape.
  check('the header offers the shape and the distribution as two controls',
    hdr.includes('shape') && hdr.includes('scatter in') && !hdr.includes('ellipsoid'));
  await p.evaluate(`(()=>{const s = [...document.querySelectorAll('#inspector .num')]
    .find(l => l.firstChild.textContent === 'shape').querySelector('select');
    s.value = '1'; s.dispatchEvent(new Event('change'));})()`);
  await sleep(300);
  const boxed = await q(`JSON.stringify({ kind: window.sdftool.kindOf(2),
    labels: ${LABELS},
    row: [...document.querySelectorAll('#parts .op-row')][1].textContent })`);
  check('choosing a shape rewrites the template kind',
    boxed.kind === 1 && boxed.labels.includes('half w ±') && !boxed.labels.includes('radius ±'));
  check(`and the part list names it (${boxed.row.trim().split('▲')[0]})`,
    boxed.row.includes('box'));
  await p.evaluate(`(()=>{const s = [...document.querySelectorAll('#inspector .num')]
    .find(l => l.firstChild.textContent === 'shape').querySelector('select');
    s.value = '0'; s.dispatchEvent(new Event('change'));})()`);
  await sleep(300);

  await p.evaluate('window.sdftool.state.sel = 2; window.sdftool.emit()');
  await sleep(200);
  const tl = await q(`JSON.stringify(${LABELS})`);
  check(`the template gets an ordinary part panel (${tl.slice(0, 3).join(', ')})`,
    tl.includes('kind') && tl.includes('radius') && !tl.includes('seed'));

  // --- what it renders -------------------------------------------------------
  await settled();
  const st = await q(`JSON.stringify({
    text: document.getElementById('status').textContent,
    marched: window.sdftool.canvas.view.rb.m.length / 13 })`);
  check(`the renderer marches the instances, not the rows (${st.marched})`,
    st.marched === 1 + 12);
  // March cost is linear in that second number, so the status line has to say
  // it rather than report three rows and a long wait.
  check(`the status line reports both counts (${st.text.split('·')[0].trim()})`,
    /3 → 13 parts/.test(st.text));

  // --- reroll ----------------------------------------------------------------
  await p.evaluate('window.sdftool.state.sel = 1; window.sdftool.emit()');
  await sleep(200);
  const seed0 = await q('JSON.stringify(window.sdftool.get(1, 1))');
  await p.evaluate(`[...document.querySelectorAll('#inspector button')]
    .find(b => b.textContent === '🎲').click()`);
  await sleep(300);
  const seed1 = await q('JSON.stringify(window.sdftool.get(1, 1))');
  check(`reroll changes the seed and nothing else (${seed0} -> ${seed1})`,
    seed1 !== seed0 && seed1 >= 1
    && await q('JSON.stringify(window.sdftool.get(1, 2))') === -12);

  // --- clicking an instance selects the template -----------------------------
  // An instance is not a row anybody can edit, so the click has to land on the
  // template it was copied from.
  await p.evaluate('window.sdftool.state.sel = 0; window.sdftool.emit()');
  await settled();
  await p.evaluate(`(()=>{
    const cv = document.getElementById('display');
    const r = cv.getBoundingClientRect();
    cv.setPointerCapture = () => {};
    const ev = t => new PointerEvent(t, { clientX: r.left + r.width / 2,
      clientY: r.top + r.height / 2, button: 0, buttons: 1, bubbles: true, pointerId: 1 });
    cv.dispatchEvent(ev('pointerdown'));
    cv.dispatchEvent(ev('pointerup'));})()`);
  await sleep(300);
  const picked = await q('JSON.stringify(window.sdftool.state.sel)');
  check(`clicking the mass selects a real row (${picked})`, picked === 0 || picked === 2);

  // --- the pair moves as a pair ---------------------------------------------
  await p.evaluate('window.sdftool.state.sel = 1; window.sdftool.emit()');
  await sleep(200);
  await p.evaluate(rowButton(1, '▲'));
  await sleep(250);
  const moved = await q(`JSON.stringify({
    head: window.sdftool.isScatter(0), tmpl: window.sdftool.isTemplate(1),
    n: window.sdftool.count(), sel: window.sdftool.state.sel })`);
  check('moving the header carries its template with it',
    moved.head && moved.tmpl && moved.n === 3 && moved.sel === 0);

  await p.evaluate(rowButton(1, '▲'));
  await sleep(250);
  const fromTmpl = await q(`JSON.stringify({
    head: window.sdftool.isScatter(0), tmpl: window.sdftool.isTemplate(1) })`);
  check('and the template cannot be moved out from under it',
    fromTmpl.head && fromTmpl.tmpl);

  // --- duplicate gets its own arrangement ------------------------------------
  await p.evaluate(rowButton(0, '⧉'));
  await sleep(300);
  const dup = await q(`JSON.stringify({
    n: window.sdftool.count(),
    head: window.sdftool.isScatter(2), tmpl: window.sdftool.isTemplate(3),
    seeds: [window.sdftool.get(0, 1), window.sdftool.get(2, 1)] })`);
  check('duplicating copies both rows', dup.n === 5 && dup.head && dup.tmpl);
  check(`and reseeds the copy (${dup.seeds.join(' -> ')})`, dup.seeds[0] !== dup.seeds[1]);

  // --- delete ---------------------------------------------------------------
  await p.evaluate(rowButton(2, '✕'));
  await sleep(300);
  const del = await q(`JSON.stringify({ n: window.sdftool.count(),
    head: window.sdftool.isScatter(0), tmpl: window.sdftool.isTemplate(1) })`);
  check('deleting takes both rows', del.n === 3 && del.head && del.tmpl);
} finally {
  await p.close();
}

console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);
