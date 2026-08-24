/**
 * The number field the whole tool shares: SCRUB IT, OR TYPE IN IT.
 *
 * Drag sideways to change it by `step` per pixel, Shift ×10, Alt ÷10 — the
 * noodletool's modifiers, so the editors agree in the hand. Shaping a model is
 * feeling out proportions, and typing 0.42 into a box to find out what 0.42
 * looks like is not that.
 *
 * BUT A NUMBER YOU ALREADY KNOW HAS TO BE TYPEABLE. Copying a value from one
 * part to another, or squaring two dimensions off at exactly 0.15, is not a
 * gesture — and the drag guard used to `preventDefault()` every press, which
 * stops the browser focusing the field, so no field in the tool could be typed
 * into at all.
 *
 * The rule that resolves the two: A FOCUSED FIELD IS A TEXT BOX. An unfocused
 * one is a scrubber, and a press on it that never moves focuses it and selects
 * what is there, so typing replaces the number. Once it has focus the press
 * places a caret like it does anywhere else, and the scrubber comes back when
 * focus leaves. Enter commits, Escape puts the old number back.
 *
 * There were three copies of this gesture — model, sheet and anim — which is
 * why only some of them ever grew a fix. They differ in what a settled edit
 * means and in whether the panel has an undo stack, so those are the options.
 */

/**
 * Wire an `<input type=number>`.
 *
 * @param {HTMLInputElement} input
 * @param {number} step        change per pixel of drag
 * @param {(v:number)=>void} apply   write the value; called live during a drag
 * @param {{settle?:()=>void, snapshot?:()=>void}} opts
 *   settle    called once when a gesture or an edit finishes — usually the
 *             panel rebuild, which is too expensive to run per pixel
 *   snapshot  called once before the first change of a gesture, for undo
 */
export function scrubbable(input, step, apply, opts = {}) {
  const { settle = () => {}, snapshot = null } = opts;
  let last = +input.value;

  input.addEventListener('pointerdown', e => {
    if (e.button) return;
    // Already focused: this press belongs to the text box.
    if (document.activeElement === input) return;
    const x0 = e.clientX, v0 = +input.value;
    let moved = false;
    const move = ev => {
      const dx = ev.clientX - x0;
      if (!moved && Math.abs(dx) < 3) return;
      if (!moved) { moved = true; snapshot?.(); }
      const s = step * (ev.shiftKey ? 10 : ev.altKey ? 0.1 : 1);
      input.value = +(v0 + dx * s).toFixed(4);
      apply(+input.value);
    };
    const up = () => {
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
      if (moved) { last = +input.value; settle(); }
      // A press that never moved is a click INTO the field. The default focus
      // was prevented below so the drag could not select text, so give it back
      // here — selected, because these are short numbers you replace whole.
      else { input.focus(); input.select(); }
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
    e.preventDefault();
  });

  input.addEventListener('change', () => {
    // An empty or unreadable box is not a value. Putting `last` back beats
    // writing 0 into the model, which is what `+''` would have done.
    if (!input.value.trim() || !Number.isFinite(+input.value)) {
      input.value = last;
      return;
    }
    last = +input.value;
    snapshot?.();
    apply(last);
    settle();
  });

  input.addEventListener('keydown', e => {
    // Enter commits by leaving the field — `change` does the writing. Escape
    // abandons the edit, and leaves the value equal to the committed one so no
    // `change` fires on the way out.
    if (e.key === 'Enter') input.blur();
    else if (e.key === 'Escape') { input.value = last; input.blur(); }
    else return;
    e.preventDefault();
    e.stopPropagation();
  });
}

/** A labelled scrubbable number. `extra` nodes go after the input. */
export function numRow(label, value, step, apply, opts = {}, ...extra) {
  const l = document.createElement('label');
  l.className = 'num';
  l.textContent = label;
  const i = document.createElement('input');
  i.type = 'number';
  i.step = step;
  i.value = +(+value).toFixed(4);
  i.title = 'drag to scrub — Shift ×10, Alt ÷10. Click to type a number';
  scrubbable(i, step, apply, opts);
  l.append(i, ...extra);
  return l;
}
