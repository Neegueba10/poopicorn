/**
 * game.js — the entry point. Canvas only: no RetroBuffer, no palette image, no
 * indexed framebuffer.
 *
 * The whole visual stack is: generate a palette, bake SDF models into one
 * offscreen canvas, and draw sub-rects of it with `drawImage` onto a small
 * canvas that CSS scales up. The palettised look survives because the pixels
 * were quantised when they were BAKED, not because anything enforces it at
 * draw time — which is the entire reason an indexed framebuffer is not here.
 * Measured: 3,973 B against 7,495 B for the same game through RetroBuffer,
 * 26% of the whole budget.
 *
 * The old boot survives as `src/js/game-retro.js` for the games that predate
 * this, and so the two can still be measured against each other:
 *
 *   ENTRY=./src/js/game-retro.js npm run build && npm run build:zipSize
 */
import { genPalette } from './core/palette.js';
import { audioCtx } from './core/utils.js';
import Game from './games/poppy.js';

const W = 480, H = 270;

document.body.style = 'margin:0;background:#000;overflow:hidden;height:100vh;display:grid;place-items:center';

// The canvas is IN index.html, not built here. An element with an id is also
// a global under that name, so `g` IS the element — no createElement, no
// getElementById, and no append call at the bottom. It also has to be a real
// element rather than a built one for a second reason: inline-html.js strips
// the <body> line, so whatever is in the markup is the only thing that opens
// a <body> for this script to attach to. Building the canvas here left the
// document with nothing but <script>, and document.body came back null.
const canvas = g;
canvas.width = W;
canvas.height = H;
// The low-resolution look, in two lines: never resample, and scale by whole
// numbers so a pixel stays a square.
canvas.style.imageRendering = 'pixelated';
// Set HERE and not in a stylesheet: a comment in this file is free (terser
// strips it) but every byte of CSS survives into the zip. index.html carries
// no <style> at all now — the centring lives in the body style above, and the
// canvas needs no display:block because a grid item is blockified anyway.
// Do not put the six-letter word for <body> in index.html: inline-html.js
// drops every LINE containing it, which once silently mangled a CSS comment.
const fit = () => {
  const s = Math.max(1, Math.min(innerWidth / W, innerHeight / H) | 0);
  canvas.style.width = W * s + 'px';
  canvas.style.height = H * s + 'px';
};
onresize = fit;
fit();

const ctx = canvas.getContext('2d');
ctx.imageSmoothingEnabled = false;

// Keys: a Set is the whole input system a prototype needs. The keydown also
// unlocks audio, because a keyboard-only game never gets a click.
const keys = new Set();
// Folded to lower case HERE so a game polls one literal per key instead of
// two. 'ArrowLeft' becomes 'arrowleft'; digits and ' ' are unchanged.
onkeydown = e => {
  keys.add(e.key.toLowerCase());
  // Space and the arrows scroll the page, and space is a play key — the game
  // owns them once it has focus.
  if (e.key === ' ' || e.key.startsWith('Arrow')) e.preventDefault();
  audioCtx?.resume();
};
onkeyup = e => keys.delete(e.key.toLowerCase());

// The click that leaves the loading screen is also the audio unlock. Browsers
// only honour resume() during user activation, so a resume() from the rAF loop
// silently leaves the context suspended — this handler is the one place it
// counts. audioCtx is undefined until initAudio() runs.
onclick = () => {
  audioCtx?.resume();
  Game.onClick();
};

// `canvas` rides along for mouse-aim games: reading it back off the DOM as
// ctx.canvas breaks in MINIFY — `canvas` is on the crunch-props allowlist,
// so the access gets mangled while the context's real property does not.
Game.init({ ctx, W, H, keys, canvas, pal: genPalette() });

let last = performance.now();
const loop = now => {
  const dt = now - last;
  last = now;
  Game.update(dt);
  Game.draw();
  requestAnimationFrame(loop);
};
requestAnimationFrame(loop);
