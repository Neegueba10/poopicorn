# sdftool — 3D asset editor

Melt a handful of primitives together and cut holes in them; the result renders
at run time with ambient occlusion and lands on the palette. Dev-only: nothing
under `tools/` ships. The game imports `src/js/core/sdf.js` plus the model
files in `src/js/models/`.

The point is asset cost. A crate is **30 numbers**, a creature is 80, and an
eight-direction facing set is one model rendered at eight angles.

## Run

```
npm run tools        # one server for every editor; landing page at /
                     #   sdftool: http://localhost:8787/sdf
npm test -- sdftool  # 25 suites (10 pure Node, 15 headless Chrome)
npm run sdf-shots    # render every model in src/js/models/ to .artifacts/sdf/
```

## Concepts

- A **model** is `[parts, materials, view]` — the exact array the game
  imports. What the editor edits IS the file.
- A **sheet** is the list of sprites a game bakes: a model, a view and a size
  per sprite id. See "The sheet tab" below.
- A **part** is one primitive: a sphere, box, capsule or torus, at a position,
  with a size and a **blend**.
- **Blend** is how softly a part melts into the ones before it. `0` is a hard
  join; `0.1`–`0.2` is the difference between two spheres and one creature.
- **Subtract** removes a part from what is already there — grooves, hollows,
  bevels. The crate's plank lines are two subtracted boxes.
- **Paint only** is a part with colour and no shape. It blends into the
  material field and leaves the silhouette untouched, so you can tint a belly,
  weather an edge or bed a shape into shadow without denting it. Its `blend`
  becomes `reach`: how far the colour carries beyond its own surface.
- **Mirror x** makes one row two shapes. See "Symmetry" below.
- **Scatter** is a header row that copies the row after it, with jittered
  numbers, at render time. See "A mass of small parts" below.
- **Materials blend the way shapes do.** A part's colour mixes in with the same
  weight the smooth minimum gives its distance, so wherever two parts melt into
  one surface their colours melt across the same seam. A nearest-part rule puts
  a hard colour edge across a soft join and reads as a decal.
- **Order is the shape.** Parts blend against the accumulated field, not
  pairwise, and a subtraction can only remove what precedes it. Moving a row up
  or down changes the result, which is why the list has ▲▼.

| kind | `a b c` | `round` |
|---|---|---|
| sphere | — | radius |
| box | half width, height, depth | corner |
| capsule | half axis from the centre | radius |
| torus | major radius (XZ plane) | minor |
| cylinder | radius, half height | corner |
| cone | base radius, half height, top radius | corner |
| octahedron | size | corner |
| hex prism | radius, half depth | corner |
| ellipsoid | three radii | — |
| link | half length, ring radius | tube radius |
| pyramid | half base, height | corner |
| capped torus | major, cap sin/cos | minor |
| tri prism | size, half depth | corner |
| plane | normal | distance from centre |

The cone covers a family: top radius 0 is a point, equal to the base radius is
a cylinder. The plane is infinite and is for slicing a flat face off something
— it is the one primitive with no extent, so it never grows the model's bounds.

**Every part rotates**, on all three axes, in turns, about its own centre. The
matrices are built once per render rather than per sample.

## Editing

Every panel section carries its own **? what does this do**, folded away by
default and remembered per section. The hints had grown until they pushed the
part list and the **add part…** menu off the bottom of the pane — a panel that
documented controls you could no longer reach. `tests/sdftool/test-tool.mjs`
asserts the menu is on screen at boot, so it stays that way.

### The widget

The selected part carries a 3D widget. **w / e / r** switch it between move,
rotate and scale, and the arms are always in the **part's own frame** — a
rotated capsule's Y arm runs along the capsule, because the numbers being
edited (`a b c`) are in that frame too.

- **Drag an arm** to act on that one axis.
- **Drag the white dot** in the middle to move in the plane facing you. This is
  how a **paint-only part** is moved: it has colour and no surface, so the ray
  picker cannot hit it, and before the widget it could be selected from the
  list and then not moved at all.
- **Scale is not a transform.** The format has none, and giving it one would
  cost the renderer a matrix per part in its hottest loop. A scale arm edits
  the dimension the primitive actually reads: the cylinder's radius, the box's
  half-width, the sphere's radius. A dimension stops at zero — a negative
  half-extent is a shape turned inside out, and the march fills the frame.
- **Shift-drag** any handle for a tenth of the speed.
- An arm pointing at the camera has no length to drag along, so it is hidden
  rather than left to divide by nearly nothing.

### Symmetry

**mirror x** on a part folds the sample across `x = 0` before the part is
evaluated. One row, two shapes, and **no extra numbers** — which is the whole
reason symmetry is domain math here rather than a duplicated row.

- The fold is **exact**: `|x|` is an isometry on each half of space, so the
  result is still a true signed distance and the march stays safe. It costs one
  operation per part per sample.
- The fold happens in **world space**, before the centre and before the part's
  own rotation, so the copy mirrors its rotation too.
