/**
 * poppy.js — Poopicorn: the whole game.
 *
 * Graybox: rectangles and circles, but the real loop — unicorns arrive,
 * eat blooms, and drop poop piles; the hose sprays poppies back up and
 * pumps latched unicorns until they pop; pops scatter dust and leave a
 * lift beam. Everything runs on a fixed 120 Hz substep so the verlet hose
 * behaves the same at any display rate.
 *
 * TWO CURRENCIES, AND THEY COME FROM OPPOSITE OUTCOMES. A pile is fuel: the
 * pests refill your tank by eating, so a bad wave leaves you loaded and a
 * perfect one leaves you dry. Dust is money, and only a pop makes it. What
 * you lose buys the next attempt; what you kill buys the upgrade.
 */
import { bakeFont } from '../core/font.js';
import { clamp, initAudio, playSound, soundsReady, totalSounds } from '../core/utils.js';
import { stageBaker, drawStage, eachObject, kvOf } from '../core/stage.js';
import { clipSheet } from '../core/sdfanim.js';
import MusicPlayer from '../core/musicplayer.js';
import powerup from '../sounds/powerup.js';
import song from '../sounds/song.js';
import pump from '../sounds/pump.js';
import jump from '../sounds/jump.js';
import pegapop from '../sounds/pegapop.js';
import STAGE from '../stages/farm.js';
import PROPS from '../sheets/props.js';
import poppyColors from '../clips/poppy-colors.js';
import pegacornFly from '../clips/pegacorn-fly.js';
import pegacornInflate from '../clips/pegacorn-inflate.js';
import pegacornEat from '../clips/pegacorn-eat.js';
import hero from '../clips/hero.js';

// Numeric indices, never string keys (the mangler rule; see README.md).
const POWERUP = 0, SONG = 1, PUMP = 2, JUMP_SFX = 3, PEGAPOP = 4;

// Two sheet sources, and the split is load-bearing. Source 0 is the props
// sheet, which the stagetool numbers; source 1 is the clips, which the game
// numbers. Concatenating them would tie every clip id to the sheet's length
// and hand a stale stage stamp a clip frame to draw.
const PROP_SRC = 0, CLIP_SRC = 1;

// The walk clip is delve's, at its authored frame. To resize the farmer,
// rebuild it with a different w/h — `scale` is world units across the frame's
// short axis, so a smaller frame is the same view at fewer pixels.
const HERO_H = hero[3];
const HERO_Y = 6; // sink below the box's floor; the frame's foot is empty

// Appended, never inserted: a clip added at the end cannot move the ids of
// the clips before it.
const FARM = [[PROPS, [...clipSheet(poppyColors), ...clipSheet(pegacornFly),
  ...clipSheet(pegacornInflate), ...clipSheet(hero), ...clipSheet(pegacornEat)]],
...STAGE.slice(1)];

// Props, in sheet order. The sub-bloom flower states sit contiguous in the
// sheet, so their sprite is FLOWER0 + s. BLOOM is a STATE, not a sprite id:
// a bloom is a colour frame of the clip below.
const FLOWER0 = 2, BLOOM = 2, DEAD = 4;
const FLOWER_Y = 9; // sprite centre above the plot; the frame's foot is empty
const PEGAPOO = 5;
const PEGAPOO_BIG = 6; // the same pile at 128px, for the title screen
const ICON_POO = 7, ICON_POPPY = 8; // the same two at 12px, for the meters
const PEGAPOO_Y = 8; // sprite centre above the pile's resting point (p.y + 2)
const POO_DX = 15; // how far a pile lands from the plot it came off, px

// Clip ids, in the order concatenated above.
const POPPY0 = 0, POPPY_COLORS = 6;
const PEGA0 = POPPY_COLORS, PEGA_FRAMES = 4, PEGA_FPS = 10;
const INF0 = PEGA0 + PEGA_FRAMES, INF_FRAMES = 6;
// The hero clip is three poses in one strip: HERO0 walks, HOLD0 walks with the
// near arm out carrying the hose, HANG is both arms overhead. Only the walk
// cycles, so the modulus is the cycle length and not the clip's frame count.
const HERO0 = INF0 + INF_FRAMES, HERO_FPS = hero[5];
const HERO_WALK = 6, HOLD0 = HERO0 + HERO_WALK, HANG = HERO0 + 12;
// The eat clip starts after the hero's LAST frame, which is the hang pose.
const EAT0 = HANG + 1, EAT_N = pegacornEat[4], EAT_FPS = pegacornEat[5];

const WORLD_W = 960, WORLD_H = 540;
const STEP = 1000 / 120, HS = STEP / 1000; // physics substep: ms, seconds

// Player.
const MOVE = 150; // run speed, px/s
const GRAV = 900; // gravity, px/s^2 (player, unicorns, hose all use it)
const JUMP = 330; // jump launch speed, px/s
const COYOTE = 0.1; // grace time to jump after leaving a ledge, s

// Tank economy.
const TANK_MAX = 100; // tank capacity
const PUMP_COST = 2; // tank per pump click; a 7-click pop costs 14
// 5, not 6, and the reason is narrow. Farming-heavy play never notices the
// tank at all — it idles at 81 of 100, because a bloom that gets eaten drops
// more fuel than putting it back costs. It is AGGRESSIVE play that runs dry:
// modelled at a 2-3 bloom floor the tank averages 25-50, and that is the
// strategy the game actually wants. This makes the change where it is felt.
const SPRAY_COST = 5; // tank per poppy growth stage
// A 2x2-screen world is climbed constantly, so at 5/s most of the tank drained
// into MOVEMENT rather than into the two verbs that are interesting to spend
// on. The tank should read as ammo, not as a toll for existing in the level.
const JET_COST = 3; // tank per second of jetting
const DUST_N = 20; // dust motes a pop scatters; each is one coin
const DUST_DRAG = 1.6; // how fast a mote sheds the throw, per second
const DUST_WOB = 26; // wander speed of the float, px/s^2
const POO_V = 25; // tank a pile refills — a quarter tank, about one pop's pumping
// Piles used to sit on the farm for ever, so every wave's fuel was still
// banked in the grass and the tank idled near full. Generous, but finite:
// long enough to finish a fight and come back, short enough that a wave you
// spend entirely on the far island is a wave whose fuel you do not get.
const POO_LIFE = 45; // s a pile lasts before it rots away

// Jetpack (press jump again airborne, then hold; a/d steer).
const JET_X = 600; // horizontal thrust, px/s^2; kickX decay caps it at /4
const JET_Y = 1500; // vertical thrust, px/s^2; climbs when > GRAV
const JET_VMAX = 280; // upward speed cap while jetting, px/s

// Dust homing. Twenty motes a pop only pays twenty if twenty are collected,
// and floating ones never were, so the upgrade price was guesswork.
const DUST_HOME = 8.5; // life at which a mote starts coming home, s
const DUST_PULL = 700; // homing accel, px/s^2; DUST_DRAG caps the approach

// Hose.
const HOSE_N = 24; // rope points; more = softer, slower
const SEG = 5; // rest length of one segment, px
const REACH = HOSE_N * SEG; // natural rope length; taut past this, px
const HOSE_MAX = REACH * 1.5; // stretch past this runs the break timer, px
const STRETCH_TIME = 1; // s at max stretch before the latch tears
const HIDDEN = 0, OUT = 1, LATCH = 2, RETRACT = 3;
const LAUNCH = 700; // hose launch speed at the tip, px/s
const PULL = 30; // player pull per px of stretch past REACH, px/s^2
const LATCH_TIME = 5; // s to land all clicks before the hose tears free
const RETRACT_TIME = 0.2; // rewind duration on release, s
const LATCH_CD = 0.5; // s before a torn-free hose can latch again
// REVIVING IS PAID IN TIME, NOT IN TANK. Modelled over the real farm, the tank
// sits at ~81 of 100 through a live wave and halving SPRAY_COST moves the
// standing bloom count by 0.1 of 15 — the fuel was never the brake. This is:
// at 0.5 the player spent 41% of the clock stood still spraying and 1% of it
// pumping, which is a farming game with a pegacorn subplot. 0.35 puts about
// two more blooms on the field and hands the time back to the fun verb.
const SPRAY_CD = 0.35; // s between spray splashes from a resting tip
const HOSE_STIFF = 0.5; // constraint stiffness 0-1; higher = stiffer rope
const SNAP_COS = 0.94; // cos 20 deg: launch cone that snaps onto a unicorn
const SPRAY_COS = 0.8; // cos 37 deg: aim cone that pulls the tip to a poppy

// Inflation. HELD, not clicked: the hose pumps on a cadence for as long as the
// button is down, the way spraying a poppy already worked. What the shop buys
// is a shorter cadence — the same seven stages, arriving sooner — rather than
// fewer stages, so a pop always looks like a pop.
const STAGES = 7; // stages to pop, and it never changes
const PUMP_CD = 0.26; // s per stage at level 0
// Four steps of 0.04 rather than three of 0.05: one more thing to buy, landing
// within 0.01 s of the same place, so the ladder got longer and not stronger.
const PUMP_FAST = 0.04; // s off the cadence per upgrade
const PUMP_LVLS = 4; // upgrades available; the last one pumps at 0.10 s
const RSTEP = 2.5; // radius gain per stage, px; buoyant past STAGES/2
const DECAY = 0.7; // s without a pump before one stage leaks

// Scoring and the between-wave report.
const POP_SCORE = 100; // per pegacorn popped
const BLOOM_BONUS = 50; // per bloom still standing when a wave clears
const WILT = 8; // s an eaten stump lasts unfertilized before it dies

