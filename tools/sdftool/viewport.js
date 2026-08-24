/**
 * The editing viewport: how big the picture is drawn, and which part of it you
 * are looking at. One instance per tab — the model preview and the sheet
 * preview navigate independently, because they are different pictures at
 * different sizes.
 *
 * IT IS NOT THE CAMERA. The model tab already has a camera: `yaw`, `pitch`,
 * `scale` and `vx`/`vy` are render parameters that get SAVED with the model.
 * This is the other thing — where the rendered image sits on your screen —
 * and it touches no document at all. Confusing the two is why "zoom" needed
 * saying twice: `scale` changes what the render contains, this changes how
 * large you see it.
 *
 * WHOLE-NUMBER SCALES ONLY, and that is the whole reason this module exists
 * rather than a CSS `width: 100%`. These pictures are dithered indexed images;
 * a resampled preview of one tells you nothing about the dither, and the
 * dither is a decision you are making. So "fit" means the largest whole
 * multiple that fits, not the exact fraction — the picture fills the pane as
 * far as square pixels allow and no further.
 */

const MIN = 1, MAX = 16;

// Space is a modifier, not a per-viewport gesture: it is held on the keyboard
// while the pointer is over whichever picture you meant. One flag for all of
// them, and the pointer decides who acts on it.
let spaceDown = false;
addEventListener('keydown', e => {
  if (e.key === ' ' && e.target.tagName !== 'INPUT') { spaceDown = true; e.preventDefault(); }
});
addEventListener('keyup', e => { if (e.key === ' ') spaceDown = false; });

/**
 * Whether the pan modifier is held.
 *
 * Exported because the pan listener below is a CAPTURE listener whose
 * `stopPropagation` can no longer be relied on alone: an editor that listens on
 * the same host element gets its own listener run anyway when the host IS the
 * event target, and only `stopImmediatePropagation` would stop it — which would
 * also stop anything else the host has. So the editor asks instead.
 */
export const panModifier = () => spaceDown;

/**
 * @param {HTMLElement} host   the clipping box the picture lives in
 * @param {HTMLElement[]} layers  elements to size and position together (the
 *   render, and the widget overlay drawn over it)
 * @param {() => number[]} srcSize  the source picture's size, in its own pixels
 * @param {(z: number, x: number, y: number) => void} [onPlace]  called on every
 *   apply, before the layers move: the scale and the picture's top-left within
 *   the host. The model tab's widget overlay is NOT a layer — it covers the
 *   pane and draws the camera cross in the pane's own corner — so it needs
 *   these numbers to keep drawing the gizmo over the part it belongs to.
 */
export function createViewport(host, layers, srcSize, onPlace) {
  let z = 1, fitting = true, px = 0, py = 0;

  const fitScale = () => {
    const [sw, sh] = srcSize();
    if (!sw || !sh) return 1;
    // Contain, not cover: a picture that overflows the pane on one axis has to
    // be panned to be seen whole, which is worse than being a size smaller.
    return Math.max(MIN, Math.min(MAX,
      Math.min(Math.floor(host.clientWidth / sw), Math.floor(host.clientHeight / sh)) || MIN));
  };

  const scale = () => (fitting ? fitScale() : z);

  /** Size and position every layer, clamping the pan on the way. */
  function apply() {
    const s = scale();
    const [sw, sh] = srcSize();
    const w = sw * s, h = sh * s;
    // Centred while it fits, clamped to the edges once it does not — the pan
    // is written back so a drag that runs off the edge does not build up slack
    // it has to eat again on the way back.
    px = w <= host.clientWidth ? (host.clientWidth - w) / 2
      : Math.min(0, Math.max(host.clientWidth - w, px));
    py = h <= host.clientHeight ? (host.clientHeight - h) / 2
      : Math.min(0, Math.max(host.clientHeight - h, py));
    onPlace?.(s, px, py);
    for (const el of layers) {
      el.style.position = 'absolute';
      el.style.left = Math.round(px) + 'px';
      el.style.top = Math.round(py) + 'px';
      el.style.width = w + 'px';
      el.style.height = h + 'px';
    }
  }

  /** Zoom one step, keeping the source pixel under (clientX, clientY) put. */
  function zoomAt(dir, clientX, clientY) {
    const z0 = scale();
    const z1 = Math.max(MIN, Math.min(MAX, z0 + dir));
    if (z1 === z0) return;
    const r = host.getBoundingClientRect();
    // clientLeft/Top: the host is bordered, and an absolutely positioned child
    // sits at its PADDING box — so the cursor has to be measured from there or
    // the anchor drifts by the border width every step.
    const cx = clientX - r.left - host.clientLeft;
    const cy = clientY - r.top - host.clientTop;
    px = cx - (cx - px) * z1 / z0;
    py = cy - (cy - py) * z1 / z0;
    fitting = false;
    z = z1;
    apply();
  }

  host.addEventListener('wheel', e => {
    e.preventDefault();
    zoomAt(e.deltaY < 0 ? 1 : -1, e.clientX, e.clientY);
  }, { passive: false });

  // Middle-drag, or space and drag — the same pan gesture the scenetool,
  // worldtool and stagetool use, so the editors feel alike. Capture, because
  // both pictures already own their pointerdown for editing and this must win
  // before the model's own drag-a-part gesture reads the event.
  host.addEventListener('pointerdown', e => {
    if (e.button !== 1 && !(e.button === 0 && spaceDown)) return;
    e.preventDefault();
    e.stopPropagation();
    const x0 = e.clientX, y0 = e.clientY, ox = px, oy = py;
    host.setPointerCapture(e.pointerId);
    host.style.cursor = 'grabbing';
    const move = ev => {
      px = ox + (ev.clientX - x0);
      py = oy + (ev.clientY - y0);
      fitting = false;
      apply();
    };
    const up = () => {
      host.removeEventListener('pointermove', move);
      host.removeEventListener('pointerup', up);
      host.removeEventListener('pointercancel', up);
      host.style.cursor = '';
    };
    host.addEventListener('pointermove', move);
    host.addEventListener('pointerup', up);
    host.addEventListener('pointercancel', up);
  }, true);

  addEventListener('resize', apply);

  return {
    apply,
    scale,
    fit() { fitting = true; apply(); },
    setScale(v) { fitting = false; z = Math.max(MIN, Math.min(MAX, v)); apply(); },
    zoomAt,
    /** Test hook: what the viewport is doing, without reading CSS back. */
    get state() { return { z: scale(), fitting, x: px, y: py }; },
  };
}