- What it makes is the `x >= 0` half, **mirrored** — not the union of the part
  and its mirror image. The two differ only for a part that CROSSES the plane,
  and the difference is the useful case: a leaning capsule centred on `x = 0`
  folds into a chevron, so a pair of horns is one row. The price is that an
  asymmetric part straddling the plane creases at it.
- **x is held at 0 or above.** A mirrored part on the far side has no `x >= 0`
  half left to mirror, so it would vanish. The renderer could take `|x|` of the
  centre as well and pay a second `abs` in its hottest loop; the editor clamps
  instead. Ticking the box over a part already on the far side pulls it back.
- The **mirror plane** is drawn as a dashed square while a mirrored part is
  selected. A plane seen from an angle covers the whole picture, so the square
  is where it cuts the model's own bounds — edge-on it collapses to a line,
  which is how you know you are looking down the axis of symmetry.
- It composes with everything: a mirrored **cut** bites both sides, a mirrored
  **paint** tints both sides, and a mirrored **scatter template** is a
  symmetric mass.

#### bake mirror

**bake mirror** spends a row to turn the fold into a real second part. The two
rows are then ordinary parts with their own numbers, which is the only way the
two sides can move apart: a clip channel writes ONE row, so a mirrored pair can
only ever be animated in step. A character's left and right arms are one row
until you bake them.