// Upgrades, bought on the report with dust. The two halves of a kill are
// LANDING it and FINISHING it, and there is one upgrade for each: HOSE MAGNET
// buys the shot, FASTER PUMP buys the pump. Approach is the bigger half of the
// 3.7 s kill cycle, so the magnet is the one that pays early and the pump is
// the one that compounds.
//
// The magnet is the debt the keyboard build owes. Dropping the mouse for 8-way
// aim meant a shot could not point at an arbitrary angle, and the 20 deg launch
// cone was the whole repayment. This buys more of it: a wider cone, and a tip
// that catches a pegacorn it passes near instead of sailing by.
//
// PRICED AGAINST THE POP, which is now an exact number: motes home, so a pop
// pays all DUST_N of them and nothing is dropped. Wave N sends N pegacorns, so
// a player who pops everything has 10*W*(W+1) dust by the end of wave W.
//
// The seven steps cost 16 * UP_COST between them, so at 60 the tree is 960 —
// about 48 pops, which lands near the end of wave 9. It was five steps at 45,
// or 405, which is 20 pops and done by wave 6: most of a run spent holding
// money that had nothing to buy. Both ladders grew a step rather than only
// getting dearer, so the extra dust buys more choices and not just a longer
// wait for the same ones.
//
// Past the last step dust is dead again, and the honest fix for that is a
// REPEATABLE sink rather than a longer ladder — there was no budget for one.
const UP_COST = 60; // price of the first step; each next one steps up by this
const MAG_LVLS = 3;
const upCost = () => UP_COST * (pumpLvl + 1);
const magCost = () => UP_COST * (magLvl + 1);
const pumpCd = () => PUMP_CD - pumpLvl * PUMP_FAST;
const snapCos = () => SNAP_COS - magLvl * 0.12; // 20 deg, then 35, 46, 55
const latchR = () => 4 + magLvl * 7; // px of catch around the tip: 4, 11, 18, 25

// REPLANT — the sink that never runs out, and the one that fixes endless mode.
// A ladder ends: past its last step dust is dead weight and every wave after
// that earns money with nothing to buy. This is flat, repeatable and priced by
// the damage, so the worse the wave went the more it costs to undo.
//
// It buys the only thing the sweep found to be genuinely scarce, which is TIME
// — never tank, which idles at 81 of 100. Farming and popping compete for one
// clock, and that is why farm-first play stalls out around wave 8. So dust now
// converts straight into permission to play the aggressive way the game wants.
//
// Buying it twice over is self-limiting: the second one has nothing to fix and
// costs nothing, because the price IS the count of what is down.
const REPLANT = 25; // dust per plot restored
const replantCost = () => REPLANT * (flowers.length - blooms().length);

// Unicorns.
const ARRIVE = 0, EAT = 1, PANIC = 2;
const UNI_SPD = 70; // flight speed, px/s
const EAT_TIME = 3; // s to eat one bloom down to a stump, at wave 0
// EAT_TIME IS THE CEILING, so it is the one that has to move. The farm is 15
// plots and never more, and `retarget` picks at random, so the flock's eating
// force is min(concurrency, standing blooms) — at the 2-3 bloom floor that
// aggressive play sits on, effective eaters are 2.95 at wave 15 and 3.00 at
// wave 30. Wave 15 to 30 is 79% more pegacorns for 1.7% more pressure, and
// THAT is where the difficulty stopped, not at the old concurrency cap.
// Neither count, concurrency nor speed can pass it: the eat cycle is
// 317/v + EAT_TIME, so speed only buys back flight time and the rate tends to
// blooms/EAT_TIME however fast they fly. Shrinking EAT_TIME moves the
// asymptote itself, which is why it is the only term that reaches the player
// who has already stripped the farm. Halves by wave EAT_W, thirds at twice
// that, and never reaches zero — an endless mode still has to win eventually.
const EAT_W = 15;
const eatTime = () => EAT_TIME / (1 + wave / EAT_W);
const WAVE_MAX = 30; // most pegacorns one wave may send
// THE BLACK ONES. The escalation the wave counter alone could not give. From
// wave 6 a growing share of the flock arrives dark and faster, so a late wave
// is a different fight and not the same fight for longer.
//
// The art is the white pegacorn under a canvas INVERT filter, and `lit` is the
// flag for it — 1 normal, 0 inverted. Inverting rather than blacking out is
// what keeps the rainbow tail readable: the white body flips to near-black, so
// it still reads as the dark variant at a glance, but the tail flips to its
// complement instead of going flat, so the one thing the game is named after
// stays coloured. brightness(0) threw all of that away for the same silhouette. A baked black variant would cost nothing in
// the zip and 14 more parts of march per frame at boot; this costs neither.
const DARK_SPD = 1.6; // flight speed multiplier for a black one
const SPAWN_GAP = 1.8; // s between spawns inside a wave

// CONCURRENCY, NOT COUNT, is what the player's throughput actually fights.
// Measured on this farm: a pegacorn eats a bloom every 7.5 s (317 px of mean
// plot spacing at 70 px/s, plus EAT_TIME) and a kill cycle is about 3.7 s, so
// two on the field is break-even and the wave is unwinnable past three. A fixed
// 2.5 s spawn gap is 0.4 arrivals a second against a best-case 0.375 kills a
// second, so the field used to fill during EVERY wave at EVERY skill level.
// The wave's number is now how many come; this is how many at once, so a late
// wave is a longer fight instead of an impossible one.
//
// STEEPER, at wave/2 rather than wave/3, and the spawn gap came down with
// it. Wave 18 was where a good player stopped being pushed: eight on the field
// was the whole late game, and a 2.5 s gap meant half a minute of trickle to
// reach even that. Eleven at wave 18 and a 1.8 s gap make the same wave a
// crowd rather than a queue.
//
// NO CEILING, and that is what keeps the curve moving. SPEED ALONE CANNOT RAMP:
// the eat cycle is 317/v + eatTime() and tends to eatTime() as v grows, so once
// concurrency stopped at 8 the whole escalation flattened — wave 18 to wave 30
// bought only 12% more eating however fast they flew. Concurrency is linear in
// the wave forever, so an endless run ends.
const LIVE0 = 2, LIVE_W = 2;
const liveCap = () => LIVE0 + wave / LIVE_W;

// A METER, NOT A SWITCH, and that is the whole late game. It used to refill to
// full the instant anything was in bloom, so the only thing survival actually
// asked was that you touch a plot once every GRACE seconds — which is why a
// player could park on two plots at the bottom of the map and grind wave 18
// down for ever. Every escalation the game has (eatTime, liveCap, DARK_SPD,
// stacking eaters) pushes on the STANDING BLOOM COUNT, and a boolean sampled
// off that count threw all of it away.
//
// So: a bloom on the field wins the clock back at a second per second, an empty
// farm spends it at the same rate, and the loss is the meter reaching zero. The
// requirement becomes THE FARM MUST BE IN BLOOM MORE THAN HALF THE TIME, which
// is the same sentence at every wave and gets harder on its own as the flock
// eats faster. Nothing here scales with the wave — it does not need to.
//
// Early waves never see it: 15 blooms against 1-5 pegacorns pins the meter at
// full. It only bites once the flock can strip the farm faster than the hose
// puts it back, which is exactly where the difficulty used to stop.
const GRACE = 8;

// The pop is CROWD CONTROL as well as money. Anything this close loses the
// bloom it was on and is shoved off it, which costs it a whole flight back — so
// a pop placed inside a cluster buys far more time than a lone one does.
const POP_R = 110;

// Beam.
const BEAM_T = 9; // how long a POP's shaft outlives it, s — dust floats for 10
const BEAM_MAX = 3; // most flier shafts at once; past this the world is updraft
const BEAM_VY = 160; // max rise speed inside a beam, px/s
const BEAM_W = 44, BEAM_HW = BEAM_W / 2; // shaft width and its half, px
// Per SUBSTEP, and the substep runs 120 times a second — so this is 480 motes
// a second, and at a 1.5 s life about 720 alive per beam. It was 26, which is
// 4,700 alive: a wall of flecks that buried the gradient it was meant to
// sparkle over, and 4,700 strokes a frame for scenery. The jet and hose
// emitters beside it are gated by a coin flip; this one never was.
const BEAM_N = 2;

const PW = 10, PH = 14;
// PICKUP REACH, measured out from that body box — and it is not the body that
// matters here, it is the art. The farmer's box is 10x14 but the sprite drawn
// over it is 26x39: it overhangs 8 px each side, 22 above and 3 below. The
// reach was 4 px, so a mote could sit well inside the farmer you can see and
// not be collected. These put it 2 px outside the art on every edge.
const PICK_X = 10, PICK_UP = 24, PICK_DN = 5;
const SPAWN_X = 470, SPAWN_Y = 440 - PH;

// Platforms [x, y, w, h] and poppy plots [x, top y] come from the stage file
// at init.
let plats, plots;

let ctx, W, H, keys, font, big, art, bank, loading, started;
let mode; // 0 play, 1 lost
let px, py, vx, vy, kickX, grounded, coyote, tank, airPress, jetting, walkT;
let camX, camY, acc, time;
let shake, flash, flashX, flashY; // pop kick: camera offset px, bloom alpha, bloom centre
// `hoseT` is ONE cadence for both of the hose's jobs — you cannot spray and
// pump at the same moment, so they share the timer.
let hose, hoseState, hoseLen, latchT, retractT, latchCd, hoseT, stretchT;
let unis, latched, graceT;
let flowers, picks, beams, rings, particles;
let wave, spawnQ, spawnT, waveDone, score, kills;
let coins, pumpLvl, magLvl, sel;
let inp, facing, prevJump, prevFire, prevDrop, prevMy;

/**
 * One poll for every device; the game reads only this shape. Two buttons and
 * a d-pad: aim is the d-pad when it is held, and the facing when it is not.
 */
