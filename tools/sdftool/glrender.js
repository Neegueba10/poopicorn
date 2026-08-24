/**
 * The GPU back end: the same picture as src/js/core/sdf.js, marched in a
 * fragment shader instead of a scanline loop.
 *
 * DEV-ONLY. Nothing under tools/ ships, and the game keeps baking with
 * `src/js/core/sdf.js` — which stays the authority, stays DOM-free, and stays
 * the thing the Node suites test. This exists because the TOOL has a speed
 * problem the game does not: one 320x320 preview frame is 350 ms on the CPU,
 * and the model tab carries a whole draft-resolution machine built only to hide
 * that.
 *
 * IT PRESENTS THE SDF INTERFACE — `setSize`, `begin`, `step`, `done`,
 * `toRGBA`, `col`, `zb`, `px`, `m` — so the preview and the sheet baker can
 * hold either one and never ask which. `step()` ignores its budget because
 * there is nothing to spread across frames: the draw is one call and the frame
 * is finished when it returns.
 *
 * WHAT IT WILL NOT DO IS DIFFER SILENTLY. `create()` returns null when the
 * context, the float target, the part count or the material count is not
 * something this can reproduce, and the caller uses the CPU. A back end that
 * quietly drew something else would be worse than a slow one.
 */
import { expand, prepRot, bound, STRIDE } from '/src/js/core/sdf.js';
import { buildRgbLut, BAYER } from '/src/js/core/quant.js';
import { VERT, FRAG, TEXELS, MAX_PARTS, MAX_MATS } from './glsl.js';

const TAU = Math.PI * 2;

const norm = (x, y, z) => {
  const l = Math.hypot(x, y, z) || 1;
  return [x / l, y / l, z / l];
};

/**
 * ONE CONTEXT FOR THE WHOLE TOOL, built on first use.
 *
 * A browser caps how many live WebGL contexts a page may have and drops the
 * oldest without asking. The model preview, the sheet bake and anything added
 * later therefore share one rather than each taking their own.
 */
let gl = null, prog = null, uni = null, boot = false, lost = false;

/** The palette lookup table, built once per palette. 54 ms, and it is the same
 * table the CPU renderer builds — so the two are shared rather than rebuilt. */
const lutCache = new WeakMap();

function lutFor(pal, lo, hi) {
  let e = lutCache.get(pal);
  if (!e || e.lo !== lo || e.hi !== hi) {
    e = { lo, hi, lut: buildRgbLut(pal, lo, hi) };
    lutCache.set(pal, e);
  }
  return e.lut;
}

function compile(type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
    throw new Error(gl.getShaderInfoLog(s) || 'shader compile failed');
  return s;
}

/**
 * Bring the context up. Returns false — permanently, for this page — on any
 * machine that cannot render what this needs.
 */
function init() {
  if (boot) return !!prog;
  boot = true;
  try {
    const cv = document.createElement('canvas');
    cv.width = cv.height = 1;
    gl = cv.getContext('webgl2', { antialias: false, depth: false, alpha: true });
    if (!gl) return false;
    // RGBA32F as a render target. Without it the shading would come back
    // through 8 bits a channel and the error carry would drift, so this is a
    // requirement rather than a preference.
    if (!gl.getExtension('EXT_color_buffer_float')) return false;

    // A LOST CONTEXT IS PERMANENT HERE, on purpose. Restoring it would mean
    // rebuilding the program, both textures and every framebuffer while a bake
    // is part-way through one; falling back to the CPU renderer costs a slow
    // frame and cannot be half-done. The status line says which back end drew,
    // so the change is visible rather than mysterious.
    cv.addEventListener('webglcontextlost', e => {
      e.preventDefault();
      lost = true;
      // eslint-disable-next-line no-console
      console.warn('sdftool: WebGL context lost — falling back to the CPU renderer');
    });

    prog = gl.createProgram();
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAG));
    gl.bindAttribLocation(prog, 0, 'p');
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS))
      throw new Error(gl.getProgramInfoLog(prog) || 'link failed');
    gl.useProgram(prog);

    // One full-screen triangle. Bigger than the viewport on purpose: two
    // triangles seam down the diagonal on some drivers, and there is no cost.
    const vb = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vb);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    uni = {};
    for (const n of ['P', 'M', 'FW', 'RT', 'UP', 'L1', 'L2', 'K1', 'K2', 'AM',
      'FC', 'KC', 'W', 'X', 'S', 'V', 'HW', 'N'])
      uni[n] = gl.getUniformLocation(prog, n);
    gl.uniform1i(uni.P, 0);
    return true;
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('sdftool: WebGL back end unavailable —', e.message);
    prog = null;
    return false;
  }
}