- The copy is **derived, not guessed**. `map()` folds `x -> |x|` before the
  part's matrix, so the `x < 0` half evaluates `f(A·M·(q − t'))` with
  `M = diag(−1, 1, 1)`. Every primitive except the capsule and the plane is
  symmetric under a local x flip, so that equals `f(M·A·M·u)` — and `M·A·M` in
  this format's Euler order (Rz·Ry·Rx) is just **rx kept, ry and rz negated**.
  The capsule and the plane carry their x in column `a`, an axis and a normal,
  so that number is negated instead.
- It is **exact for a part clear of the plane**, which is the case it exists
  for. The fold CLIPS each half at `x = 0`; two real rows are not clipped, so a
  part straddling the plane can bake into more material than it had — the
  inspector says so, in orange, under the button. A **plane** always straddles
  and is refused outright.
- A **scatter** is refused. Its instances are rolled from a seed at render
  time, so two scatters would be two arrangements rather than one reflected.
- Where two halves both reach the same point, one smooth union becomes two, and
  a smooth union is not associative. The seam down `x = 0` moves by a few
  thousandths — measured at 1.6e-4 on the creature's arms, which is under a
  dither step and below anything the bake is worth worrying about.
- `tests/sdftool/test-bakemirror.mjs` proves it by sampling `map()` on a grid
  before and after: same rows, same field.

### A mass of small parts

**+ scatter** adds two rows: a **header**, and the **template** it copies. At
render time the header becomes `count` jittered copies of the template. The file
holds two rows where the render has forty — a 40-piece rubble field is **26
numbers**, not 520.

| dial | what it does |
|---|---|
| shape | the primitive every instance is a copy of — **any of the fourteen**. It is the template's own `kind` and is offered on the header because that is where you look for it. The first four are inlined in the renderer and march fastest |
| seed | the arrangement. **🎲** rerolls it and changes nothing else |
| count | how many |
| scatter in | the **volume** they land in, a box or an ellipsoid — not their shape. A big count in an ellipsoid reads as an organic clump; a box reads as a filled rectangle |
| spread x/y/z | how far from the template's own centre |
| spin ± | rotation spread, in turns, rolled on all three axes |
| *dimension* ± | one per field the template's primitive reads |
| blend ± | |
| material + | choose from this many materials past the template's own |

- **The expansion happens once per render**, in `begin()`, and `map()` never
  learns it exists: an instance is an ordinary part row. Random per-instance
  numbers would otherwise need a hash at every sample, which costs more than the
  rows it saves and breaks the conservative distance the march depends on.
- **The template is not drawn by itself.** It is what the instances are copies
  of, and its own flags reach every one of them — so a **subtracted** template
  is a field of pits (worm-eaten wood, corrosion), a **paint** template is a
  mass of stains with no geometry at all, and a **mirrored** template is a
  symmetric mass. None of those needed a line of code.
- **It is one thing to the hands.** ▲▼ move the pair, ⧉ duplicates the pair
  (with a fresh seed, because the same seed beside itself is the same
  arrangement twice), ✕ deletes the pair. Clicking an instance in the view
  selects the **template**, because an instance is not a row anybody can edit.
- The header has no position and no dimensions, so it gets **no gizmo**. What
  it gets is its spread box, drawn as a wireframe. The **template's** gizmo
  moves the whole cluster.
- **The seed makes the mass stable across a facing set.** Eight facings are
  eight renders of one model, so they all expand to the same instances — the
  rubble does not reshuffle as the sprite turns.
- **The cost is time, not bytes.** March cost is linear in part count: measured
  at 96×96, this renderer does about **1.6 ms per extra part**, so a
  40-instance scatter adds roughly 64 ms per sprite and half a second to an
  eight-facing boot bake. The status line reports `3 → 13 parts` for that
  reason. The server refuses a model that expands past **256** parts.

### The viewport

The picture **fills the pane**, at whatever preview resolution is selected —
96 is drawn bigger than 240, because they are the same picture at different
resolutions and both are worth the same screen area. It used to be a fixed
480 px box, which meant 3x at 160 and 2x at 240.

- **Wheel** zooms, **middle-drag** or **space-drag** pans, **f** fits.
- **Whole-number scales only.** These are dithered indexed images and the
  dither is a decision you are making; a resampled preview of one tells you
  nothing about it. So "fit" is the largest whole multiple that fits, not the
  exact fraction — the picture fills the pane as far as square pixels allow
  and no further, and the leftover margin is the price.
- **It is not the camera.** `scale` and `vx`/`vy` are render parameters that
  get saved with the model: they change what the render CONTAINS. The
  viewport changes how large you see it and touches no document at all. Both
  zoom and both pan, which is why they are named apart.
- The sheet tab has **its own** viewport, because a sheet is a different shape
  from a model preview and wants a different magnification.
- The widget overlay covers the **pane**, not the picture, so the camera cross
  stays in the corner you are working in instead of scrolling away at 8x.
  **The gestures listen on the pane for the same reason.** They used to listen
  on the picture, which made every widget drawn outside it visible and dead —
  the camera cross always, and both light suns of any model whose bounds are
  more than about a third of `scale`. `tests/sdftool/test-widgets.mjs` presses
  through real browser input to keep it that way; a dispatched event fires on
  the canvas whatever its coordinates say, and cannot see this at all.

### The lights

There are **two**, and both are directions. A directional light costs nothing
per pixel, which is what lets the renderer afford a second one.

- **lights** (or the `l` key) puts a **sun** on each. **Drag one and it stays
  under the pointer** — the same contract a part drag has, and exact for the
  same reason: the camera is orthographic, so the screen-to-sphere mapping has
  no depth term. Grab a sun off centre and it keeps that offset, because the
  light turns by the rotation your hand made rather than snapping to it.
- A sun goes **dim** when the light is behind the model, which is how you see
  that you have made a rim.
- **Drag past the silhouette and the sun rides the rim.** Outside it there is no
  point of the sphere to track, so it follows the angle of your hand instead of
  flying off.
- **A drag holds its side.** Two points of the sphere project to every pixel —
  one in front, one behind — so a drag that picked the other root as it crossed
  the rim would read as the light jumping. **flip front / back** is how a light
  changes sides: it mirrors through the camera plane, which under an
  orthographic camera leaves the sun exactly where it is on screen and only
  changes the depth. **Aim it, then flip it: that is a rim light.** A light
  parked edge-on has no side to mirror, so the button pushes it behind.
- They are **hidden by default**. A light is aimed once and a part is moved all
  day, so the suns must not sit over the model waiting to be grabbed.
- **The second light is the wrap fill this renderer always had** — opposite the
  key, a tenth as strong, fully wrapped. It was a light with its direction,
  strength and wrap nailed shut; now they open. A model that touches none of
  them renders the same pixels it always did.
- **It follows the key until you drag it.** The first drag writes `l2x/l2y/l2z`
  and it stops following; **relink** deletes them and it follows again.
- **lock to camera** (`lcam`) aims both lights against the **screen** instead of
  the world: x right, y up, z toward you. **The suns stay where they are while
  you orbit**, so a facing set is lit from one side in all eight frames — aim
  the key once and every yaw agrees. Leave it off for a prop that keeps its aim
  in the world: a lamp lit by its own flame, a sign catching the sun.
  - Ticking the box **does not move the lights.** The aims are converted into
    the other space first, so only the *next* orbit behaves differently.
  - It is a **view dial** like any other, so `sdf.js` reads it at bake time and
    the sheet tab can override it per sprite. At yaw 0 pitch 0 the two spaces
    are the same, so a model turned on there renders the pixels it already did.
- **wrap** is what makes one dial cover three jobs. `0` is lambert — a key, or a
  rim when it is aimed away from the camera. `1` is `0.5 + 0.5 n·l`, the fill.
  So there is no light *type* to store.
- The **key** is not occluded and carries the specular; the **second** light and
  the ambient are occluded. A fill and a rim are wide soft sources, and
  occlusion is the cheap stand-in for their shadowing.
- **Σ** next to `ambient` is `ambient + key + fill`. The renderer was tuned at 1
  and the panel marks anything above it rather than clamping — over-driving is a
  choice, and a pale material clipping to flat white is what the headroom is for.

### Fog

`fog` mixes the surface toward the fog colour with **depth**, and it does it
**before the dither**, so the atmosphere lands in the palette rather than on top
of it. The ambient leans toward the fog colour as the fog comes up: the haze is
the sky, and the sky is what fills the shadows.

Depth is normalised by the model's own bounding radius, so `fog` means the same
thing on a crate and on a tree — 0 at the front of the sphere, `fog` at the back.

`fog` and its colour are **per-sprite dials** in the sheet, which is the point:
one model bakes clear for the foreground and hazy for the parallax layer behind
it, from four numbers on a row. `node tools/sdftool/look.mjs fog` shows the
range; `look.mjs light` shows a warm key, a cool fill and a rim.

### The view

- **The cross at the bottom left** is the camera. Drag it to orbit; drag its
  middle to **pan**. Panning writes `vx`/`vy`, a real render parameter (see
  "Fit"), not a tool-only offset.
- **Drag the model** to move the selected part, in the plane facing you. The
  camera is orthographic, so that mapping is exact and the round trip is
  lossless — drag 40 px right and 40 px back and the numbers return.
- **Drag the background, or shift-drag**, to orbit. Orbit measures the *hand*
  (a full turn per 400 px of screen travel, matching the noodletool) while a
  part drag measures the *canvas*, because the part has to stay under the
  pointer. They differ on purpose.
- **Both orbit axes push the near face**: you have hold of the side facing
  you, and it goes where your hand goes — the same rule the noodletool's orbit
  states. The directions were measured against the projection, not guessed: in
  `sdf.js`'s basis a positive yaw carries the far side left and a positive
  pitch carries it *up*, so rightward is `+yaw` and downward is `+pitch`.
  Pitch used to be negated, which made the vertical axis the inverse of the
  horizontal one — dragging down lifted the near face.
- **Click a part** in the view to select it. A subtracted part has no surface
  of its own, so clicking the hole selects what it was cut from.
- **shape mode** (`r`) draws the selected part's **cage**: the box its shape
  actually fills, in the part's own frame. It is measured with `supportLocal`
  (`tools/sdftool/fit.js`) — the same exact support function that crops sprites
  in the sheet tab, so the cage can never disagree with the crop, and a sphere
  gets a box that touches it rather than one 1.7× too wide at the corners.
  - It is the only picture of a **paint-only** part, which has colour and no
    surface, and of a **subtract** part, where you otherwise see the hole and
    never the cutter. A cut's cage is drawn warm.
  - A paint part's cage includes its **reach**: `shade` mixes its colour in for
    `blend` past where its shape would be, and that is the whole of what it
    does. A part with a surface is bounded by the surface.
  - It is **asymmetric**, because two primitives are — a pyramid grows from a
    base below its origin to an apex at it — and reaches may be **negative**: a
    capped torus is an arc about +Y, so its bottom face sits above the part's
    own origin.
  - A **plane** has no cage. It is a half-space and there is no box that means
    anything.
  - It is off for a multiple selection: a group's scale is uniform and has no
    one part's box to point at.
- **The round handle** — the blue diamond on the shape's corner in shape mode.
  `round` is a **dilation** on every primitive that has one (the shape is a core
  swept by a ball of that radius), so one handle serves the eight kinds no scale
  arm reaches: box, capsule, cylinder, cone, octahedron, hex prism, pyramid and
  tri prism. The other kinds' `round` is already on an arm, and they get no
  second control fighting over the same column.
  - **Nothing about it is a per-kind constant.** The anchor starts as the
    gradient of `supportLocal`'s 1-homogeneous extension — the shape's support
    POINT, which lands on the rounded corner of a box whose three half-extents
    all differ — and is then slid onto the real isosurface by asking `map`. The
    gain is measured the same way: grow `round` a little, see how far the
    surface moved.
  - That matters because three primitives disagree with the obvious answer. The
    octahedron rounds the **plane** distance, so its vertices sit at
    `a + round·√3` and its gain is 1.732. The pyramid and the triangular prism
    round by `max(plane distances) − round`, which dilates their faces but
    **chamfers** their edges — so along an edge the surface is nearer than
    `core + round`, and their gains come out 1.414 and 1.732. A table of
    constants would have been quietly wrong on all three.
  - The contract is the one every widget on this pane keeps: **the handle stays
    under the pointer**. `tests/sdftool/test-gizmo.mjs` measures it at 0.0 px.
- **Face handles** — the blue squares on the cage, in shape mode. Dragging one
  is **asymmetric**: the face you hold moves and the opposite one stays still,
  which takes two writes, half the drag into the dimension and half into the
  part's centre. That is what an adjustable bounding box means, and it is the
  whole difference from the scale arms. **Alt** resizes about the centre
  instead, which is what the arms do.
  - **They are not offered on every kind.** A cage is drawn round everything,
    but only some primitives are parameterised as a centre and half-extents, and
    only those have a face that can move on its own:

    | kind | faces |
    |---|---|
    | box, ellipsoid | all six |
    | cylinder, cone, hex prism | the two end caps |
    | tri prism | the two end caps (on z — but its half depth is column `b`) |
    | pyramid | its base only |
    | everything else | none |

    A cylinder's x and z faces are the same number, so a handle there would drag
    a pair of faces it never claimed. A sphere's six faces are one radius. A
    torus's cage touches it at four points that mean nothing. A control that
    lies about what it does is worse than no control.
  - The **pyramid** never moves the part: the format pins its apex at its own
    origin, so growing its height already moves the base and nothing else.
  - `tests/sdftool/test-faces.mjs` measures the far face against `map()` before
    and after a drag on a turned, off-origin part — it holds to 4e-14.
- **End handles** — the two blue rings on a **capsule**, in shape mode. It gets
  these instead of faces because its `a b c` is an axis VECTOR from the centre,
  not three half-extents: its cage is square to a frame the shape runs
  diagonally through, and none of that box's faces is a number anyone edits.
  - Dragging one **joint** places it in the plane facing you and leaves the
    other exactly where it was, writing the centre and the axis together. Same
    asymmetry a face handle offers, in three dimensions instead of one — this is
    how a limb is aimed.
  - The handle is on the **joint**, not the cap tip. The tip is `round` further
    out along the axis and the axis TURNS as the end is dragged, so a handle
    there would slide out from under the pointer by however much the direction
    changed.
  - It writes **no rotation**. `rx ry rz` are untouched — the axis is a vector,
    and pointing it is the whole of aiming a capsule. That is what lets a clip
    animate an end without fighting a rotation channel.
- **Drag any number** sideways to scrub it — Shift ×10, Alt ÷10. Shaping a
  model is feeling out proportions, and typing 0.42 into a box to find out what
  0.42 looks like is not that.
- **Click a number to type in it.** A number you already know — copying a value
  onto another part, squaring two dimensions off at exactly 0.15 — is not a
  gesture. The click selects what is there, so typing replaces it; **Enter**
  commits and **Escape** puts the old number back. A field that already has
  focus is an ordinary text box, and goes back to being a scrubber when focus
  leaves. One field serves all three tabs — `tools/sdftool/numfield.js`.
- The inspector shows **only the fields the primitive reads**. A sphere has no
  half-extents, so it is not offered three inputs that do nothing.
- **Materials.** Clicking a swatch **paints the selected part** with it, and
  the swatch in use is outlined — painting is the thing you do constantly, so
  it gets the plain click. **Double-click** a swatch to change what that colour
  IS, in **full RGB** — the browser's own colour dialog, not a grid of the 256.
  A material is not a palette entry and never had to be: `sdf.js` shades in
  true colour and quantises the RESULT, so the only colour that must exist in
  the palette is the pixel. The old grid restricted the source to protect an
  output that was never at risk, and it cost the reds and bright purples this
  palette is thinnest on. Judge the choice in the preview, which dithers and
  quantises exactly as the game bakes it. **Shift-click** deletes it:
  parts using it fall back to material 0, and higher indices are re-pointed
  rather than silently repainted.
- **Delete** (or Backspace) removes the selection, and a scatter goes as a
  pair. The last part in a model stays: a model with no parts renders nothing.
  The key is ignored while a field has focus, and while the part list is off
  screen on the sheet or anim tab.
- **Several parts at once.** **Shift-click** a row in the list, or **Ctrl-click**
  a part in the picture — shift over the picture already orbits, so the two
  panes take different modifiers. **Escape** goes back to one part.
  - The widget moves to the selection's **centroid** and turns about the
    **world's** axes, not the anchor's. Several parts have no shared frame, and
    using the anchor's would make the same drag do different things depending
    on which row you clicked first. The maths is `rig.js` — the same rigid
    group transform the anim tab uses, so a group turn carries each part AND
    turns it, rather than spinning each in place.
  - **Scale is uniform.** A per-axis group scale would have to push a WORLD
    axis into each member's `a b c`, which live in the member's OWN frame; the
    two coincide only while nothing is rotated. One factor on every length is
    defined for any arrangement. It scales `blend` too, or a shrunk group would
    fuse into a blob. It is safe on every primitive: on the two kinds where
    `a b c` are a direction rather than a length — the plane's normal, the
    capped torus's cap sin/cos — the renderer normalises them anyway.
  - **The inspector still edits one row**, the anchor, and says so. Only the
    widget acts on the group.
  - A **scatter header** cannot join a selection: its columns 1–6 are a seed, a
    count and spreads, so a group move would write a translation into the
    number that says how many pebbles there are. Its template is an ordinary
    row and joins fine.
  - The selection is dropped by anything that **renumbers rows** — add, delete,
    reorder, or an undo that changes the row count. A row index only means
    something against the list it came from.
- **Ctrl+Z** undoes — the parts, the materials **and the view**. A light is
  dragged the way a part is dragged, so undo has to take it back the same way;
  the side effect is that a camera orbit is undoable too.

## File format

One model per file, `src/js/models/<name>.js`, default export.

```js
// generated by tools/sdftool — [parts, mats, view]; stride 13, see src/js/core/sdf.js
export default [[
  0, 0, -0.1, 0, 0, 0, 0, 0, 0, 0, 0.42, 0, 1,
  2, 0.38, 0.02, 0, 0, 0, 0, 0.14, -0.22, 0, 0.11, 0.12, 1,
], [
  [0.3, 0.55, 0.35],
], {yaw: 0.06, pitch: 0.09, scale: 1.7, spec: 0.35}];
```

`[kind, x, y, z, rx, ry, rz, a, b, c, round, blend, mat]` per row. The
primitive is the low 5 bits of `kind`, **+32 subtracts**, **+64 paints**,
**+128 mirrors** across `x = 0`, **+256 marks a scatter header**; rotations are
in turns, about the part's own centre. One row per part because a model is read
by rows and a single long line is unreadable in a diff — whitespace costs
nothing after minification.

A **scatter header** is not a shape. Its thirteen numbers are
`[256, seed, count, sx, sy, sz, srot, sa, sb, sc, sround, sblend, smat]`, and
the row after it is the template it copies. A negative `count` is the ellipsoid
distribution — the sign convention the drawtool's own scatter op uses.

What the server refuses on save: a stride that is not 13, a kind it cannot
dispatch, and a material index with no material. Of a scatter: a header with no
template, a header carrying any other flag (subtract, paint and mirror belong on
the template, where they reach every instance), a seed of 0 (it degenerates the
generator), a count outside 1..64, a material spread reaching past the table,
and a model that **expands** past 256 parts. Bounds are otherwise deliberately
loose — a part outside the view is legal, just useless, and an editor that
refuses experiments is worse than one that lets you make something ugly.

## The sheet tab

A **sheet** is the list of sprites a game bakes: `src/js/sheets/<name>.js`, one
row per sprite id.

```js
// generated by tools/sdftool — [model, view, w, h] per sprite id; a 0 is a tombstone
import creature from '../models/creature.js';

