# stagetool — large-world editor for the canvas stack

Interactive editor for one continuous, unbounded world: independently
parallaxed sprite stamps, box AABB collision, and KV-tagged objects — drawn
with `drawImage` from SDF sheets, with no indexed framebuffer anywhere.
Dev-only: nothing under `tools/` ships. The game imports
`src/js/core/stage.js` (`stageBaker` + `drawStage` + `hitStage` +
`eachObject`/`kvOf`, tree-shaken away entirely when unused) plus the stage
data files in `src/js/stages/`.

## Stage or world?

Two of the worldtool's source kinds do not survive the host change, and their
absence is the point:

- **Raw-drawing stamps are gone.** A drawing is a `drawShape` replay into an
  indexed buffer; a canvas has no equivalent. The reason they existed — a
  backdrop too big for a RAM page — went away with the pages, so a backdrop is
  now just a big sprite.
- **The source cap is gone.** 8 atlases was 10 RAM pages minus the palette
  page. A canvas has no page budget, so load as many sheets as you like.

A third difference is not about the host at all: **this document has parallax
LAYERS.** A worldtool stamp carries its own `rate` and `depth`; a stage stamp
carries neither, because a layer owns both. AABBs are still stride 5 with
exclusive maxima and objects are still the same KV-tagged points.

## Run

```
npm run tools          # one server for every editor; landing page at /
                       #   stagetool: http://localhost:8787/stage
npm test -- stagetool  # eight suites (runtime, editor, canvas host, tiles,
                       #   layers, placement, playtest, render budget)
```

## Concepts

