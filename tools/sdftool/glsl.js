/**
 * The march, in GLSL. A line-for-line port of `prim`, `map`, `shade` and the
 * shading tail of `scanline` in src/js/core/sdf.js.
 *
 * IT STOPS AT LINEAR RGB. The Bayer offset, the scanline error carry and the
 * palette lookup stay on the CPU, and that is not a shortcut — the carry is
 * SERIAL along x, because pixel N's residual feeds pixel N+1. A fragment shader
 * cannot see its left neighbour, so a GPU dither would have to be a different
 * algorithm producing different pixels. The dither is what makes 256 colours
 * read as shading, so it is the one stage that may not change.
 *
 * The split is also the cheap one. The march calls `map()` about forty times
 * per pixel; the quantiser touches each pixel once and calls nothing. Moving
 * the first and keeping the second gets nearly all of the speed and none of the
 * risk.
 *
 * KEEP THIS IN STEP WITH src/js/core/sdf.js. It is a second copy of the field
 * maths, and the thing that stops the two drifting is tests/sdftool/test-gl.mjs,
 * which renders every primitive both ways and compares palette indices.
 */

/**
 * Parts arrive as a texture: six RGBA texels per part, one part per row.
 *
 *   0  kind, cx, cy, cz          3  rotation row 0
 *   1  a, b, c, round            4  rotation row 1
 *   2  blend, mat, hasRot, -     5  rotation row 2
 *
 * The rotation is the matrix `prepRot` already builds, uploaded rather than
 * rebuilt per sample — the same trade the CPU renderer makes.
 */
export const TEXELS = 6;

/** The loop bound. Matches the server's own expansion cap; keep the two in
 * step (tools/drawtool/server.js refuses a model that expands past 256). */
export const MAX_PARTS = 256;

/** How many materials the shader carries. A model with more falls back to the
 * CPU rather than rendering the wrong colours. */
export const MAX_MATS = 32;

export const VERT = `#version 300 es
in vec2 p;
void main() { gl_Position = vec4(p, 0, 1); }`;