export default [
  [creature, {yaw: 0}, 40, 40],
  [creature, {yaw: 0.125}, 40, 40],
  0,
];
```

- A row is `[model, view, w, h]`. The view holds only the dials this sprite
  **overrides**; everything else comes from the model's own view. So an
  eight-facing character is eight rows carrying one number each, over one
  model — the entire argument for a view-independent format.
- A row references the model, so editing the model updates every sprite that
  uses it. A sheet never copies geometry.
- The overridable dials include **`fog` and its colour**, and the two light
  **strengths**. That is how one model becomes both a foreground prop and a
  hazy, flat-lit thing on the parallax layer behind it. The light *directions*
  are deliberately model-level: a facing set that turned its light per sprite
  would light the same character from a different side in every frame. **Set
  `lcam` on the model** and the directions follow the camera instead, which is
  what a facing set wants and costs the rows nothing.
- **A `0` is a tombstone.** The index IS the sprite id and ids are permanent
  (the atlastool's contract): deleting empties the slot rather than shifting
  everything after it, so a game holding sprite 17 keeps meaning it.
- **The layout is not in the file.** Both bakers shelf-pack from the sizes at
  boot, so there is no x/y to author or keep in sync — nothing outside the game
  needs to know where sprite 7 landed. `width` in the panel is only what the
  game will pass to `sheetBaker`; changing it repacks and changes no ids.

### Fit — sprites that are not square

A sprite is square by default because the frame is, not because the art is. A
lamp post, a plank or a coin on edge wastes most of its rect, and an empty
pixel costs sheet space **and** bake time, because marching pays per pixel
whatever is in it.

- **fit** crops the selected sprite to its art, keeping its longest side. It
  writes `w`, `h` and three view overrides, because they are one decision:
  `scale` means world units across the *short* axis and so moves when the
  aspect does, and `vx`/`vy` are where the frame had to look to be tight.
- **fit set** gives every sprite of the same model **one shared frame** — the
  union of what each of them needs. **Use this on a facing set.** Fitting eight
  facings one at a time gives eight frames each centred on its own art, so the
  model's origin lands somewhere different in every rect and the character
  shifts under itself as it turns. A shared frame is a pixel or two looser and
  puts the origin in the same place in all eight.
- **fit all** crops every sprite independently. Right for a page of props,
  wrong for a facing set.

Fitting the eleven sprites in `src/js/sheets/props.js` takes them from 15,872
pixels to 11,984 — **24.5% less sheet and 24.5% less bake** — and the eight
facings come out between 24 and 37 pixels wide as the creature turns.

The bounds are analytic, not measured: each primitive's support function,
rotated and projected, rather than a render scanned for ink. That makes it
instant and available before a ray has been marched. It also duplicates
knowledge from `prim()` in `src/js/core/sdf.js`, so
`tests/sdftool/test-fit.mjs` renders every primitive and asserts no ink falls
outside the box predicted for it. Change one, run that.

In the game:

```js
import { sheetBaker } from '../core/sdfsheet.js';   // canvas host
import SHEET from '../sheets/props.js';
const baker = sheetBaker(SHEET, pal);               // step it from the loading screen
```

A fitted sprite's rect carries its own size, so draw from the rect table rather
than from a constant — the sizes in a fitted set are not all equal.

`src/js/core/sdfbake.js` is the same thing for a RetroBuffer RAM page.

The preview bakes through **that exact `sheetBaker`**, not a copy of it, so the
packing, the order and the pixels are the game's. Click a sprite in the sheet
to select it. Loading a sheet re-imports its models, and so does switching back
from the model tab — a model you just saved is the one the sheet bakes.

The server refuses a model that does not exist, a size that is not a whole
number in 1..512, and a view value that is not a number.

## The anim tab

A **clip** poses one model over time: `src/js/clips/<name>.js`. It is a sheet
row plus a frame count and a **dense table of numbers** — one value per
animated field per frame.

```js
// generated by tools/sdftool — [model, view, w, h, frames, fps, mode, channels]
// see src/js/core/sdfanim.js
import creature from '../models/creature.js';