- **Sources are SDF sheets** (`src/js/sheets/`, authored in
  `tools/sdftool/`'s sheet tab). Each bakes into its own offscreen canvas at
  load. Everything placed in the stage addresses one by `(k, i)`: `k` indexes
  the sheet list, `i` is a sprite id in that sheet. `k = -2` (objects only)
  means no visual at all.
- **A bake is raymarching, not a blit.** That shapes the editor more than
  anything else here. Two consequences:
  - **A sheet bakes once, cached by its name**, and the cache outlives the
    viewport, the camera and the document. The worldtool could rebake an atlas
    page on every zoom step; this one must not.
  - **The rect table exists before any pixel does.** `sheetBaker` shelf-packs
    in its constructor, so sizes, hit-testing, the sprite palette and the whole
    stamp list are correct on the first frame, with only the picture still
    arriving. Nothing in the editor ever waits on a bake — a thin blue bar
    along the bottom of the canvas is the only sign one is running.
- **Sprite ids are permanent**, the sdftool's contract: deleting a sprite
  leaves a tombstone, so a stage that references sprite 17 keeps meaning it.
  A tombstoned id draws nothing rather than drawing the wrong thing.
- **Layers are the stack.** A layer is a **parallax rate** (same on both axes
  — `screenPos = worldPos - camera * rate`; 1 = the gameplay plane, `<1` reads
  as far away, `>1` as close) and an ordered list of stamps. **Layers draw in
  list order and stamps draw in list order within a layer**, so there is no
  depth number anywhere and nothing sorts — not on save, not at run time. A
  game splits its actors on a **layer index**: `drawStage(…, 0, 3)`, the
  actors, `drawStage(…, 3)`.
- **Stamps** are one placed sprite each: a source, a world position and an
  optional horizontal flip. **That is all** — the rate and the draw order come
  from the layer it is on, which is two numbers a stamp used to carry to say
  what a whole band of them always shared.
- **AABBs** are plain collision boxes: a type (game-defined, e.g. 0 = solid)
  and a rect. Every collision query in the game goes through the same
  box-overlap test.
- **Objects** are KV-tagged points: an optional sprite (same `(k, i, fx)`
  addressing as a stamp, or `k = -2` for a logic-only marker — a spawn point,
  a trigger), plus free `key: number` pairs the game defines the meaning of.
  The tool has zero opinion about what any key means.
- **Collision is a plain linear scan**, deliberately not view-culled: a few
  hundred boxes is a few thousand compares per query, and culling correctness
  would depend on camera state.
- **Some editor state is not in the file, on purpose.** Layer names, the
  player-split marker, collision type names, camera bookmarks and object KV
  presets live in `localStorage`
  under `stagetool:prefs:<stage>` (see `prefs.js`); the tile grid's size and
  origin under `stagetool:tiles:<stage>`. Stamp locks, layer hide/lock/solo and
  the variant brush live only in memory. A stage stores which sprite, not what
  the editor called its layer — so none of this can change a shipped byte, and
  a fresh clone of the repo opens the same stage with the same art and no
  names.

## Editor

The panels are contextual: the left pane shows the active tool's options and
nothing else. `?` (or the button in the status bar) opens the whole key map.

### Sources

- **Sheets panel**: "+ sheet…" opens a thumbnail picker (the thumbnails are
  real bakes, so they fill in rather than appear); ✕ removes a sheet —
  refused while any stamp or object still references it, since removing one
  would renumber every `k` above it and silently repoint the stage.
- **Sprite palette**: every live sprite of every loaded sheet, as thumbnails
  cut from the baked canvas. Clicking one arms the **stamp tool** with it (or,
  right after "sprite…" in the object panel, assigns it to the selected object
  instead). **Shift-click** adds it to the **variant brush**: each placement
  then picks at random from the armed sprite plus every variant, which is what
  keeps a rubble field from looking hand-tiled. The thumbnails are cut once
  and cached — they only change when a sheet is rebaked.

### Placing

- **Stamp tool**: click to place the armed sprite; stays armed for repeated
  placement. **Drag to lay a run**, one stamp every `gap` px (0 = the sprite's
  own size) — a ground line is one drag, not thirty clicks. **The armed layer
  and the flip persist across placements**, so a run of far-background pieces
  stays on its own plane without re-picking it; press `X` to flip, and pick the
  layer in the Layers panel. **Alt+click** an existing stamp to eyedrop its
  sprite, its flip AND its layer. **"sprite snap"** aligns a placement to the nearest
  edge/corner of a stamp ON THE SAME LAYER within a few screen px, per axis
  independently, falling back to grid snap on whichever axis nothing was close
  enough to — which is what makes tile-map-like placement practical without a
  tilemap.
- **Select tool**: click selects (stamps by their rendered rect in VIEWPORT
  space — two stamps at the same world position but different rates are drawn
  in different places, so hit-testing has to use what is on screen); drag
  moves; arrows nudge (Shift ×8); Delete removes. **A marquee collects stamps,
  collision boxes and objects together**, and so does the clipboard: a whole
  platform — art, collision and its pickup — copies as one unit.
  **Shift-drag** extends the selection, **Shift-click** toggles one in or out,
  **Alt+drag** duplicates. A **multi-stamp drag honors each member's own
  layer's rate**: a gameplay-plane member tracks the cursor 1:1, but anything
  nearer or farther ends up offset from it, as if the drag were a camera pan
  rather than a flat shift. The inspector reads and edits the TOPMOST member —
  x/y bulk-shift the group, fx sets every member; there is no rate or depth
  field on a stamp, because a stamp has neither. **Ctrl/Cmd+C / Ctrl/Cmd+V**
  copy and paste (each repeated paste offsets a little further, so pastes
  cascade instead of stacking).
- **Order** (select tool's panel): draw order is list order now, so ⤒/↑/↓/⤓
  (and `[` / `]`, with Shift for all the way) are the only way to change what
  covers what inside a layer.
- **Arrange** (select tool's panel): align six ways, spread evenly on either
  axis, and **repeat** — duplicate the selection *n* times along a step, with
  "use size" filling the step from the selection's own bounds. `Ctrl+D` repeats
  along the last move you made, so drag one copy into place and then hold it.
  **"same sprite" / "same layer"** grow the selection, which is how a bulk
  re-plane starts. **"box stamps"** (`B`) drops one collision box per selected
  stamp, at its exact bounds — `delve`'s ground draws its own collision, and
  this is the motion that level made most.
- **Stamp list** (right panel): every placed stamp — click selects, **Shift**
  range-selects, **Ctrl/Cmd** toggles. It is **filterable and sortable**
  (draw order, or the raw list order) and **windowed**: only the rows in
  view exist, so a 500-stamp stage costs a dozen DOM rows. Each row's 🔓/🔒
  **locks** the stamp: a locked stamp can't be picked up by a click or swept
  into a rubber band, on the canvas or in this list, and it draws with a dashed
  grey outline so the reason is visible. Locking is editor-only and never
  saved.

### Layers

The **layers panel** is the document's spine, not a view of it: the row order
IS the draw order and a row's rate IS the parallax of everything on it.

Per row — hide (which also stops that layer taking clicks), lock, **solo** (the
rate chip), a **name**, a count that selects every stamp on the layer, and ⇥
which moves the selection onto it, adjusting each stamp so nothing jumps on
screen. Clicking a row **arms** that layer: it is where the next placement
lands, and the `rate` field edits it.

`+ layer` inserts one after the armed layer, `✕` removes it (refused while it
still holds stamps — the alternative is silently deleting art or silently
re-planing it), and ↑/↓ move it in the draw order, carrying its stamps with it.

The **split** field marks where the game draws its actors, and the panel draws
that line between two rows. It is editor-only — a game passes the number to
`drawStage` itself — but it is the one thing about a layer stack you cannot
work out by looking at it. The layer filter's "below split"/"above split"
buttons use it.

Layer names, the split, and the hide/lock/solo flags live in `localStorage`,
never in the file.

### Collision

- **AABB tool**: drag out a box (`type` field on the left, with an optional
  **name** — `solid` reads where `0` does not, and the name is drawn on the
  box). With the select tool, drag a corner handle to resize it.
- **Tile tool**: paint collision on a grid instead of hand-sizing boxes —
  `size`, `origin x`/`origin y` and `type`. Drag paints, **right-click or
  Ctrl** erases, **Shift-drag** fills a rectangle, and **fill** floods the
  empty region under the cursor (capped, since the grid is unbounded). The grid
  is EDITOR-ONLY — never saved — and bakes to ordinary stride-5 AABBs at the end
  of every stroke, one per maximal rectangle (greedy meshing, per type).
  **"absorb boxes"** rasterizes every AABB whose edges land exactly on the grid
  into cells and re-bakes, so a hand-tiled area can join the grid. Size/origin
  persist per stage in localStorage, and a stage that has used the layer before
  auto-absorbs on load. Baking to AABBs beats a runtime tilemap on bytes,
  which is why the grid is an editor convenience and not a shipped format.
- **Object tool**: click to place a marker; the panel gives it a sprite
  ("sprite…" then a palette click; "clear" reverts to a marker) and a KV table.
  Keys **autocomplete from every key already used in the stage** (a typo in
  `"pickup"` is silent and fatal), the pairs are **labelled on the canvas**,
  and a KV set can be saved as a named **preset** and applied to the next
  twenty pickups.

### Getting around

- **View**: pan with space/middle-drag or arrow keys, wheel-zoom anchored on
  the cursor (0.1–8×), optional placement snap. `F` frames the selection,
  `Shift+F` fits the whole stage, `Home` returns to the world origin, and
  **Ctrl+1…9 sets a camera bookmark** that **Alt+1…9** jumps back to.
- **The overview map** (right panel) draws the whole stage as a schematic,
  coloured by layer, with the viewport and the game screen on it. Click or drag
  it to move the camera. It is a schematic and not a shrunken picture on
  purpose: `drawStage` blits 1:1 into a world-resolution canvas, so a real
  render of a wide stage would allocate a world-sized canvas every refresh.
- The dotted **camera pane** (the 480×270 rect the game actually shows) sits
  centered in the editing canvas rather than pinned to its corner, so there is
  margin to work in on every side — a pure viewport choice that never touches
  the real camera or distorts parallax. A **layer filter** (`l0`/`l1` + "dim
  out-of-range", with below/above-split presets) exists because a parallaxed
  world is hard to look at all at once. Collision
  and objects have their own visibility toggles. **Tab** hides the panels and
  crops to exactly one screen at the camera with the real rates and no
  overlays.
- **The status bar** under the canvas carries the cursor's world position, the
  zoom, what is selected, the last message and the `?` button.

### Playtest

`P` drops a body at the cursor and runs it: gravity, arrows/WASD, space to
jump, click to teleport it, `Esc` to leave (which puts the camera back exactly
where it was). It moves ONE PIXEL AT A TIME against **`hitStage`, the same
collision call the game makes** — so it rests flush on a ledge, cannot tunnel
through a thin floor at speed, and a gap that clears here clears in the game.
The size, gravity, jump, run speed and collision type are fields, seeded from
`delve`'s, because a level is only testable against the movement it is designed
for. `Tab` answers "does this look right"; this answers "can the player make
that jump".

### The picture itself

- **The canvas renders through the real runtime**: `drawStage` does the culled,
  parallaxed `drawImage` calls into a viewport canvas at world resolution, the
  display scales that up with smoothing off, and the editor's overlays go on
  top — never instead of it, so what you see cannot drift from what the game
  draws.
- **The render is split.** `emit()` used to mean "rebuild every panel", and a
  drag calls it on every pointer move — one fresh canvas per sprite thumbnail,
  one DOM row per stamp and a deflate of the whole file, sixty times a second.
  Each mutation now declares which panels it can have changed (`D` in
  `state.js`) and the flags are coalesced into one pass. A drag redraws the
  picture and the numbers beside it and allocates no DOM at all;
  `tests/stagetool/test-stage-perf.mjs` pins that.
- **Double-click** a stamp to open the sdftool, which owns every sprite here.

### Saving

`Ctrl+S` saves. The stage name carries a `*` while there are unsaved changes,
the tab title with it, and closing the tab asks first. `Ctrl+Z` undoes and
`Ctrl+Shift+Z` / `Ctrl+Y` redo — and neither fires while the cursor is in a
text field, which is how undoing a typo in the name box used to destroy a stage
edit.

## File format (generated; don't hand-edit casually)

`src/js/stages/<name>.js`:

```js
import _0 from '../sheets/props.js';
const S=[_0];
export default [S,[[0.35,0,10,20,120,0],[1,0,8,0,200,0, 0,9,330,170,0]],
  [0,0,200,320,232],
  [330,170,0,9,0,1,"pickup",1]];
```

- `S` — the sheets, in source order (a stamp's `k` indexes this).
- `[1]` — **layers**, in draw order. One layer is `[rate, ...stamps]`, stamps
  flat stride 5: `[k, i, x, y, fx]`. **Nothing is sorted**: layers draw in list
  order, stamps in list order within a layer. An EMPTY layer is still emitted,
  because its position is what every later layer index means — to the game's
  actor split as much as to the file.
- `[2]` — **AABBs**, flat stride 5: `[type, x0, y0, x1, y1]`, `x1`/`y1`
  exclusive. The tile tool is an authoring convenience only: nothing about the
  grid — cell size, origin, or the grid itself — is stored here, and a baked
  box is indistinguishable from a hand-drawn one once saved.
- `[3]` — **objects**, omitted when empty. Variable stride:
  `[x, y, k, i, fx, n, k0, v0, ...]` per object. Keys are emitted quoted and
  read with bracket access: a mangler renames static property access but not
  a key stored as a string, so the two must never be mixed on one object.

**No rects, no layout, no palette, no per-stamp rate or depth.** A stage
stores which sprite, not what it looks like — the sheet owns the ids and the bakers pack from the sizes at
boot. That is why the same file is readable by any host that can bake the
sheet.

The codegen lives in `tools/drawtool/server.js` (`saveStage`) and is mirrored
byte-for-byte by `fileText()` in `tools/stagetool/state.js` — keep both in
sync (pinned by byte-equality checks in `tests/stagetool/test-stage-basics.mjs`
and `test-stage-tiles.mjs`).

## Runtime usage (`src/js/core/stage.js`)

```js
import { stageBaker, drawStage, hitStage } from '../core/stage.js';
import stage from '../stages/test.js';

const art = stageBaker(stage, pal);           // rect tables ready immediately

// while loading — the bake IS the loading screen:
art.step(8);                                   // 8 ms a frame; art.progress()

// per frame:
drawStage(ctx, stage, art.srcs, cam.x, cam.y, W, H, 0, 3);  // layers 0-2
drawPlayer();
drawStage(ctx, stage, art.srcs, cam.x, cam.y, W, H, 3);     // layer 3 up, over the player

const hit = hitStage(stage, x0, y1, x1, y1 + 2, 0); // ground probe
if (hit >= 0) py = stage[2][hit + 2] - ph;          // stand on the box's y0
```

**The screen size is a parameter, not `ctx.canvas`.** `canvas` is on the
property-crunch allowlist (`scripts/crunch-props.js`, RetroBuffer owns a field
by that name), so reading it off a DOM object inside `drawStage` is renamed
along with it and comes back `undefined` in the BUILT game while dev works
fine. Quoting does not save it either — terser's `compress.properties` turns
`ctx['canvas']` back into `ctx.canvas` before the mangler sees it. This cost a
build to find; do not put it back.

`src/js/games/stagetest.js` is a minimal proof game (a moving rect with
gravity, box ground collision, a parallaxed background, and an object pickup)
— the role `worldtest.js` plays for the world system. To run it, point the
import in `src/js/game.js` at `'./games/stagetest.js'`.