/** Is the GPU path usable at all on this machine? */
export const available = () => init() && !lost;

/** Why the GPU path is not being used, for the status line. */
export const unavailableReason = () =>
  (lost ? 'context lost' : init() ? '' : 'no WebGL2 float target');

/**
 * Can this model be rendered on the GPU?
 *
 * The two limits are the shader's, and both are hard rather than approximate:
 * a model past either would render the wrong thing, so it goes to the CPU.
 */
export function supports(m, mats) {
  // Strictly fewer materials than the shader's array holds, because the LAST
  // slot is kept white as the out-of-range sentinel — `shade()` in sdf.js falls
  // back to white for an index with no material, and this has to agree.
  return m.length / STRIDE <= MAX_PARTS && mats.length < MAX_MATS;
}

export class GLRenderer {
  /**
   * Same constructor shape as SDF, and the same options mean the same things.
   * The dither amount and the carry are read here for the identical reason —
   * this quantiser has to be the CPU one, pixel for pixel.
   */
  constructor(w, h, pal, opts = {}) {
    this.pal = pal;
    this.nCol = (pal.length / 3) | 0;
    this.lo = opts.lo ?? 0;
    this.hi = opts.hi ?? this.nCol - 1;
    this.lut = lutFor(pal, this.lo, this.hi);
    this.rampSize = opts.rampSize | 0;
    // Keep these in step with src/js/core/sdf.js's constructor. A default that
    // drifted here would put the tool's picture and the game's bake back where
    // they were: the same model, quantised two ways.
    this.damt = opts.ditherAmt ?? 0.035;
    this.carry = opts.carry ?? 0.8;
    this.tex = null;
    this.fbo = null;
    this.rt = null;
    this.fw = 0;
    this.fh = 0;
    this.setSize(w, h);
  }

  setSize(w, h) {
    this.w = w;
    this.h = h;
    this.col = new Uint8Array(w * h);
    this.zb = new Float32Array(w * h);
    // Grown, never shrunk: a sheet bake calls this once per sprite, and
    // readPixels only ever fills the first w*h*4 of it.
    if (!this.rgb || this.rgb.length < w * h * 4) this.rgb = new Float32Array(w * h * 4);
    this.px = 0;
    this.fin = false;
  }