function poll() {
  const left = keys.has('a') || keys.has('arrowleft');
  const right = keys.has('d') || keys.has('arrowright');
  const up = keys.has('w') || keys.has('arrowup');
  const down = keys.has('s') || keys.has('arrowdown');
  const jumpKey = keys.has('z') || keys.has('n') || up;
  const fireKey = keys.has('x') || keys.has('m') || keys.has(' ');
  const mx = (right ? 1 : 0) - (left ? 1 : 0);
  const my = (down ? 1 : 0) - (up ? 1 : 0);
  if (mx) facing = mx;
  const ax = mx || my ? mx : facing, ay = my;
  const l = Math.hypot(ax, ay) || 1;
  inp = {
    mx,
    jump: jumpKey && !prevJump,
    jumpHeld: jumpKey,
    nav: my && !prevMy ? my : 0,
    dropEdge: down && !prevDrop,
    aimX: ax / l,
    aimY: ay / l,
    fire: fireKey,
    fireEdge: fireKey && !prevFire,
    // Deliberately NOT a play key, and deliberately not an edge: the loss
    // screen is the one place a stray mash of the buttons you were just
    // hammering should not skip past what it says.
    retry: keys.has('r'),
  };
  prevJump = jumpKey;
  prevFire = fireKey;
  prevDrop = down;
  prevMy = my;
}

function resetHose() {
  hose = [];
  for (let i = 0; i < HOSE_N; i++) {
    hose.push({ x: px + PW / 2, y: py + 5 + i * 2, ox: px + PW / 2, oy: py + 5 + i * 2 });
  }
  hoseState = HIDDEN;
  hoseLen = HOSE_N;
}