export default [creature, {yaw: 0.25}, 40, 40, 6, 10, 0, [
  [56, 0.02, 0.06, 0.04, -0.02, -0.06, -0.04],   // part 4, col 4 (rx)
  ['vy', 0, -0.04, 0, 0, -0.04, 0],
]];

export const rig = {groups: [
  {name: 'left arm', pivot: [-0.38, 0.02, 0], parts: [2]},
]};
```

- `[model, view, w, h]` is the sheet-row prefix, unchanged, so `fit`, the view
  merge and the bake all mean what they already mean.
- `frames` is the sprite count. `fps` and `mode` are for the game to read
  (`0` loop, `1` pingpong, `2` once — `core/Animation.js`'s numbering).
- A channel is `[target, one value per frame]`. A **number** target is
  `part * 13 + column`; a **string** target is a view dial by name. **A
  spinning coin is a `yaw` channel**, not six posed models.
- `rig` is a **named** export the game never imports, so rollup drops it and it
  costs the zip nothing. Measured: 0 B. A clip with no rig still loads.

**Nothing interpolates at run time.** The tool writes the samples, so easing,
smoothing and holds are free — and `src/js/core/sdfanim.js` is a copy loop,
about 80–120 B in a game that uses one and 0 B in a game that does not.

```js
const HERO0 = SHEET.length;                       // this clip's first sprite id
const baker = sheetBaker([...SHEET, ...clipSheet(HERO)], pal);
// the frame at time t: HERO0 + ((t * HERO[5] / 1000) | 0) % HERO[4]
```

Ids are made at boot, after the sheet, so adding a frame can never move a
prop's id. The cost is that the stagetool cannot stamp a clip frame into a
stage; animated actors are drawn by the game.

### Editing

The tab **borrows the model tab's stage** — the same preview, the same part
gizmo, the same camera and the same suns — with the posed frame in it. What
changes is what a gesture means: **any edit is a key at the playhead**. Move a
part and every number that moved becomes a channel. There is no record button.

- The **filmstrip** under the picture is the frame cache, and it is the shipped
  bake: `clipSheet` fed to `sheetBaker`. Click or drag across it to scrub. A
  dot marks a frame a channel moves at.
- **Space** plays and pauses; **,** and **.** step a frame. Playback shows the
  baked frames, because the preview renderer makes one picture at a time.
- **Onion skin** — `off / prev / prev+next` — draws the neighbouring frames
  under the pose, aligned to the pixel.
- Scrubbing a channel's number re-bakes **only that frame**.
- **fit clip** is `fit set` over time: one frame that holds every pose. There
  is deliberately no per-frame fit — it would centre each pose on its own art
  and the character would shift under itself as it played. An animated
  `vx`/`vy` does not defeat it; the correction folds into the channel and the
  bob survives.

### Groups

A part rotates about **its own centre**, so an arm of three parts cannot swing
from a shoulder by rotating each of them. A **group** is a name, a pivot and a
list of parts. Turning it writes each member's new centre and rotation:

    c' = pivot + G·(c − pivot)        R' = G · R

The group is the **editor's**. It resolves into ordinary part numbers the
moment you turn it, so the format gains no transform hierarchy, `prepRot` gains
no matrix chain, and the game pays nothing. The pivot is kept in `rig` only so
you can grab it again. What it cannot do is bend or squash a part.

The orange square on the picture is the pivot: **turn** gives it rings in
**world** axes, **place** gives it arms, and moving a pivot moves no part.

Near ±0.25 turns of pitch the decomposition hits **gimbal lock** — the X and Z
rotations become the same rotation. The tool folds the roll into the yaw, keeps
the pose exactly right, and says so in the status line.

### What the server refuses

A model that does not exist; `frames` outside 2..64; `fps` outside 1..60; a
`mode` that is not 0..2; a size outside 1..512; `frames × w × h` past 300,000
pixels; a channel whose length is not `frames + 1` or whose values are not
finite; two channels on one target; a numeric target outside the model, on
**column 0** (`kind`), or on a **scatter header**; a `mat` channel that is not
a whole index; an **`x` channel on a mirrored part that goes negative**; a
string target that is not a view dial; and a group with a bad name, a pivot
that is not three numbers, a repeated part, or a part that is not in the model.

Column 0 is frozen because a part may not change primitive, flag or
scatter-ness part-way through a clip. A scatter header is frozen because its
seed and spreads decide the arrangement — animate the **template** under it and
the whole mass moves together.

## Preview

The preview renders through **the real runtime**, at the real palette. What you
see is what the game bakes.

`preview` sets the render size. Bigger is slower — cost is linear in pixels —
and 160 is a good working size; the sprite you bake in the game is a separate
number.

### The draft, and the held frame

A whole picture is **39.8 ms at 160 and 96.1 ms at 240** (creature, measured).
The renderer accumulates and cannot be patched, so every edit starts it over
from the top row, and it gets 8 ms of each frame. So a drag used to restart it
long before the second slice: you were looking at **the top fifth of the model
at 160, and the top twelfth at 240**.

Two rules fix it, and nothing else in the tool needs to know about either.

**1. While changes are still arriving, render a draft.** A 48×48 draft is
2.6–4.0 ms, so it finishes inside a single slice and every frame of a drag is a
complete picture of the current pose. 48 is fixed rather than derived from
`preview`, so a drag costs the same at 96 as at 240. The draft is the **same
picture, only coarser** — same lights, same occlusion, same fog. One that
dropped occlusion would be faster and would lie about the look, and judging the
look is what the preview is for.

**2. Never paint a partial frame when a finished one exists.** That is the wipe
and the blanking together: on release the last draft stays up — the current
pose, coarse — until the full render lands. A stale full frame of the *previous*
pose would be worse than either. The status line says `48x48 draft` while it is
in one.

What puts it in draft is **a change or a movement, never a pointer being down**.
A press that selects a part changes no pixel and does not re-render at all. A
gesture that knows it is moving says so; anything else is caught by a rule that
needs no cooperation — a restart arriving while the last render is unfinished is
changes coming in faster than they can be drawn. That is why every scrubber in
both inspectors drafts with no code of its own.

Full resolution comes back **on release**, caught at the window so it works for
a gesture that started anywhere. A stream that ends without a release — a held
key — settles 250 ms after the last change.

Two exceptions to rule 2, both deliberate: nothing has finished yet (an empty
pane at boot is worse than a wipe), and a render past 500 ms, where watching it
arrive beats watching nothing.

The **sheet tab** takes rule 2 and not rule 1: it holds the last completed bake
through the next one, so scrubbing a sprite dial no longer makes the whole sheet
flicker and repopulate sprite by sprite. A draft resolution would be wrong
there — a sheet's packing is derived from the sprite sizes, so a half-resolution
sheet is a different **layout** rather than a coarser picture of the same one.

The palette is the **generated** one (`src/js/core/palette.js`), because that
is what the new stack ships. A model authored here is a model the game
reproduces exactly.

It is generated from 96 bytes of human numbers, not from a formula: the dark
and light end of each of the 32 ramps, sampled from the authored
`src/assets/palette.png` at 4 bits a channel, with the six shades between them
interpolated. A purely procedural version shaded perfectly well and was 0.589
away from the authored palette entry for entry — a different palette wearing
the right structure. The sampled endpoints cost 55 bytes more and are 4.4×
closer.

## The look

`node tools/sdftool/look.mjs <set>` renders a dial's settings side by side into
`.artifacts/sdf/look-<set>.png` and prints what each costs. Sets: `exposure`,
`spec`, `ao`, `outline`, `shadow`, `light`, `fog`, `all`.

The defaults were chosen from those sheets, not from taste:

- **occlusion 1** — 11% more time, and it is what makes a groove read as
  geometry rather than paint. The best value in the renderer.
- **specular** is *screened* in rather than added, so a highlight can never
  clip a surface to flat white. The light weights sum to 1 for the same reason.
- **outline 0**. It costs no data — this palette is 32 ramps of 8, so darkening
  is arithmetic — but darkening inside a ramp assumes the pixel's ramp is the
  surface's ramp, and the dither breaks that at the margins: a stray pixel from
  a neighbouring ramp darkens toward *that* ramp's dark end, which on a grey
  model is a coloured speck. **1 step** is under the threshold where that
  reads. 2 and 3 fringe.
- **shadow 0**. 45% more time for contact darkening occlusion has mostly
  already drawn at sprite sizes.
- **mirror costs 8 bytes and scatter costs 233** (6,426 → 6,434 → 6,667,
  measured with the PINNED roadroller flags, because `npm run build`'s `-O2`
  search varies about ±15 B between identical builds and would drown a number
  this size). Symmetry is a fold in the hot loop, so it is nearly free; the
  scatter is the expansion, and it buys 26 numbers for a forty-piece mass.
  The ellipsoid distribution is 37 of those 233 bytes.
- **two lights and fog cost 60 bytes in the zip** (6,319 → 6,379) and a few
  percent of render time. That is the whole feature: a steerable key, a
  steerable fill or rim, per-light colour and wrap, and depth haze. It is cheap
  because both lights are directions — a point light would put a normalise and a
  falloff in the per-pixel path and would make the widget's distance mean
  something the format would then have to store.
- **the dials are not written when they sit on their default**, so a model that
  uses none of this is the same file it was.

Surface noise (for rock and bark irregularity) is deliberately absent: 310 B
compressed before any per-pixel cost, and as a domain distortion it slows the
march as well. Revisit when something actually looks wrong.
