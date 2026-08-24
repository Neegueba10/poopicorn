// No player is imported here on purpose. There are two -- ./musicplayer.js
// (SoundBox format, smallest) and ./voxby.js (the v2 gated synth) -- and
// naming either one from this module would pull it into every game that
// imports anything at all from utils.js, including games that use the other
// one or no music whatever. initAudio() takes the player as an argument
// instead, so the game's own import decides which of the two it pays for.

export function rand(min, max) {
  return Math.floor(Math.random() * (max + 1 - min) + min);
};

export function randFloat(min, max) {
  return Math.random() * (max - min) + min;
}

export function choice(values) {
  return values[rand(0, values.length - 1)];
};

export function lerp(a, b, x){
   return a + (b -a ) * x;
}

export function inView(o, padding=0){
  return o.x - view.x + padding > 0 &&
         o.y - view.y + padding > 0 &&
         o.x - view.x - padding < screenWidth &&
         o.y - view.y - padding < screenHeight
}

export function callOnce(fn){
  let called = false;
  return function(){
    if(called) return;
    called = true;
    fn();
  }
}

export function getPan(entity){
  return (entity.x - view.x) / screenWidth * 2 - 1;
}

export function radians(degrees) {
  return degrees * Math.PI / 180;
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function distance(x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  return Math.hypot(dx, dy);
}

// Convenience helper for checking tile indices with an offset
export function getMapTile(map, x, y, ox = 0, oy = 0) {
  return map.getTileAtPixel(x - ox, y - oy);
}

export function tileCollisionCheck(map, entity) {
  if(map.getTileAtPixel(entity.x, entity.y) === 0 |
      map.getTileAtPixel(entity.x+entity.width, entity.y) === 0 |
      map.getTileAtPixel(entity.x, entity.y-entity.height) === 0 |
      map.getTileAtPixel(entity.x+entity.width, entity.y-entity.height) === 0) {
      return true
  }
  return false
}

// module-scoped audio state (exported live bindings, mangleable by terser)
export let audioCtx, audioMaster, compressor;
export let totalSounds = 0, soundsReady = 0, renderedSounds;

// Render every sound in `soundsArray` to an AudioBuffer, in order.
//
// `Player` is the constructor to render them with, and it is required rather
// than defaulted: a default would make this module name one of the two players
// statically, and every game importing utils.js would then carry it. Pass
// MusicPlayer from ./musicplayer.js for SoundBox-format songs, or VoxbyPlayer
// from ./voxby.js for v2 ones. The two formats are not interchangeable, so a
// song and its player have to be chosen together anyway.
export function initAudio(soundsArray, Player) {
        audioCtx = new AudioContext;
        audioMaster = audioCtx.createGain();
        compressor = audioCtx.createDynamicsCompressor();
        compressor.threshold.setValueAtTime(-60, audioCtx.currentTime);
        compressor.knee.setValueAtTime(40, audioCtx.currentTime);
        compressor.ratio.setValueAtTime(12, audioCtx.currentTime);
        compressor.attack.setValueAtTime(0, audioCtx.currentTime);
        compressor.release.setValueAtTime(0.25, audioCtx.currentTime);

        audioMaster.connect(compressor);
        compressor.connect(audioCtx.destination);

        totalSounds = soundsArray.length;
        // array of AudioBuffers, same order as soundsArray. Each element of
        // soundsArray is a sound module's data object (tada.js, song.js, ...)
        // directly. Numeric indices on purpose: string keys read back via
        // static property access (soundBank.tada) get renamed by the MINIFY
        // build's property mangler while the stored key stays a runtime
        // string — silent undefineds in dist that dev never shows.
        renderedSounds = [];
        soundsReady = 0;
        soundsArray.forEach(function (data, ix) {
            var sndGenerator = new Player();
            sndGenerator.init(data);
            var timer = setInterval(function () {
                if (sndGenerator.generate() == 1) {
                    clearInterval(timer);
                    soundsReady += 1;
                    renderedSounds[ix] = sndGenerator.createAudioBuffer(audioCtx);
                }
            }, 0)
        })
        return renderedSounds;
    }

export function playSound(buffer, playbackRate = 1, pan = 0, volume = .5, loop = false) {

  var source = audioCtx.createBufferSource();
  var gainNode = audioCtx.createGain();
  var panNode = audioCtx.createStereoPanner();

  source.buffer = buffer;
  source.connect(panNode);
  panNode.connect(gainNode);
  gainNode.connect(audioMaster);

  source.playbackRate.value = playbackRate;
  source.loop = loop;
  gainNode.gain.value = volume;
  panNode["pan"].value = pan;
  source.start();
  return {volume: gainNode, sound: source};

}

// Keyed by KeyboardEvent.key strings ('ArrowLeft', ' ', 'a', 'Escape', ...)
// — no keycode constant table to ship, and event.keyCode is deprecated anyway.
export const Key = {

  pressed: {},
  released: {},

  isDown(key) {
      return this.pressed[key];
  },

  justReleased(key) {
      return this.released[key];
  },

  onKeydown(event) {
      this.pressed[event.key] = true;
  },

  onKeyup(event) {
      this.released[event.key] = true;
      delete this.pressed[event.key];
  },

  update() {
    // reset the released keys without creating new objects
    for (let key in this.released) {
      delete this.released[key];
    }
  }
};

// Mouse position in canvas-buffer pixels (not page/CSS pixels — scaled
// through getBoundingClientRect so it stays correct under resizeCanvas's
// CSS scaling), plus a held-down flag. Same singleton shape as Key.
export const Mouse = {
  x: 0, y: 0, down: false,

  onMove(event, canvas) {
    const rect = canvas.getBoundingClientRect();
    this.x = (event.clientX - rect.left) * canvas.width / rect.width;
    this.y = (event.clientY - rect.top) * canvas.height / rect.height;
  },

  onDown() { this.down = true; },
  onUp() { this.down = false; },
};

export function resizeCanvas(canvas, baseWidth, baseHeight) {
  const aspectRatio = baseWidth / baseHeight;
  let newWidth = Math.floor(window.innerWidth / baseWidth) * baseWidth;
  let newHeight = newWidth / aspectRatio;

  if (newHeight > window.innerHeight) {
      newHeight = Math.floor(window.innerHeight / baseHeight) * baseHeight;
      //newHeight = window.innerHeight;
      newWidth = newHeight * aspectRatio;
  }

  canvas.style.width = `${newWidth}px`;
  canvas.style.height = `${newHeight}px`;
}

export class PerlinNoise {
  constructor() {
    this.gradients = {};
    this.memory = {};
  }

  randVect() {
    const theta = Math.random() * 2 * Math.PI;
    return { x: Math.cos(theta), y: Math.sin(theta) };
  }

  dotProdGrid(x, y, vx, vy) {
    const dVect = { x: x - vx, y: y - vy };
    let gVect;
    if (this.gradients[[vx, vy]]) {
      gVect = this.gradients[[vx, vy]];
    } else {
      gVect = this.randVect();
      this.gradients[[vx, vy]] = gVect;
    }
    return dVect.x * gVect.x + dVect.y * gVect.y;
  }

  smootherStep(x) {
    return 6 * x ** 5 - 15 * x ** 4 + 10 * x ** 3;
  }

  interp(x, a, b) {
    return a + this.smootherStep(x) * (b - a);
  }

  seed() {
    this.gradients = {};
    this.memory = {};
  }

  get(x, y) {
    if (this.memory.hasOwnProperty([x, y])) return this.memory[[x, y]];

    const xf = Math.floor(x);
    const yf = Math.floor(y);

    const tl = this.dotProdGrid(x, y, xf, yf);
    const tr = this.dotProdGrid(x, y, xf + 1, yf);
    const bl = this.dotProdGrid(x, y, xf, yf + 1);
    const br = this.dotProdGrid(x, y, xf + 1, yf + 1);
    const xt = this.interp(x - xf, tl, tr);
    const xb = this.interp(x - xf, bl, br);
    const v = this.interp(y - yf, xt, xb);

    this.memory[[x, y]] = v;
    return v;
  }
}
export class rectangle {
  constructor(x, y, width, height) {
      this.x = x;
      this.y = y;
      this.width = width;
      this.height = height;
  }

  intersects(other) {
      return this.x < other.x + other.width &&
             this.x + this.width > other.x &&
             this.y < other.y + other.height &&
             this.y + this.height > other.y;
  }

  contains(x, y) {
      return x >= this.x && x <= this.x + this.width &&
             y >= this.y && y <= this.y + this.height;
  }
}