// Draws sprite `id` of sheet source `src` centred on cx,cy, mirrored when
// facing left.
function sprite(id, cx, cy, flip, src = CLIP_SRC) {
  const s = art.srcs[src], t = s.rects, i = id * 4, w = t[i + 2], h = t[i + 3];
  const x = (cx - w / 2) | 0, y = (cy - h / 2) | 0;
  if (flip) {
    ctx.save();
    ctx.translate(x + w, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(s.canvas, t[i], t[i + 1], w, h, 0, y, w, h);
    ctx.restore();
  } else ctx.drawImage(s.canvas, t[i], t[i + 1], w, h, x, y, w, h);
}

function spawnUni() {
  const fromLeft = Math.random() < 0.5;
  unis.push({
    x: fromLeft ? -30 : WORLD_W + 30,
    y: 60 + Math.random() * 120,
    vx: 0, vy: 0,
    facing: fromLeft ? 1 : -1, // 1 = right, -1 = left
    stage: 0, state: ARRIVE,
    lit: Math.random() * 20 < wave - 5 ? 0 : 1,
    tgt: null, eatT: 0, decayT: 0, thrashT: 0,
    bob: Math.random() * 7,
  });
}

function uniR(u) {
  return 9 + u.stage * RSTEP; // 9 = deflated radius, px
}

function blooms() {
  return flowers.filter(f => f.s === BLOOM);
}

// BEST OF TWO DRAWS, FARTHER FROM THE FARMER WINS. Uniform picking made
// camping strictly better: strip the farm to two plots at your feet and the
// whole flock flies to your hose for free, so concurrency became a delivery
// rate rather than a threat.
//
// It is NOT a stripped-farm punishment, which is the shape that failed when
// targets were claimed — with two blooms both under the player this does
// nothing at all. It bites only once the meter forces a WIDE farm, and what it
// costs then is the player's travel, not the flock's eat rate. A term that
// punishes standing still, not a term that punishes being behind.
function retarget(u) {
  const b = blooms(), p = () => b[Math.random() * b.length | 0], a = p(), c = p();
  u.tgt = b.length ? (Math.abs(a.x - px) > Math.abs(c.x - px) ? a : c) : null;
}

function unlatch() {
  latched = null;
  latchCd = LATCH_CD;
  hoseState = inp.fire ? OUT : RETRACT;
  retractT = RETRACT_TIME;
}

/**
 * `beam` is two flag BITS, not three kinds: 1 rises (no gravity, no drag), 2
 * draws bright. It was an enum until the pop wanted glitter, which is the one
 * combination an enum did not have — heavy AND bright. So: 0 a spark, 1 a
 * shaft mote, 2 glitter, 3 the steam off a pile.
 */
/**
 * Every rainbow shaft on the field right now, as [x, alpha].
 *
 * TWO KINDS, ONE LIST. A shaft belongs to a pegacorn that is IN THE AIR and
 * goes out the moment it lands on a bloom — so the absence of a shaft is what
 * marks the one eating your crop, and a shaft is something you can ride to
 * reach a flier rather than a prize for having already killed one. It moves
 * with its owner, which makes an intercept a chase.
 *
 * A pop still leaves a STATIC one behind, because the dust cloud hangs in the
 * air where the pegacorn was and that shaft is the way up to it. Tying every
 * shaft to a living flier would destroy the lift at the exact moment the money
 * appeared.
 *
 * The cap is the whole reason this is playable: fliers cross in 3-12 s and eat
 * for 3, so wave 20 has about fourteen airborne — 632 px of a 960 px world, or
 * more shaft than screen. Three is about the density of wave 6.
 *
 * Derived per call rather than stored, so no beam can outlive its owner or
 * need cleaning up when one pops.
 */
function shafts() {
  const out = [];
  for (const u of unis) if (u.state !== EAT && out.length < BEAM_MAX) out.push([u.x, 1]);
  for (const b of beams) out.push([b.x, Math.min(1, b.t)]);
  return out;
}

function spawnParticle(x, y, vx, vy, hue, life, beam, w = 1.5) {
  particles.push({ x, y, vx, vy, hue, life, maxLife: life, beam, w });
}

/**
 * The payoff. One shockwave, a rainbow bloom over the frame, a kicked camera,
 * and a 90-piece SHELL thrown hard and evenly — the particle draw trails each
 * piece along its own velocity, so speed IS length and no second draw path is
 * needed. The twenty dust motes scatter with it and then home to the player,
 * which is the afterglow a separate glitter population used to provide.
 */
function pop(u) {
  // ONE shockwave, not two. The tight fast ring lived 0.32 s under a 122-piece
  // burst thrown off the same centre and nothing could pick it out.
  rings.push({ x: u.x, y: u.y, t: 0.7, d: 0.7, r: 240 });
  flash = 0.95;
  flashX = u.x;
  flashY = u.y;
  shake = 15;
  beams.push({ x: u.x, t: BEAM_T });
  // Thrown out evenly rather than up: a mote does not fall, it hangs where the
  // pegacorn was and drifts, so the cloud stays a cloud and the lift beam under
  // it is how you get up into the money. `ph` is its own phase, which keeps the
  // flashing and the wander from marching in step across twenty of them.
  for (let i = 0; i < DUST_N; i++) {
    const a = Math.random() * Math.PI * 2, s = 40 + Math.random() * 120;
    picks.push({
      x: u.x, y: u.y,
      vx: Math.cos(a) * s, vy: Math.sin(a) * s,
      life: 10, ph: Math.random() * 99,
    });
  }
  for (let i = 0; i < 90; i++) {
    const a = Math.random() * Math.PI * 2, s = 130 + Math.random() * 230;
    spawnParticle(u.x, u.y, Math.cos(a) * s, Math.sin(a) * s,
      (i * 5) % 360, 0.8 + Math.random() * 0.7, 0, 4);
  }
  playSound(bank[PEGAPOP], 1, 0, 0.5);
  kills++;
  score += POP_SCORE;
  unis.splice(unis.indexOf(u), 1);
  // The shockwave is the crowd control: losing the bloom costs a whole flight
  // back. A PANIC one is skipped, or it would fly off still inflated and never
  // run the decay that only its own state does.
  for (const o of unis) {
    if (o.state !== PANIC && Math.hypot(o.x - u.x, o.y - u.y) < POP_R) {
      o.state = ARRIVE;
      o.tgt = null;
    }
  }
  unlatch();
}

// A full-spectrum ring, thrown outward. One per state a poppy gains back.
//
// FLAG 1, WHICH IS THE RISER BIT, AND IT IS DOING TWO JOBS HERE. It buys no
// gravity and no drag, so a ray leaves at full speed and holds it until the
// alpha runs out — the burst punches out instead of arcing over and sagging,
// which is what made a revive read as a puff rather than as a payoff. The
// gravity term is shared with the pop's 90-piece shell, so it could not be
// turned down globally; the per-particle flag is the only lever that reaches
// one and not the other.
//
// Its second job is the colour. The draw runs the hue as a FALLING spark ages
// and leaves a riser's alone — and this ring already hands every ray its own
// angle-matched hue, so holding it is what makes the thing a spectrum starburst
// instead of 36 pieces all cycling through the same wheel together.
//
// The up-bias on vy survives with no gravity to cancel it, so the whole ring
// drifts up as it expands. On a plot coming back into bloom that is the right
// direction.
function rainbow(x, y, n, speed, life) {
  for (let i = 0; i < n; i++) {
    const a = i / n * Math.PI * 2, v = speed * (0.6 + Math.random() * 0.7);
    spawnParticle(x, y, Math.cos(a) * v, Math.sin(a) * v - speed * 0.3,
      i / n * 360 | 0, life, 1);
  }
}

// Launch along the aim, snapped onto a unicorn that sits inside a narrow
// cone — 8-way aim cannot point at an arbitrary angle, so the cone pays
// back what the d-pad rounds off. The tip must still travel and touch it.
function launchHose() {
  hoseState = OUT;
  latchCd = 0;
  const gx = px + PW / 2 + facing * 6, gy = py - 3;
  let lx = inp.aimX, ly = inp.aimY, best = snapCos();
  for (const u of unis) {
    const dx = u.x - gx, dy = u.y - gy, d = Math.hypot(dx, dy) || 1;
    if (d > REACH) continue;
    const dot = (dx * inp.aimX + dy * inp.aimY) / d;
    if (dot > best) { best = dot; lx = dx / d; ly = dy / d; }
  }
  for (let i = 1; i < HOSE_N; i++) {
    const p = hose[i], v = LAUNCH * (i / (HOSE_N - 1)) * HS;
    p.x = gx + lx * i * 0.5;
    p.y = gy + ly * i * 0.5;
    p.ox = p.x - lx * v;
    p.oy = p.y - ly * v;
  }
}

// The sprayable poppy nearest the aim direction, inside the assist cone.
function sprayTarget(gx, gy) {
  let best = SPRAY_COS, out = null;
  for (const f of flowers) {
    if (f.s >= BLOOM) continue;
    const dx = f.x - gx, dy = f.y - 5 - gy, d = Math.hypot(dx, dy) || 1;
    if (d > REACH) continue;
    const dot = (dx * inp.aimX + dy * inp.aimY) / d;
    if (dot > best) { best = dot; out = f; }
  }
  return out;
}

function collidePoint(p) {
  for (const [bx, by, bw, bh] of plats) {
    if (p.x > bx && p.x < bx + bw && p.y > by && p.y < by + bh) {
      const dl = p.x - bx, dr = bx + bw - p.x, dtp = p.y - by, db = by + bh - p.y;
      const m = Math.min(dl, dr, dtp, db);
      if (m === dtp) { p.y = by; p.oy = p.y; p.ox += (p.x - p.ox) * 0.5; }
      else if (m === db) { p.y = by + bh; p.oy = p.y; }
      else if (m === dl) { p.x = bx; p.ox = p.x; }
      else { p.x = bx + bw; p.ox = p.x; }
    }
  }
}

function stepHose(h) {
  const gx = px + PW / 2 + facing * 6 + inp.aimX * 9, gy = py - 3 + inp.aimY * 9;
  const p0 = hose[0];
  p0.x = p0.ox = gx;
  p0.y = p0.oy = gy;
  if (hoseState === HIDDEN) return;

  if (hoseState === RETRACT) {
    // Rewind: every point chases the one before it, back into the gun.
    retractT -= h;
    const k = Math.min(1, 25 * h);
    for (let i = 1; i < hoseLen; i++) {
      const p = hose[i], q = hose[i - 1];
      p.x += (q.x - p.x) * k;
      p.y += (q.y - p.y) * k;
      p.ox = p.x;
      p.oy = p.y;
    }
    if (retractT <= 0) hoseState = HIDDEN;
    return;
  }

  hoseLen = HOSE_N;
  const activeN = hoseLen;

  for (let i = 1; i < activeN; i++) {
    const p = hose[i];
    const nx = p.x + (p.x - p.ox) * 0.99;
    const ny = p.y + (p.y - p.oy) * 0.99 + GRAV * 0.7 * h * h;
    p.ox = p.x; p.oy = p.y;
    p.x = nx; p.y = ny;
    collidePoint(p);
  }

  // Aim assist: when a sprayable poppy sits in the aim cone within reach,
  // the tip steers toward it instead of dangling. Spraying is chores, so
  // it gets the help; latching a unicorn stays a real shot.
  if (hoseState === OUT) {
    const f = sprayTarget(gx, gy);
    if (f) {
      const tp = hose[activeN - 1];
      const k = Math.min(1, 10 * h); // tip homing rate, 1/s
      tp.x += (f.x - tp.x) * k;
      tp.y += (f.y - 5 - tp.y) * k;
    }
  }

  const tip = hose[activeN - 1];
  // IN BY THE TAIL. The tip used to pin to the pegacorn's centre, so the hose
  // read as skewering it through the middle whichever way it was pointing.
  // Offset against `facing` and it lands on the rear of a 70x46 frame — and
  // because the sprite is mirrored off that same flag, the joint stays at the
  // back end through every thrash that flips it.
  if (hoseState === LATCH) { tip.x = latched.x - latched.facing * 18; tip.y = latched.y + 3; }

  for (let it = 0; it < 3; it++) {
    for (let i = 0; i < activeN - 1; i++) {
      const a = hose[i], b = hose[i + 1];
      const wa = i === 0 ? 0 : 1;
      const wb = (i + 1 === activeN - 1 && hoseState === LATCH) ? 0 : 1;
      if (!(wa + wb)) continue;
      const dx = b.x - a.x, dy = b.y - a.y;
      const d = Math.hypot(dx, dy) || 1;
      const ex = (d - SEG) / d / (wa + wb) * HOSE_STIFF;
      a.x += dx * ex * wa; a.y += dy * ex * wa;
      b.x -= dx * ex * wb; b.y -= dy * ex * wb;
    }
  }

  if (hoseState === LATCH) {
    // Slack rope pulls nothing. A taut rope hauls the player toward the
    // unicorn — a drag on the ground, a carry once a buoyant one wins —
    // and the unicorn feels a light reaction tug.
    const u = latched;
    const dxr = u.x - gx, dyr = u.y - gy;
    const rope = Math.hypot(dxr, dyr) || 1;
    const excess = rope - REACH;
    if (excess > 0) {
      // A DARK ONE HAULS. It already flies at DARK_SPD, and the same number is
      // reused rather than a second constant — the packer pays almost nothing
      // for a repeat, and "a black one is 1.6x the animal" is one rule instead
      // of two. Felt on the rope: it drags the farmer off a ledge where a white
      // one only leans on them, so the late flock changes how a latch plays and
      // not just how fast it arrives.
      const F = excess * PULL * (u.lit ? 1 : DARK_SPD);
      kickX += dxr / rope * F * h;
      vy += dyr / rope * F * h;
      u.vx -= dxr / rope * F * 0.1 * h;
      u.vy -= dyr / rope * F * 0.1 * h;
      // The taut rope transmits the balloon's lift: most of the player's
      // weight hangs off the unicorn, so it can actually carry them.
      if (u.stage >= STAGES / 2) vy -= GRAV * 0.85 * h;
    }
    latchT -= h;
    if (rope > HOSE_MAX) stretchT += h;
    else stretchT = Math.max(0, stretchT - 2 * h);
    if (stretchT >= STRETCH_TIME || inp.dropEdge || latchT <= 0) unlatch();
    return;
  }

  // OUT: the tip latches a unicorn, or sprays the poppy it rests on.
  latchCd -= h;
  hoseT -= h;
  if (latchCd <= 0) {
    for (const u of unis) {
      if (Math.hypot(tip.x - u.x, tip.y - u.y) < uniR(u) + latchR()) {
        latched = u;
        u.state = PANIC;
        u.thrashT = 0;
        hoseState = LATCH;
        hoseLen = HOSE_N;
        latchT = LATCH_TIME;
        stretchT = 0;
        return;
      }
    }
  }
  if (hoseT <= 0 && tank >= SPRAY_COST) {
    for (const f of flowers) {
      if ((f.dead || f.s < BLOOM) && Math.hypot(tip.x - f.x, tip.y - f.y + 5) < 12) {
        // A dead plot revives AND grows on the same spray, so dead-to-bloom is
        // two sprays like every other revive. The third spray it used to cost
        // landed on 55% of all revives, which is most of where "reviving is
        // expensive" came from — and it was expensive in time, not in tank.
        f.dead = false;
        f.s++;
        f.wiltT = WILT;
        tank -= SPRAY_COST;
        hoseT = SPRAY_CD;
        rings.push({ x: f.x, y: f.y - 6, t: 0.25, d: 0.25, r: 40 });
        rainbow(f.x, f.y - 10, 36, 190, 0.6);
        // A step up the scale per state, so a plot you bring all the way back
        // from dead plays three rising notes and the bloom is the top one.
        playSound(bank[POWERUP], 1 + f.s * 0.3, 0, 0.3);
        break;
      }
    }
  }
  if (!inp.fire) {
    hoseState = RETRACT;
    retractT = RETRACT_TIME;
  }
}

function stepUni(u, h) {
  if (u === latched) u.state = PANIC;

  if (u.state === ARRIVE) {
    if (!u.tgt || u.tgt.s !== BLOOM) retarget(u);
    let tx = WORLD_W / 2, ty = 90; // idle hover point when no bloom exists
    if (u.tgt) { tx = u.tgt.x; ty = u.tgt.y - 13; }
    const dx = tx - u.x, dy = ty - u.y;
    const d = Math.hypot(dx, dy) || 1;
    if (u.tgt && d < 4) {
      u.x = tx; u.y = ty;
      u.state = EAT;
      u.eatT = eatTime();
    } else {
      // SPEED IS THE ESCALATION. Flight is 60% of a pegacorn's 7.5 s cycle at
      // the base rate, so raising it has more leverage on the eat rate than
      // anything else does — and a faster one is a longer chase to intercept,
      // which raises the demand on the player at the same time. Without this
      // the eat rate pinned at 0.80 blooms/s from wave 12, when the
      // concurrency ceiling was reached, and every wave after that was the
      // same fight for longer. UNCAPPED on purpose: an endless mode has to
      // win eventually, and this is the only term still climbing once the
      // wave count and the concurrency have both hit their ceilings. A black one
      // multiplies this again, so the flock's mean speed climbs a second time
      // as the share of black ones grows.
      const v = (UNI_SPD + wave * 6) * (u.lit ? 1 : DARK_SPD) * h;
      u.x += dx / d * v;
      u.y += dy / d * v;
      if (Math.abs(dx) > 1) u.facing = dx > 0 ? 1 : -1;
    }
    return;
  }

  if (u.state === EAT) {
    if (!u.tgt || u.tgt.s !== BLOOM) { u.state = ARRIVE; return; }
    // EATERS STACK. Without this the flock gets WEAKER as it wins: when the
    // farm is down to one bloom exactly one pegacorn is eating it and the rest
    // collide or fly, so the last bloom dies at 0.61/s against a player who
    // sprays it back at 1.43/s. Modelled to wave 99 the player NEVER loses at
    // any speed ramp — the loss condition was unreachable, and THAT is the
    // wall, not the wave counter. Sharing the timer turns the wasted collision
    // into focused fire, so the swarm that converges on your last poppy kills
    // it k times faster. Rare early (a big farm spreads them out anyway), so
    // it escalates only where the flattening was.
    u.eatT -= h * unis.filter(o => o.tgt === u.tgt && o.state === EAT).length;
    if (u.eatT <= 0) {
      u.tgt.s = 0;
      u.tgt.wiltT = WILT;
      // Dropped to the side the eater faces, or the pile buries the stump.
      picks.push({
        x: u.tgt.x + u.facing * POO_DX, y: u.tgt.y - 2,
        vx: 0, vy: 0, life: POO_LIFE, b: 1,
      });
      u.state = ARRIVE;
      retarget(u);
    }
    return;
  }

  // PANIC: latched, or torn free but still inflated. Unicorns fly — wingbeats
  // cancel gravity, so a thrasher stays airborne and only a buoyant one drifts
  // up. A free buoyant one rises at 80 px/s and clears the world in about 3.4 s.
  const buoy = u.stage >= STAGES / 2;
  if (buoy) {
    u.vy -= 140 * h; // balloon lift, px/s^2
    if (u.vy < -80) u.vy = -80; // rise speed cap, px/s
  } else {
    u.vy *= 1 - 3 * h; // vertical hover damping
  }
  u.vx *= 1 - 2 * h; // horizontal air drag

  const feet = u.y + uniR(u);
  u.x += u.vx * h;
  u.y += u.vy * h;
  u.x = clamp(u.x, 0, WORLD_W);
  if (u.vy > 0) {
    for (const [bx, by, bw] of plats) {
      if (u.x > bx && u.x < bx + bw && feet <= by + 1 && u.y + uniR(u) >= by) {
        u.y = by - uniR(u);
        u.vy = 0;
      }
    }
  }

  if (u === latched) {
    u.thrashT -= h;
    if (u.thrashT <= 0) {
      u.thrashT = 0.3 + Math.random() * 0.3; // s between thrash impulses
      // A DARK ONE FIGHTS HARDER, on the same 1.6 the rest of it runs on — so
      // 288 sideways and 192 up, which is a bucking animal against a white
      // one's shrug. Written out twice rather than lifted into a local: the
      // packer pays almost nothing for a repeated phrase it has already met on
      // the rope tension, where a new name is real entropy in a new context.
      u.vx += (Math.random() * 2 - 1) * 240 * (u.lit ? 1 : DARK_SPD); // sideways kick, px/s
      u.vy += (Math.random() * 2 - 1) * 160 * (u.lit ? 1 : DARK_SPD); // vertical kick, px/s
    }
  }

  if (Math.abs(u.vx) > 20) u.facing = u.vx > 0 ? 1 : -1;

  // THE SHOO VALVE, and it is the only answer to a crowd that is not a kill.
  // The Dig-Dug leak applies to a rope you are still holding — but let go of a
  // pegacorn that is ALREADY BUOYANT and it keeps its stages and drifts off the
  // top of the world. Four pumps and a release clears one for 8 tank and no
  // dust, against 14 tank and seven stages for the pop that pays. Under crowd
  // pressure that is a real trade: the money, or the time to go and farm.
  //
  // It cuts the other way too. A latch torn loose past half inflation now
  // LOSES you the kill instead of deflating it back onto the crop, so a pump
  // you commit to is a pump you have to finish.
  if (u.stage > 0 && u.stage < STAGES && (u === latched || !buoy)) {
    u.decayT += h;
    if (u.decayT >= DECAY) { u.decayT = 0; u.stage--; }
  } else if (u !== latched && !u.stage) {
    u.state = ARRIVE; // deflated and free — back to the raid
    retarget(u);
  }

  // Off the top buoyant, or off the bottom dead: either way it is gone.
  if (u.y < -60 || u.y > WORLD_H + 80) {
    if (u === latched) unlatch();
    unis.splice(unis.indexOf(u), 1);
  }
}

function stepPicks(h) {
  for (let i = picks.length; i--;) {
    const p = picks[i];
    p.life -= h;
    // A PILE FALLS AND A MOTE FLOATS, and `b` is the tag that says which. It
    // used to be `life > 100` with piles spawned at 1e9, which worked only
    // while they were immortal — a countdown cannot also be a type.
    // The mote sheds its throw and then wanders on two sines of its own phase,
    // so a cloud of twenty never drifts as one body.
    if (p.b) {
      p.vy += GRAV * h;
      // A dropped pile steams rainbow. Flags 1|2: it rises like a shaft mote
      // and draws brighter, which is what picks it out of the grass. Emitted
      // here rather than from its own pass over `picks` in step() — same list,
      // same substep, one loop.
      if (Math.random() < 0.35) {
        spawnParticle(p.x + (Math.random() - 0.5) * 14, p.y - 6,
          0, -25 - Math.random() * 30, Math.random() * 360 | 0, 1.4, 3);
      }
    } else {
      const d = 1 - DUST_DRAG * h, a = time * 2 + p.ph, w = DUST_WOB * h;
      p.vx = p.vx * d + Math.sin(a) * w;
      p.vy = p.vy * d + Math.cos(a) * w;
      // The scatter gets its second and a half, then every mote comes home.
      if (p.life < DUST_HOME) {
        const dx = px + PW / 2 - p.x, dy = py + PH / 2 - p.y, m = Math.hypot(dx, dy) || 1;
        p.vx += dx / m * DUST_PULL * h;
        p.vy += dy / m * DUST_PULL * h;
      }
      // A spark every few substeps, smaller than anything the burst throws.
      if (Math.random() < 0.06) {
        spawnParticle(p.x, p.y, p.vx * 0.5, p.vy * 0.5,
          Math.random() * 360 | 0, 0.35, 1, 0.8);
      }
    }
    const feet = p.y + 2;
    p.x += p.vx * h;
    p.y += p.vy * h;
    if (p.b && p.vy > 0) {
      for (const [bx, by, bw] of plats) {
        if (p.x > bx && p.x < bx + bw && feet <= by + 1 && p.y + 2 >= by) {
          p.y = by - 2;
          p.vy = 0;
          p.vx *= 0.6;
        }
      }
    }
    if (p.life <= 0 || p.y > WORLD_H + 60) {
      picks.splice(i, 1);
    } else if (p.x > px - PICK_X && p.x < px + PW + PICK_X
      && p.y > py - PICK_UP && p.y < py + PH + PICK_DN) {
      // `life` is the type tag: a pile never expires, a mote lives 10 s.
      if (p.b) tank = Math.min(TANK_MAX, tank + POO_V); else coins++;
      rings.push({ x: p.x, y: p.y, t: 0.25, d: 0.25, r: 30 });
      playSound(bank[POWERUP], 1, 0, p.b ? 0.5 : 0.25);
      picks.splice(i, 1);
    }
  }
}

function stepParticles(h) {
  for (let i = particles.length; i--;) {
    const p = particles[i];
    p.life -= h;
    if (!(p.beam & 1)) {
      p.vy += GRAV * 0.3 * h;
      p.vx *= 1 - 0.5 * h;
      p.vy *= 1 - 0.5 * h;
    }
    p.x += p.vx * h;
    p.y += p.vy * h;
    if (p.life <= 0) particles.splice(i, 1);
  }
}

function startWave() {
  spawnQ = Math.min(WAVE_MAX, ++wave);
  spawnT = 0;
  waveDone = false;
  sel = 0;
}

// The report OWNS the pad while it is up, but not the clock: the farm keeps
// running behind the panel, and only the player's own controls are taken away.
// A stopped world reads as a hung game, where a still farmer reads as waiting.
function stepMenu() {
  if (!waveDone) {
    waveDone = true;
    // The clearing bonus is not paid at once: the surviving blooms are queued
    // and counted off one at a time into the score, missile-command style.
    score += BLOOM_BONUS * blooms().length;
    // AND THE CLOCK IS GIVEN BACK. The farm keeps running behind the panel but
    // the menu eats `fire`, so a wave cleared on an empty field used to hand
    // the player a draining meter and no spray to answer it with — a loss on
    // the shop screen, with REPLANT the only out. Clearing the wave is the
    // thing that earns the reset.
    graceT = GRACE;
  }
  if (inp.nav) sel = (sel + 4 + inp.nav) % 4;
  if (inp.fireEdge) {
    let cost = 0;
    if (!sel && pumpLvl < PUMP_LVLS && coins >= upCost()) cost = upCost(), pumpLvl++;
    else if (sel === 1 && magLvl < MAG_LVLS && coins >= magCost()) cost = magCost(), magLvl++;
    // Priced before the loop runs, because the loop is what empties the count
    // the price is made of.
    else if (sel === 2 && replantCost() && coins >= replantCost()) {
      cost = replantCost();
      for (const f of flowers) { f.dead = false; f.s = BLOOM; f.wiltT = WILT; }
    } else if (sel === 3) startWave();
    if (cost) {
      coins -= cost;
      // The report is screen space and particles are world space, so the burst
      // is placed at the camera-relative point the upgrade rows are drawn at.
      playSound(bank[POWERUP], 1.5, 0, 0.5);
      rainbow(camX + W / 2, camY + 112, 30, 90, 0.8);
    }
  }
  // Eaten, not just ignored: the farmer still falls and still lands, but every
  // press the menu took is spent before the play step can read it.
  inp.mx = inp.jump = inp.jumpHeld = inp.fire = inp.fireEdge = inp.dropEdge = false;
}

function step(h) {
  time += h;
  if (!spawnQ && !unis.length && wave) stepMenu();
  stepPlay(h);
  inp.jump = inp.fireEdge = inp.dropEdge = inp.nav = false;
}

function stepPlay(h) {
  vx = inp.mx * MOVE;
  // Only running feet advance the walk, or a standing farmer moonwalks.
  if (grounded && inp.mx) walkT += h; else walkT = 0;
  vy += GRAV * h;
  kickX *= 1 - 4 * h;
  // Both decay fast enough to be a hit rather than a wobble.
  if (shake > 0) shake -= 30 * h;
  if (flash > 0) flash -= 9 * h;

  for (let i = beams.length; i--;) if ((beams[i].t -= h) <= 0) beams.splice(i, 1);
  // ONE shaft lifts, not all of them: overlapping shafts used to stack their
  // anti-gravity, and with several on the field at once that was a launch.
  // The beams are off while the report is up, or the farmer keeps riding one
  // out of the level behind the panel with the pad already taken away.
  if (spawnQ || unis.length || !wave) for (const [x] of shafts()) {
    if (Math.abs(px + PW / 2 - x) < BEAM_HW) {
      vy -= (GRAV + 250) * h; // beam lift beats gravity by 250 px/s^2
      if (vy < -BEAM_VY) vy = -BEAM_VY;
      break;
    }
  }

  const feet = py + PH;
  px += (vx + kickX) * h;
  py += vy * h;
  px = clamp(px, 0, WORLD_W - PW);

  grounded = false;
  if (vy >= 0) {
    for (const [bx, by, bw] of plats) {
      if (px + PW > bx && px < bx + bw && feet <= by + 1 && py + PH >= by) {
        py = by - PH;
        vy = 0;
        grounded = true;
        coyote = COYOTE;
      }
    }
  }
  if (!grounded) coyote -= h;

  if (grounded) airPress = false;
  if (inp.jump) {
    if (coyote > 0) { vy = -JUMP; coyote = 0; playSound(bank[JUMP_SFX], 1, 0, 0.35); }
    // The pack cannot fire on a dry tank, and the floor is a long way under the
    // lowest plot. So an air press with nothing to burn becomes a second JUMP,
    // which is free and always enough to get back to a platform. `airPress`
    // clears on landing, so it is one per airtime.
    else if (!airPress) {
      airPress = true;
      if (tank < 1) { vy = -JUMP; playSound(bank[JUMP_SFX], 1, 0, 0.35); }
    }
  }

  if (inp.fireEdge && hoseState === HIDDEN) launchHose();
  // HELD. The timer only runs while a pump is actually possible, so letting go
  // and grabbing again pumps at once instead of waiting out a cooldown nobody
  // saw. Each stage reads a semitone higher, so a fill is audible as well as
  // visible and the stage before the pop is the highest.
  if (hoseState === LATCH && latched && inp.fire && tank >= PUMP_COST
    && (hoseT -= h) <= 0) {
    // A DARK ONE TAKES 1.6 TIMES AS LONG TO FILL, on the same number as its
    // speed, its haul and its thrash. The cadence and not the stage count:
    // STAGES is 7 for everything, so a pop still looks like a pop and the
    // inflate clip still runs its six frames — what changes is how long you
    // are stood there holding a bucking animal to get it. Time on the rope IS
    // the fight, and the fight is the thing that was over too quickly.
    hoseT = pumpCd() * (latched.lit ? 1 : DARK_SPD);
    tank -= PUMP_COST;
    latched.stage++;
    playSound(bank[PUMP], 1 + latched.stage * 0.06, 0, 0.4);
    latched.y -= RSTEP; // swell upward, never through the floor
    latched.vy -= 40;
    latched.decayT = 0;
    if (latched.stage >= STAGES) pop(latched);
  }

  // Jetpack: ONE hold does the whole climb. The jump leaves the ground and the
  // pack takes over as soon as the feet are off it, so the pack needs no press
  // of its own — the tank is the only thing that stops it.
  jetting = !grounded && inp.jumpHeld && tank > 0;
  if (jetting) {
    tank = Math.max(0, tank - JET_COST * h);
    kickX += inp.mx * JET_X * h;
    vy -= JET_Y * h;
    if (vy < -JET_VMAX) vy = -JET_VMAX;
    // The pump sound at a fifth of its rate is a rumble, and overlapping
    // copies at random spacing make it one roar rather than a tick. Gated on a
    // coin flip like the jet's own particles, so it needs no timer.
    //
    // KEEP THE GATE LOW. The pump buffer is 4 s (mostly silence after the
    // click) and nothing stops a source early, so at rate 0.22 every copy holds
    // a voice for 18 s. At this rate that is ~3 audible copies over each other
    // and ~65 live sources during a long burn; doubling it doubles both.
    if (Math.random() < 0.03) playSound(bank[PUMP], 0.22, 0, 0.18);
  }

  // An unfertilized stump dies. It is still replantable, so the farm is only
  // emptied, never destroyed — it just costs a spray to bring back.
  for (const f of flowers) {
    if (f.s || f.dead) continue;
    f.wiltT -= h;
    if (f.wiltT <= 0) f.dead = true;
  }

  if ((graceT = clamp(graceT + (blooms().length ? 1 : -1) * h, 0, GRACE)) <= 0) mode = 1;

  // Wave loop: spawn the queue against the concurrency cap, then rest until
  // the field is clear. The gap timer only runs while there is room, so the
  // wave paces itself to how fast the player is clearing it.
  if (spawnQ > 0 && unis.length < liveCap()) {
    spawnT -= h;
    if (spawnT <= 0) { spawnUni(); spawnQ--; spawnT = SPAWN_GAP; }
  }

  for (let i = unis.length; i--;) stepUni(unis[i], h);
  stepPicks(h);
  stepHose(h);
  stepParticles(h);

  for (let i = rings.length; i--;) {
    rings[i].t -= h;
    if (rings[i].t <= 0) rings.splice(i, 1);
  }

  // The plume, spent down to what actually reads. It was twelve particles a
  // frame steered by a sin/cos cone; the cone was invisible under a jet that
  // is already moving, so this throws four straight down with a sideways
  // scatter and keeps the rainbow.
  if (jetting) for (let i = 4; i--;) {
    spawnParticle(px + PW / 2, py + PH, (Math.random() - .5) * 90,
      70 + Math.random() * 70, i * 90, .45, 0);
  }

  if (hoseState !== HIDDEN && Math.random() < 0.6) {
    const tip = hose[hoseLen - 1];
    const dvx = tip.x - tip.ox, dvy = tip.y - tip.oy;
    for (let i = 0; i < 24; i++) {
      const speed = 1 + (Math.random() - 0.5) * 0.5;
      const angle = Math.atan2(dvy, dvx) + (Math.random() - 0.5) * 1.0;
      const mag = Math.hypot(dvx, dvy) * 2 * speed;
      const vx = Math.cos(angle) * mag;
      const vy = Math.sin(angle) * mag;
      spawnParticle(tip.x, tip.y, vx, vy, (i * 6) % 360, 0.5, 0);
    }
  }

  for (const [bx] of shafts()) {
    for (let i = 0; i < BEAM_N; i++) {
      const x = bx + (Math.random() - 0.5) * BEAM_W * 1.25;
      const y = WORLD_H - Math.random() * WORLD_H;
      // The hue is the SHAFT'S hue at this x — the same mapping the gradient
      // above uses — so a mote is a bright fleck of the band it rises through
      // and the shaft still reads as one rainbow rather than as speckle over
      // it. Thin, and thinner than the burst's: the beam lasts four seconds
      // and is scenery, not the payoff.
      const hue = (x - bx + BEAM_HW) / BEAM_W * 300 % 360;
      spawnParticle(x, y, 0, -60 - Math.random() * 40, hue, 1.5, 1, 0.6);
    }
  }

  if (py > WORLD_H + 60) {
    px = SPAWN_X; py = SPAWN_Y;
    vy = 0; kickX = 0;
    if (latched) unlatch();
    resetHose();
  }

  camX += (clamp(px + PW / 2 - W / 2, 0, WORLD_W - W) - camX) * 10 * h;
  camY += (clamp(py + PH / 2 - H / 2, 0, WORLD_H - H) - camY) * 10 * h;
}

/** Leaves the title screen, or restarts after a win or a loss. */
function action() {
  if (loading) return;
  if (!started) {
    started = true;
    playSound(bank[SONG], 1, 0, 0.3, true);
  } else if (mode) reset();
}

function reset() {
  mode = score = kills = 0;
  facing = 1;
  px = SPAWN_X; py = SPAWN_Y;
  vx = vy = kickX = 0;
  grounded = true;
  airPress = jetting = false;
  coyote = acc = time = hoseT = latchCd = stretchT = walkT = 0;
  tank = TANK_MAX;
  graceT = GRACE;
  unis = []; picks = []; beams = []; rings = []; particles = [];
  latched = null;
  flowers = plots.map(([x, y], i) => ({
    x, y, s: BLOOM, c: i % POPPY_COLORS, fx: Math.random() < 0.5, dead: false, wiltT: WILT,
  }));
  wave = 0;
  coins = 0; pumpLvl = 0; magLvl = 0; shake = 0; flash = 0;
  startWave();
  prevJump = prevFire = prevDrop = prevMy = true; // swallow the press that restarted
  resetHose();
  camX = clamp(px + PW / 2 - W / 2, 0, WORLD_W - W);
  camY = clamp(py + PH / 2 - H / 2, 0, WORLD_H - H);
  poll();
}

export default {
  init(o) {
    ({ ctx, W, H, keys } = o);
    font = bakeFont('#cfd3da');
    // SCALE 3, and `big` is every oversized string the game draws: the title
    // card, the loading card, the LAST POPPY warning and the score. A fourth
    // atlas for the logo alone would have cost a bake, a global and a second
    // centring helper for one string; stepping the one that exists costs a
    // character, and the three it carries along all wanted to be louder —
    // a 9x27 glyph is a logo, a readable emergency, and a score worth reading.
    big = bakeFont('#fff', 3);

    // The farm layout is stage data: AABBs become the platform list, the
    // tagged objects become the poppy plots.
    plats = [];
    const a = FARM[2];
    for (let i = 0; i < a.length; i += 5)
      if (!a[i]) plats.push([a[i + 1], a[i + 2], a[i + 3] - a[i + 1], a[i + 4] - a[i + 2]]);
    plots = [];
    eachObject(FARM, (ix, x, y) => {
      if (kvOf(FARM, ix, 'plot')) plots.push([x, y]);
    });

    // A KEY CHANGE BUYS THE SECOND HALF OF THE TRACK FOR NOTHING.
    //
    // The song is N song-positions long and every one of them points at the
    // same 32-row pattern, so the tune the player hears is one pattern played
    // four times. What the format actually stores per channel is a COLUMN LIST
    // and a SEQUENCE of 1-based indices into it — which means a second key does
    // not cost a second tune. Push a transposed copy of every column, point a
    // second lap of the sequence at the copies, and the generator walks twice
    // as far through data that grew by one array of 32 small integers.
    //
    // `v && v + 5` is the whole transposition, and the guard is load-bearing:
    // a 0 in `n` is a REST, not a note at the bottom of the range, and adding
    // to it would fill every silent row in the track with a bass note. Up a
    // fourth, so the loop back to the original key lands as a plagal drop
    // rather than a lurch; 7 for a fifth or 2 for a gear change, if you'd
    // rather. The fx column is shared by reference — effects are not pitched.
    //
    // Priced honestly: the generator sizes its buffer off endPattern, so this
    // doubles both the synthesis time behind the loading bar and the PCM the
    // track occupies. Sixteen seconds of music becomes thirty-two.
    const N = song.endPattern + 1;
    for (const ins of song.songData) {
      const m = ins.c.length;
      ins.c.push(...ins.c.map(k => ({ n: k.n.map(v => v && v + 5), f: k.f })));
      for (let j = 0; j < N; j++) ins.p[N + j] = ins.p[j] && ins.p[j] + m;
    }
    song.endPattern += N;

    // Sprites and sounds render together behind one loading bar.
    art = stageBaker(FARM, o.pal);
    bank = initAudio([powerup, song, pump, jump, pegapop], MusicPlayer);
    loading = true;
    started = false;
    reset();
  },

  onClick: action,

  update(dt) {
    poll();
    if (loading) {
      art.step(8);
      loading = !(art.done() && soundsReady >= totalSounds);
      return;
    }
    if (!started || mode) {
      time += dt / 1e3;
      if (mode ? inp.retry : inp.fireEdge) action();
      return;
    }
    acc += Math.min(dt, 100);
    while (acc >= STEP) {
      step(HS);
      acc -= STEP;
    }
  },

  draw() {
    const c = ctx, fr = c.fillRect.bind(c), bp = c.beginPath.bind(c),
          ar = c.arc.bind(c), st = c.stroke.bind(c), ln = c.lineTo.bind(c),
          mv = c.moveTo.bind(c), ctr = (s, y) => font.draw(c, s, (W - s.length * font.w) / 2 | 0, y),
          bctr = (s, y) => big.draw(c, s, (W - s.length * big.w) / 2 | 0, y);

    if (loading || !started) {
      c.fillStyle = '#1a0a2e';
      fr(0, 0, W, H);
      // A PINWHEEL BEHIND THE LOGO, one shade off the ground it sits on.
      // THIRTEEN strokes out of the pile's own centre, half a radian apart.
      // Twelve was the obvious number and left a 0.28 rad wedge unlit out at
      // 3 o'clock, well clear of the pile; the thirteenth overlaps the first
      // instead, which nothing can see. 500 px is longer than the
      // diagonal, so every ray runs off the frame and none of them ends in
      // mid-air. The slow term on the angle turns the fan about once a minute.
      //
      // Drawn ahead of both branches, so the loading card gets it too: the
      // wordmark and the rays come up first and the pile lands into them.
      // THE SKY'S OWN MID STOP, not a new purple. `#331358` is already in the
      // bundle as the middle of the in-game gradient, and a colour the packer
      // has met costs a fraction of a novel one — a hex literal is seven
      // characters of near-pure entropy the first time and nearly free the
      // second. It reads a shade lighter than the card, which is the brief.
      c.strokeStyle = '#2a1148';
      // A BEGIN AND A STROKE PER RAY, which measured 4 bytes CHEAPER than one
      // path of twelve subpaths. The packer is context-mixing: this exact
      // bp/mv/ln/st sequence is what the hose and the particle trails already
      // spell, so a thirteenth repeat of it costs almost nothing, where the
      // tighter structure is a shape it has never seen. Brevity is not the
      // objective function here; predictability is.
      c.lineWidth = 9;
      for (let i = 13; i--;) {
        const a = i / 2 + time / 9;
        bp();
        mv(W / 2, 100);
        ln(W / 2 + Math.cos(a) * 500, 100 + Math.sin(a) * 500);
        st();
      }
      // The width is left at 9 on purpose. Nothing else on this card strokes,
      // and the play draw's first stroke is the hose, which sets its own — as
      // do the particles and the rings behind it. A reset here would be a line
      // spent restoring state that no reader ever observes.
      // The pile is the logo. Only once the sheet it comes off has been baked.
      // A SLOW BOB, and it is the only motion on the screen besides the blink.
      // The pile is baked at one size and drawn 1:1 — scaling it with the
      // context would cost a save/restore and resample a sprite rendered for
      // exactly these pixels — so `sprite` stays untouched and the logo is made
      // bigger where it is made: in the sheet.
      if (!loading) sprite(PEGAPOO_BIG, W / 2, 100 + Math.sin(time * 2) * 4, 0, PROP_SRC);
      // ONE WORDMARK FOR BOTH SCREENS, and it is not only the cheaper spelling.
      // The loading card used to set it at 100 and the title card at 176, so
      // the logo JUMPED at the moment the bake finished. Drawn once, outside
      // the branch, the card fills in around a title that never moves: first
      // the stars and the word, then the pile above it and the prompt below.
      bctr('POOPICORN', 176);
      if (loading) {
        c.fillStyle = '#2a3038';
        fr(180, 214, 120, 8);
        c.fillStyle = '#fff';
        fr(180, 214, 120 * (art.progress() + soundsReady / totalSounds) / 2, 8);
        // The same blink idiom as the LAST POPPY warning, deliberately — a
        // repeat costs the packer almost nothing, where a novel wall clock
        // (Date.now) measured 27 bytes over budget on its own. It works here
        // only because update() advances `time` in the !started branch now;
        // step() never runs on this screen, so `time` used to be frozen at 0.
      } else if ((time * 2 | 0) % 2) ctr('PRESS SPACE', 220);
      return;
    }

    // Deep cerulean overhead down to bright aqua at the horizon. The middle
    // stop is what keeps it clean: sRGB interpolated straight from a dark blue
    // to a light cyan sags through a grey-teal in the middle, and pinning a
    // saturated cyan at 55% holds the hue arc out where the eye expects it.
    // NOT A SKY, A BACKDROP. The rainbow shafts are the thing worth looking at
    // and they are drawn straight over this at a quarter alpha, so the sky's
    // job is to get out of their way. Near-black overhead through dark purple
    // to a deep blue at the horizon: L runs 6/21/34, low enough that a 60%
    // lightness rainbow reads at full strength anywhere on the screen.
    //
    // It also puts the field on the same ramp as the title card's #1a0a2e.
    const sky = c.createLinearGradient(0, 0, 0, H);
    sky.addColorStop(0, '#100618');
    sky.addColorStop(0.55, '#331358');
    sky.addColorStop(1, '#13379a');
    c.fillStyle = sky;
    fr(0, 0, W, H);
    // The kick is added to the CAMERA, before the stage draw, so the parallax
    // bands and the actors shake together — shaking only the translated layer
    // would slide the farm off its own background.
    const kx = shake > 0 ? camX + (Math.random() * 2 - 1) * shake : camX,
          ky = shake > 0 ? camY + (Math.random() * 2 - 1) * shake : camY;
    // PARALLAX STARFIELD, AND IT STORES NOTHING. Positions come off the same
    // Lehmer generator sdf.js jitters its scatter rows with — 16807 and 2^31-1,
    // reseeded to 1 every frame so the field holds still — and reusing those
    // exact constants is much of why it fits, because roadroller has met them.
    // The raw state is used unscaled — Lehmer's low bits are sound at a prime
    // modulus, so % W beats dividing out and multiplying back.
    //
    // A hash LINEAR in the loop index was the first try and it read as diagonal
    // lines: a constant step in x and a constant step in y is a lattice however
    // coprime the wraps are, and more stars only drew the lattice in more
    // clearly. Three depths fall out of i % 3, and the dim ones drift slowest
    // because they are the far ones. Screen space and before the stage, so the
    // islands pass over them. The +W/+H hold the modulo positive: the camera
    // tops out at exactly those and the drift is a fraction of it.
    c.fillStyle = '#fff';
    let seed = 1;
    const rnd = () => seed = seed * 16807 % 2147483647;
    for (let i = 220; i--;) {
      const d = .05 + i % 3 / 16, x = rnd() % W, y = rnd() % H;
      c.globalAlpha = d * 4; // dim IS far: one number drives both cues
      fr((x + W - kx * d) % W, (y + H - ky * d) % H, 1, 1);
    }
    c.globalAlpha = 1;
    drawStage(c, FARM, art.srcs, kx | 0, ky | 0, W, H);

    c.save();
    c.translate(-kx | 0, -ky | 0);

    for (const [bx, a] of shafts()) {
      c.globalAlpha = a * 0.25;
      const g = c.createLinearGradient(bx - BEAM_HW, 0, bx + BEAM_HW, 0);
      for (let i = 0; i <= 20; i++) {
        const t = i / 20;
        g.addColorStop(t, `hsl(${t * 300},80%,60%)`);
      }
      c.fillStyle = g;
      fr(bx - BEAM_HW, 0, BEAM_W, WORLD_H);
      c.globalAlpha = 1;
    }

    // A bloom is a colour frame of the poppy clip; the lower states are
    // props. `f.c` and `f.fx` are fixed at init, so a plot keeps its colour
    // and its facing across being eaten and regrown.
    for (const f of flowers) {
      const cy = f.y - FLOWER_Y;
      if (f.dead) sprite(DEAD, f.x, cy, f.fx, PROP_SRC);
      else if (f.s < BLOOM) sprite(FLOWER0 + f.s, f.x, cy, f.fx, PROP_SRC);
      else sprite(POPPY0 + f.c, f.x, cy, f.fx);
    }

    for (const p of picks) {
      // ONE blink-out for both kinds, which costs less than nesting it under
      // only the mote. A pile that is about to rot flashes the same way a mote
      // about to expire does, so the warning needs no second idea.
      if (p.life < 2 && (p.life * 8 | 0) % 2) continue;
      if (p.b) sprite(PEGAPOO, p.x, p.y - PEGAPOO_Y, 0, PROP_SRC);
      else {
        // Flashing, not cycling: the hue jumps on a fast step so a mote reads
        // as a chip of light catching colour, and the phase keeps the cloud
        // from strobing in unison.
        c.fillStyle = `hsl(${(time * 6 + p.ph | 0) * 47 % 360},95%,72%)`;
        fr(p.x - 3, p.y - 3, 6, 6);
      }
    }

    for (const u of unis) {
      const uy = u.y + (u.state === ARRIVE ? Math.sin(time * 5 + u.bob) * 3 : 0),
            // Inflating replaces every other clip; a pegacorn grazes only
            // while it is down on a bloom and not yet being pumped.
            frame = u.stage > 0
              ? INF0 + clamp(u.stage, 1, INF_FRAMES) - 1
              : u.state === EAT
                ? EAT0 + (((time + u.bob) * EAT_FPS) | 0) % EAT_N
                : PEGA0 + (((time + u.bob * 100) * PEGA_FPS) | 0) % PEGA_FRAMES;

      if (!u.lit) c.filter = 'invert(1)';
      sprite(frame, u.x, uy, u.facing < 0);
      c.filter = 'none';
    }

    if (hoseState !== HIDDEN) {
      const strain = hoseState === LATCH && stretchT > 0 && (time * 12 | 0) % 2;
      c.lineCap = 'round';
      // One flat pass. Three stacked strokes read as a round tube lit from
      // above, and at 24 segments that is 72 strokes a frame for shading a
      // rope that is already the brightest thing on screen. The rainbow along
      // its length is what makes it read, not the highlight.
      c.lineWidth = 3;
      for (let i = 0; i < hoseLen - 1; i++) {
        c.strokeStyle = strain ? '#fff' : `hsl(${i * 36},70%,60%)`;
        bp();
        mv(hose[i].x, hose[i].y);
        ln(hose[i + 1].x, hose[i + 1].y);
        st();
      }
    }

    // Feet on the box's floor, head over it: the body stays 10x14 whatever
    // the art does. In the air the pose holds on frame 1, as delve's does.
    // Dangling off a latched pegacorn overrides everything: arms up, no cycle.
    sprite(hoseState === LATCH && !grounded ? HANG
      : (hoseState === HIDDEN ? HERO0 : HOLD0)
        + (grounded ? (walkT ? (walkT * HERO_FPS | 0) % HERO_WALK : 0) : 1),
      px + PW / 2, py + PH - HERO_H / 2 + HERO_Y, facing > 0);

    c.lineCap = 'round';
    // The hue RUNS as a spark ages, which is most of why the burst reads as
    // rainbow rather than as confetti of fixed colours — but only for the ones
    // that FALL. A riser (bit 1) was given the exact hue of the thing it
    // belongs to, the lift shaft's gradient at its own x, and cycling it off
    // that turned the shaft into speckle that disagreed with its own colour.
    for (const p of particles) {
      const rise = p.beam & 1;
      c.globalAlpha = Math.min(1, p.life / p.maxLife);
      c.lineWidth = p.w;
      c.strokeStyle = `hsl(${p.hue + (rise ? 0 : p.life * 260)},90%,${p.beam & 2 ? 76 : 62}%)`;
      bp();
      mv(p.x, p.y);
      ln(p.x - p.vx * 0.03, p.y - p.vy * 0.03);
      st();
    }
    c.lineWidth = 1;
    c.globalAlpha = 1;

    c.restore();

    // Over the world, under the HUD: the pop blows out the frame, not the
    // score. Screen space, so it does not ride the camera kick.
    // CENTRED ON THE POP, and fading to nothing well before the frame edge.
    // A full-screen wash was the first try and it hid the burst it announces:
    // for the tenth of a second the shell and the rays look their best, the
    // screen was a flat pastel sheet. A bloom blows out the middle instead and
    // leaves the farm visible around it.
    if (flash > 0) {
      const bx = flashX - kx, by = flashY - ky;
      c.globalAlpha = Math.min(1, flash);
      const g = c.createRadialGradient(bx, by, 0, bx, by, 190);
      for (let i = 0; i <= 5; i++) {
        g.addColorStop(i / 5, `hsla(${i * 72 + time * 400},100%,${82 - i * 7}%,${1 - i / 5})`);
      }
      c.fillStyle = g;
      fr(0, 0, W, H);
      c.globalAlpha = 1;
    }

    // TWO METERS, ONE LANGUAGE. The grace clock stopped being a countdown the
    // moment it started refilling off the standing bloom count — it is the
    // farm's health, and it was the only resource in the game with no bar. A
    // thinner one sits under the tank because it is the one you lose to.
    //
    // THE HUE IS THE VALUE, which is why this costs almost nothing. A flat fill
    // plus a `low` test is a colour constant, a threshold and a branch; a hue
    // driven straight off the number is one expression that ramps green through
    // amber to red continuously, with no cliff to tune and no second string for
    // the packer to learn. Both bars run the same 70/60 hsl the particles do.
    // `tank * 1.2` and `graceT * 15` are each just "full = 120 = green".
    // ONE PLATE FOR THE BLOCK, bled off the top and left edges rather than
    // floated inside them — a panel that touches two sides reads as part of
    // the frame, where an inset one reads as a sticker sat on the farm. It is
    // also a rect fewer than a backing per bar.
    // The empty half of each meter is this showing through — exactly what the
    // two backings drew — and the icons get something to sit on, which they
    // needed: a 12 px sprite over the top-left island was unreadable.
    c.fillStyle = '#2a3038';
    fr(0, 0, 102, 38);
    c.fillStyle = `hsl(${tank * 1.2},70%,60%)`;
    fr(24, 8, 70 * tank / TANK_MAX, 6);
    // A SHADE DARKER than the tank's 60%, and that is the whole separation.
    // Both meters run out and both should say so the same way, so they keep
    // one hue ramp and differ in weight instead — otherwise a full farm and a
    // full tank are the same green and read as one two-tone block.
    c.fillStyle = `hsl(${graceT * 15},70%,48%)`;
    fr(24, 26, 70 * graceT / GRACE, 4);
    sprite(ICON_POO, 15, 11, 0, PROP_SRC);
    sprite(ICON_POPPY, 15, 28, 0, PROP_SRC);
    // The farm is down but not gone. A countdown the player can still beat:
    // blooms buy it back. The bar above carries the whole slope now, so this
    // is no longer the warning — it is the emergency, and it waits until the
    // last three seconds rather than blinking through every late wave.
    if (graceT < 3 && (time * 6 | 0) % 2) bctr(`LAST POPPY ${Math.ceil(graceT)}`, H / 2 - 40);

    // BLOOMS is the health bar and PESTS is the win condition, and they sit
    // together because the player's instinct is to read only the first one.
    // Blooms say protect the farm; nothing said that a wave ends only when this
    // number reaches zero, and that reviving a poppy never moves it. Modelled,
    // a farm-first player stalls around wave 8 having eaten 1,484 blooms, where
    // one who lets the farm sit at three clears wave 21. The counter is the
    // cheapest way to say so — the queue still to arrive, plus the field.
    font.draw(c, `POPPIES ${blooms().length}`, W - 66, 8);
    font.draw(c, `PESTS ${spawnQ + unis.length}`, W - 66, 19);
    font.draw(c, `DUST $${coins}`, W - 66, 30);
    bctr(`${score}`, 6);

    // The report fills the rest between waves, while nothing is on the field.
    if (!mode && !spawnQ && !unis.length && wave) {
      c.fillStyle = 'rgba(10,12,20,.72)';
      fr(W / 2 - 92, 34, 184, 122);
      ctr(`WAVE ${wave} CLEAR`, 42);
      // Label left, value right, both inset 12 px from the panel edges.
      const row = (s, n, y) => {
        font.draw(c, s, W / 2 - 80, y);
        font.draw(c, `${n}`, W / 2 + 80 - `${n}`.length * font.w, y);
      };
      // A shop row dims when you cannot press it, and that is ONE test for two
      // different reasons: a maxed step has no cost at all, and a step you
      // cannot afford costs more than the purse. Alpha rather than a second
      // colour — the glyph atlas is tinted at bake time, so another colour
      // means another whole atlas, where dimming is free on the one there is.
      // The cursor is a plate behind the row, not a glyph beside it: the atlas
      // is tinted at bake time, so a second colour of text costs a whole atlas
      // where a filled rect costs nothing. A negative price is the last row —
      // always pickable, and priced at nothing.
      const shop = (s, cost, full, y, i) => {
        if (sel === i) { c.fillStyle = '#2a3038'; fr(W / 2 - 92, y - 2, 184, 12); }
        c.globalAlpha = cost && coins >= cost ? 1 : .4;
        row(s, cost > 0 ? `$${cost}` : full, y);
        c.globalAlpha = 1;
      };
      row('POPPED', kills, 56);
      row('SCORE', score, 68);
      row('DUST', `$${coins}`, 80);
      shop('PUMP', pumpLvl < PUMP_LVLS && upCost(), 'MAX', 106, 0);
      shop('MAGNET', magLvl < MAG_LVLS && magCost(), 'MAX', 118, 1);
      shop('REPLANT', replantCost(), 'FULL', 130, 2);
      shop('NEXT WAVE', -1, '', 144, 3);
    }

    // RINGS LAST, and in screen space — the world pass draws them under the
    // report panel, which is where a purchase's burst goes off. They are stored
    // in world coordinates like everything else and converted here, so a pop's
    // shockwave still tracks the camera.
    for (const p of rings) {
      const k = p.t / p.d;
      c.globalAlpha = Math.min(1, k);
      c.lineWidth = 1 + k * p.d * 14;
      // ONE arc, one hue, taken from the ring's own radius — so a pop's three
      // come out three different colours and a collect always reads the same
      // one. It was twelve arcs of twelve hues, which was twelve strokes a
      // ring for a rainbow nobody could pick out at this size.
      c.strokeStyle = `hsl(${p.r * 7 % 360},95%,66%)`;
      bp();
      ar(p.x - kx, p.y - ky, (1 - k) * p.r + 6, 0, 7);
      st();
      c.globalAlpha = 1;
    }

    if (mode) {
      c.fillStyle = 'rgba(10,12,20,.7)';
      fr(0, 0, W, H);
      ctr('FARM LOST', H / 2 - 10);
      ctr('R TO RETRY', H / 2 + 6);
    }
  },
};