  /** The render target, grown to fit. Kept between renders: a sheet bake
   * changes size on nearly every sprite and reallocating each time is the one
   * avoidable cost in the whole path. */
  target(w, h) {
    if (this.rt && this.fw >= w && this.fh >= h) return;
    this.fw = Math.max(w, this.fw);
    this.fh = Math.max(h, this.fh);
    if (!this.rt) {
      this.rt = gl.createTexture();
      this.fbo = gl.createFramebuffer();
    }
    gl.bindTexture(gl.TEXTURE_2D, this.rt);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, this.fw, this.fh, 0, gl.RGBA, gl.FLOAT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.rt, 0);
  }

  /**
   * Set up a render, and do all of it.
   *
   * Everything before the draw mirrors `begin()` in src/js/core/sdf.js exactly:
   * the scatter expansion, the camera basis, the bounds, the rotation prep, the
   * two lights and the fog. Where that method stores a field for `scanline` to
   * read, this one uploads a uniform.
   */
  begin(model, mats, o = {}) {
    this.m = expand(model);
    this.mats = mats;
    this.o = o;
    this.col.fill(o.bg ?? 0);
    this.zb.fill(0);
    this.px = 0;
    this.fin = false;

    const n = this.m.length / STRIDE;
    const rot = prepRot(this.m);
    const br = bound(this.m);
    const scale = (o.scale ?? 3) / Math.min(this.w, this.h);

    const cy = Math.cos((o.yaw ?? 0) * TAU), sy = Math.sin((o.yaw ?? 0) * TAU);
    const cp = Math.cos((o.pitch ?? 0) * TAU), sp = Math.sin((o.pitch ?? 0) * TAU);
    const f = [sy * cp, -sp, cy * cp];
    const r = [cy, 0, -sy];
    const u = [sy * sp, cp, cy * sp];

    // `lcam` reads the directions in camera space, so the suns keep their place
    // on screen as the camera turns. The shader is untouched: the transform is
    // once per render, and the uniform stays a world direction.
    const cam = o.lcam
      ? d => r.map((v, i) => v * d[0] + u[i] * d[1] + f[i] * d[2])
      : d => d;
    const l1 = cam(norm(o.lx ?? 0.6, o.ly ?? 0.7, o.lz ?? -0.4));
    // Unset means "follow the key" — the same rule the CPU renderer applies,
    // and the reason the fill's sun swings when the key is dragged.
    const l2 = o.l2x == null && o.l2y == null && o.l2z == null
      ? [-l1[0], -l1[1], -l1[2]]
      : cam(norm(o.l2x ?? 0, o.l2y ?? 0, o.l2z ?? 0));

    const w1 = o.lw ?? 0, w2 = o.l2w ?? 1;
    const i2 = o.l2i ?? 0.1;
    const kc = [o.lr ?? 1, o.lg ?? 1, o.lb ?? 1];
    const k1 = kc.map(v => v * (o.li ?? 0.74));
    const k2 = [(o.l2r ?? 1) * i2, (o.l2g ?? 1) * i2, (o.l2b ?? 1) * i2];

    const fog = o.fog ?? 0;
    const fc = [o.fogr ?? 0, o.fogg ?? 0, o.fogb ?? 0];
    const amb = o.amb ?? 0.16;
    const am = fc.map(v => amb * (1 + (v - 1) * fog));

    // The parts texture: six RGBA texels a part, laid out as glsl.js documents.
    const data = new Float32Array(n * TEXELS * 4);
    for (let i = 0; i < n; i++) {
      const p = i * STRIDE, d = i * TEXELS * 4, q = i * 10;
      data[d] = this.m[p];
      data[d + 1] = this.m[p + 1];
      data[d + 2] = this.m[p + 2];
      data[d + 3] = this.m[p + 3];
      data[d + 4] = this.m[p + 7];
      data[d + 5] = this.m[p + 8];
      data[d + 6] = this.m[p + 9];
      data[d + 7] = this.m[p + 10];
      data[d + 8] = this.m[p + 11];
      // An index with no material must come back WHITE, which is what
      // `mats[i] || [1, 1, 1]` does in shade(). Every slot past the table is
      // left white, so pointing at the last one is that fallback.
      const mi = this.m[p + 12];
      data[d + 9] = mi >= 0 && mi < mats.length ? mi : MAX_MATS - 1;
      data[d + 10] = rot && rot[q + 9] ? 1 : 0;
      if (rot && rot[q + 9]) {
        for (let k = 0; k < 9; k++) data[d + 12 + (k / 3 | 0) * 4 + k % 3] = rot[q + k];
      }
    }

    if (!this.tex) {
      this.tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.tex);
      for (const k of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER])
        gl.texParameteri(gl.TEXTURE_2D, k, gl.NEAREST);
      for (const k of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T])
        gl.texParameteri(gl.TEXTURE_2D, k, gl.CLAMP_TO_EDGE);
    }
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, TEXELS, n, 0, gl.RGBA, gl.FLOAT, data);

    const flat = new Float32Array(MAX_MATS * 3).fill(1);
    mats.forEach((c, i) => { if (i < MAX_MATS) flat.set([c[0], c[1], c[2]], i * 3); });

    gl.useProgram(prog);
    gl.uniform3fv(uni.M, flat);
    gl.uniform3fv(uni.FW, f);
    gl.uniform3fv(uni.RT, r);
    gl.uniform3fv(uni.UP, u);
    gl.uniform3fv(uni.L1, l1);
    gl.uniform3fv(uni.L2, l2);
    gl.uniform3fv(uni.K1, k1);
    gl.uniform3fv(uni.K2, k2);
    gl.uniform3fv(uni.AM, am);
    gl.uniform3fv(uni.FC, fc);
    gl.uniform3fv(uni.KC, kc);
    gl.uniform4f(uni.W, 1 / (1 + w1), w1 / (1 + w1), 1 / (1 + w2), w2 / (1 + w2));
    gl.uniform4f(uni.X, o.ao ?? 1, o.spec ?? 0, o.exposure ?? 1, fog);
    gl.uniform4f(uni.S, scale, br, fog * 0.5, o.shadow ?? 0);
    gl.uniform2f(uni.V, o.vx ?? 0, o.vy ?? 0);
    gl.uniform2f(uni.HW, this.w / 2, this.h / 2);
    gl.uniform1i(uni.N, n);
  }

  done() { return this.fin; }

  /**
   * The whole frame. The budget is ignored on purpose: there is nothing to
   * spread, and pretending otherwise would make a caller's progress bar lie.
   */
  step() {
    if (this.fin) return this.h;
    this.target(this.w, this.h);
    // AFTER target(), which binds the render target to unit 0 to allocate it.
    // The parts texture has to come back or the shader samples the frame it is
    // about to draw, every part reads as zeroes, and the sprite is empty.
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.useProgram(prog);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.viewport(0, 0, this.w, this.h);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.readPixels(0, 0, this.w, this.h, gl.RGBA, gl.FLOAT, this.rgb);
    this.quantise();
    this.outline();
    this.fin = true;
    return this.h;
  }

  render(model, mats, o) {
    this.begin(model, mats, o);
    this.step();
    return this.col;
  }

  /**
   * Linear RGB to palette indices — the tail of `scanline()` in
   * src/js/core/sdf.js, moved rather than reinvented.
   *
   * IT IS A SECOND COPY OF THE DITHER and that is the deliberate cost of this
   * whole design: the error carry is serial along x, so it cannot go in the
   * shader (glsl.js says why), and putting it in `sdf.js` as a shared method
   * would cost the GAME bytes, because class methods do not tree-shake. What
   * stops the two drifting is tests/sdftool/test-gl.mjs, which compares the
   * palette indices both paths produce.
   *
   * THE CARRY IS NOT RESET BY A MISS. A pixel the march did not hit is skipped
   * before the dither on the CPU too, so the residual crosses a gap in the
   * silhouette rather than starting again after it.
   */
  quantise() {
    const { w, h, lut, pal, damt, carry, col, zb, rgb } = this;
    let px = 0;
    for (let y = 0; y < h; y++) {
      let er = 0, eg = 0, eb = 0;
      // The readback runs bottom-up; row y of the picture is row h-1-y here.
      const src = (h - 1 - y) * w * 4;
      for (let x = 0; x < w; x++) {
        const o = src + x * 4;
        const a = rgb[o + 3];
        if (a <= 0) continue;                     // nothing marched here
        const bay = BAYER[(y & 3) * 4 + (x & 3)] * damt;
        const r = rgb[o] + er + bay, g = rgb[o + 1] + eg + bay, b = rgb[o + 2] + eb + bay;
        const ri = r < 0 ? 0 : r > 1 ? 31 : (r * 31) | 0;
        const gi = g < 0 ? 0 : g > 1 ? 31 : (g * 31) | 0;
        const bi = b < 0 ? 0 : b > 1 ? 31 : (b * 31) | 0;
        const c = lut[(ri << 10) | (gi << 5) | bi];
        er = (r - pal[c * 3] / 255) * carry;
        eg = (g - pal[c * 3 + 1] / 255) * carry;
        eb = (b - pal[c * 3 + 2] / 255) * carry;
        const i = y * w + x;
        col[i] = c;
        zb[i] = a - 1;                            // alpha carries depth plus one
        px++;
      }
    }
    this.px = px;
  }

  /** The silhouette's inner rim, one ramp step darker. The same pass, and the
   * same reason it may not exceed one step — see outline() in sdf.js. */
  outline() {
    const n = this.o.outline | 0;
    if (!n || this.rampSize !== 8) return;
    const { w, h, zb, col } = this;
    const edge = [];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (!zb[i]) continue;
        if (x === 0 || y === 0 || x === w - 1 || y === h - 1
          || !zb[i - 1] || !zb[i + 1] || !zb[i - w] || !zb[i + w]) edge.push(i);
      }
    }
    for (const i of edge) {
      const c = col[i], s = c & 7;
      col[i] = (c & ~7) | (s > n ? s - n : 0);
    }
  }

  /** Indices out as RGBA. Index 0 is transparent, which is a sprite's alpha. */
  toRGBA(out) {
    const n = this.w * this.h;
    out = out || new Uint8ClampedArray(n * 4);
    for (let i = 0; i < n; i++) {
      const c = this.col[i] * 3;
      out[i * 4] = this.pal[c];
      out[i * 4 + 1] = this.pal[c + 1];
      out[i * 4 + 2] = this.pal[c + 2];
      out[i * 4 + 3] = this.col[i] ? 255 : 0;
    }
    return out;
  }
}

/**
 * A GPU renderer, or null on a machine that cannot have one.
 *
 * Callers hold the result and check it once. Handing back null rather than a
 * renderer that silently falls back keeps the choice visible in the status
 * line, which matters: the two back ends do not agree to the last pixel and
 * you are entitled to know which one drew what you are looking at.
 */
export function create(w, h, pal, opts) {
  if (!available()) return null;
  try {
    return new GLRenderer(w, h, pal, opts);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('sdftool: GPU renderer failed —', e.message);
    return null;
  }
}