export const FRAG = `#version 300 es
precision highp float;

uniform sampler2D P;
uniform vec3 M[${MAX_MATS}];
uniform vec3 FW, RT, UP, L1, L2, K1, K2, AM, FC, KC;
uniform vec4 W;      // s1, b1, s2, b2
uniform vec4 X;      // ao, spec, exposure, fog
uniform vec4 S;      // pixel scale, bounding radius, fog bias, shadow
uniform vec2 V;      // vx, vy
uniform vec2 HW;     // half width, half height
uniform int N;
out vec4 O;

#define T(i, k) texelFetch(P, ivec2(k, i), 0)

float prim(int k, vec3 p, vec3 s, float r) {
  if (k == 0) return length(p) - r;
  if (k == 1) {
    vec3 q = abs(p) - s;
    return length(max(q, 0.)) + min(max(q.x, max(q.y, q.z)), 0.) - r;
  }
  if (k == 2) {
    float h = dot(s, s);
    float t = clamp(h > 0. ? dot(p, s) / h : 0., -1., 1.);
    return length(p - s * t) - r;
  }
  if (k == 3) { float q = length(p.xz) - s.x; return length(vec2(q, p.y)) - r; }
  if (k == 4) {
    vec2 d = vec2(length(p.xz), abs(p.y)) - s.xy;
    return min(max(d.x, d.y), 0.) + length(max(d, 0.)) - r;
  }
  if (k == 5) {
    vec2 q = vec2(length(p.xz), p.y);
    vec2 k1 = vec2(s.z, s.y), k2 = vec2(s.z - s.x, 2. * s.y);
    vec2 ca = vec2(q.x - min(q.x, q.y < 0. ? s.x : s.z), abs(q.y) - s.y);
    vec2 cb = q - k1 + k2 * clamp(dot(k1 - q, k2) / dot(k2, k2), 0., 1.);
    return (cb.x < 0. && ca.y < 0. ? -1. : 1.) * sqrt(min(dot(ca, ca), dot(cb, cb))) - r;
  }
  if (k == 6) return (abs(p.x) + abs(p.y) + abs(p.z) - s.x) * .57735027 - r;
  if (k == 7) {
    vec3 q = abs(p);
    vec2 d = vec2(max(q.x * .8660254 + q.z * .5, q.z) - s.x, q.y - s.y);
    return min(max(d.x, d.y), 0.) + length(max(d, 0.)) - r;
  }
  if (k == 8) {
    float k0 = length(p / s);
    if (k0 < 1e-9) return -min(s.x, min(s.y, s.z));
    return k0 * (k0 - 1.) / length(p / (s * s));
  }
  if (k == 9) {
    float q = length(vec2(p.x, max(abs(p.y) - s.x, 0.))) - s.y;
    return length(vec2(q, p.z)) - r;
  }
  if (k == 10) {
    vec2 q = abs(p.xz);
    float e = ((max(q.x, q.y) - s.x) * s.y + (p.y + s.y) * s.x) / length(s.xy);
    float f = -p.y - s.y;
    return max(max(e, f), 0.) + min(max(e, f), 0.) - r;
  }
  if (k == 11) {
    vec2 sc = normalize(s.yz);
    float qx = abs(p.x);
    float kk = sc.y * qx > sc.x * p.y ? dot(vec2(qx, p.y), sc) : length(p.xy);
    return sqrt(max(0., dot(p, p) + s.x * s.x - 2. * s.x * kk)) - r;
  }
  if (k == 12) {
    vec3 q = abs(p);
    return max(q.z - s.y, max(q.x * .8660254 + p.y * .5, -p.y) - s.x * .5) - r;
  }
  return dot(p, normalize(s)) - r;
}

/** The point in part i's own frame: the mirror fold, the centre, the rotation. */
vec3 local(int i, vec3 p, int k) {
  vec4 a = T(i, 0);
  vec3 q = vec3((k & 128) != 0 ? abs(p.x) : p.x, p.y, p.z) - a.yzw;
  if (T(i, 2).z > 0.)
    q = vec3(dot(T(i, 3).xyz, q), dot(T(i, 4).xyz, q), dot(T(i, 5).xyz, q));
  return q;
}

float smin(float a, float b, float k) {
  if (k <= 0.) return min(a, b);
  float h = clamp(.5 + .5 * (b - a) / k, 0., 1.);
  return mix(b, a, h) - k * h * (1. - h);
}

/** Subtract: the smooth max of what we have against -s. */
float smax(float d, float s, float k) {
  if (k <= 0.) return max(d, -s);
  float h = clamp(.5 - .5 * (d + s) / k, 0., 1.);
  return mix(d, -s, h) + k * h * (1. - h);
}

/** THE HOT LOOP. Distance only; PAINT parts are skipped, as on the CPU. */
float map(vec3 p) {
  float d = 1e9;
  for (int i = 0; i < ${MAX_PARTS}; i++) {
    if (i >= N) break;
    int k = int(T(i, 0).x);
    if ((k & 64) != 0) continue;
    vec4 b = T(i, 1), c = T(i, 2);
    float s = prim(k & 31, local(i, p, k), b.xyz, b.w);
    d = (k & 32) != 0 ? smax(d, s, c.x) : smin(d, s, c.x);
  }
  return d;
}

/**
 * The blended material colour. Once per lit pixel, which is what lets it
 * afford a second pass over the parts.
 */
vec3 shade(vec3 p) {
  float d = 1e9;
  vec3 col = vec3(1);
  bool first = true;
  for (int i = 0; i < ${MAX_PARTS}; i++) {
    if (i >= N) break;
    int k = int(T(i, 0).x);
    vec4 b = T(i, 1), c = T(i, 2);
    float s = prim(k & 31, local(i, p, k), b.xyz, b.w);
    vec3 m = M[int(c.y)];
    if ((k & 64) != 0) {                       // PAINT: reaches 'blend' beyond itself
      float w = c.x > 0. ? clamp(1. - s / c.x, 0., 1.) : (s <= 0. ? 1. : 0.);
      col = mix(col, m, w);
      continue;
    }
    if ((k & 32) != 0) { d = smax(d, s, c.x); continue; }   // a cut does not paint
    // smin's own weight: 1 means the accumulated field wins, 0 means this part
    // does, so the new colour comes in at (1 - h).
    float h = first ? 0.
      : c.x > 0. ? clamp(.5 + .5 * (s - d) / c.x, 0., 1.) : (s < d ? 0. : 1.);
    col = mix(m, col, h);
    d = first ? s : smin(d, s, c.x);
    first = false;
  }
  return col;
}

void main() {
  // Screen Y grows down and world Y grows up. gl_FragCoord.y already runs up
  // from the bottom, so the flip sdf.js spells as (h/2 - py - 0.5) is here just
  // (f.y - h/2) — and the readback is walked bottom-up to match.
  vec2 f = gl_FragCoord.xy;
  vec3 o = RT * ((f.x - HW.x) * S.x + V.x) + UP * ((f.y - HW.y) * S.x + V.y);

  // Orthographic, so a ray's distance from the centre is the perpendicular
  // component alone — one test skips most of a sprite's frame.
  float br2 = S.y * S.y, perp = dot(o, o);
  if (perp > br2) { O = vec4(0); return; }
  float hf = sqrt(br2 - perp), t = -hf, eps = S.x * .5;

  bool hit = false;
  for (int i = 0; i < 512; i++) {
    if (t >= hf) break;
    float d = map(o + FW * t);
    if (d < eps) { hit = true; break; }
    t += d;
  }
  if (!hit) { O = vec4(0); return; }

  vec3 h = o + FW * t;
  // Normal by tetrahedral gradient: four evaluations rather than six.
  vec2 e = vec2(eps * .5, -eps * .5);
  float d1 = map(h + e.xyy), d2 = map(h + e.yyx), d3 = map(h + e.yxy), d4 = map(h + e.xxx);
  vec3 n = normalize(vec3(d1 - d2 - d3 + d4, -d1 - d2 + d3 + d4, -d1 + d2 - d3 + d4));

  float occ = 1.;
  if (X.x > 0.) {
    float sum = 0., sc = 1.;
    for (int k = 1; k <= 4; k++) {
      float g = .06 * float(k);
      sum += (g - map(h + n * g)) * sc;
      sc *= .7;
    }
    occ = clamp(1. - 2.2 * X.x * sum, 0., 1.);
  }

  float dif = max(dot(n, L1) * W.x + W.y, 0.);
  if (S.w > 0. && dif > 0.) {
    float st = eps * 3., sh = 1.;
    for (int i = 0; i < 256; i++) {
      if (st >= 3.) break;
      float d = map(h + L1 * st);
      if (d < eps * .5) { sh = 0.; break; }
      sh = min(sh, 8. * d / st);
      st += max(d, eps);
    }
    dif *= clamp(sh, 0., 1.);
  }
  // The fill is OCCLUDED and the key is not: the key has the shadow ray, while
  // a fill and a rim are wide soft sources that occlusion stands in for.
  float fil = max(dot(n, L2) * W.z + W.w, 0.);

  vec3 rgb = shade(h) * ((AM * occ + K2 * fil * occ + K1 * dif) * X.z);

  if (X.y > 0.) {
    // Screened in, not added on: x + s(1 - x) cannot exceed 1. It takes the
    // key's COLOUR and not its strength.
    float s = max(dot(n, normalize(L1 - FW)), 0.);
    s *= s; s *= s; s *= s;
    rgb += X.y * s * occ * KC * (1. - rgb);
  }
  // Depth haze, before the dither, so the atmosphere lands in the palette.
  if (X.w > 0.) rgb = mix(rgb, FC, S.z + t * X.w / (2. * S.y));

  // Alpha carries the depth buffer OFFSET BY ONE, so 0 means "nothing here"
  // even where the depth itself is 0 — a hit at the very back of the bounding
  // sphere. outline() reads it the way the CPU reads 'zb'.
  O = vec4(rgb, 1. + 1. - (t + hf) / max(2. * hf, 1e-9));
}`;
