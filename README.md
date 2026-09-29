# Multipart3D Local

A local macOS app wrapping [multipart3d.com](https://multipart3d.com/) (by Roy Roeven,
dreamlayer.nl). The whole website is mirrored into `site/` and served from a
loopback-only HTTP server inside Electron, so the tool runs with no internet
connection and nothing leaves the machine.

Installed at `~/Applications/Multipart3D Local.app`.

## What was actually slow

Initially I assumed the lag was the **Manifold** WebAssembly mesh-boolean module
running single-threaded on the main thread. A CPU profile of a plain orbit on a
500k-triangle model said otherwise:

```
1884.9ms  47.9%  (idle)
 773.0ms  19.6%  checkIntersection      <- ray/triangle
 735.0ms  18.7%  getVertexPosition      <- ray/triangle
 231.1ms   5.9%  _computeIntersections  <- ray/triangle
   3.9ms   0.2%  projectObject          <- actual rendering
```

**~45% of main-thread time was ray/triangle intersection, and under 1% was
rendering.** three.js `Mesh.raycast()` has no acceleration structure, so every
pointer move tested all 499,868 triangles: measured at 18.3 ms per raycast. The
GPU was almost idle the whole time. The actual cut, for comparison, takes 713 ms
— it was never the bottleneck.

The fix is `src/mp3d-bvh.js`: a bounding volume hierarchy used as a broad phase.

| | Before | After |
|---|---|---|
| Time per raycast | 18.3 ms | 0.015 ms |
| Triangles tested per raycast | 499,868 | 31 (avg) |
| Frame time p90 while orbiting | 29.2 ms | 9.3 ms |
| Frame time p99 | 30.2 ms | 10.2 ms |
| Main thread idle | 47.9% | 90.7% |

Frame times are now at the 120 Hz display refresh rate, so the viewport is
limited by the monitor rather than by CPU. One-time BVH build cost is 140 ms for
500k triangles, done on an idle callback so no interaction stalls.

Wrapping the site locally also gets you: no competition with other browser tabs,
no background throttling, a hang confined to this window instead of the whole
browser, no network, and no analytics beacon.

### Why the BVH is only a broad phase

The BVH narrows candidates and then hands them to **three.js's own untouched
intersection code**. Nothing reimplements the ray/triangle math, because the cut
tools depend on exact hit data (`distance`, `point`, `face`, `faceIndex`, `uv`,
normals).

Mechanically: `geometry.index` is temporarily pointed at a scratch buffer holding
only the candidate triangles, with `drawRange` set to match, then both are
restored in a `finally`. The scratch buffer holds original vertex indices, so
`face.a/b/c` stay correct; only `faceIndex` needs remapping, and the candidate
list provides that mapping.

Anything unusual falls through to the original implementation: morph targets,
skinning, instancing, multi-material groups, and meshes under 20k triangles
(where brute force is already fast).

`tools/verify-raycast.js` is the guard on all of this. It fires 500 rays from all
directions and compares accelerated vs. original results field by field:

```
raysCompared: 500,  bothHit: 320,  bothMiss: 180,  mismatchCount: 0
originalTotalMs: 9167.9,  acceleratedTotalMs: 7.4,  speedup: 1238.9x
```

Zero mismatches. Cut output was also confirmed unchanged: `Perro.stl` still
splits into 42×48×25 mm and 45×50×25 mm, `Baby+Alien.3mf` into 76×84×111 mm and
78×84×97 mm — identical to the pre-patch baseline.

If you ever suspect the acceleration, **Performance → Raycast Acceleration**
toggles it off at runtime, and **Show Raycast Statistics** reports what it is
doing.

### Known remaining issue: dragging the cut gizmo on a scaled-up model

Not fixed. Orbiting is smooth, but dragging the Area Cut plane on a model scaled
to ~1100 mm still lags.

I could not reproduce it under automation, so I have no profile of it and
therefore no diagnosis. What was ruled out:

- Scaling the model up genuinely works via the Z size field (verified by
  world-space bounding box: 50 mm → 1099.9 mm, model 998 × 1100 × 1100 mm).
  Note that MODEL INFO "DIMENSIONS" keeps showing the original file size, so it
  is useless for confirming scale.
- Dragging the **POS U slider** on a scaled model profiles clean: 94% idle,
  frame p90 9.1 ms. Either that path is genuinely cheap or the drag was a no-op
  (never verified that the slider value changed).
- Dragging the **gizmo** could not be driven at all. Pressing at the gizmo's
  projected centre grabs nothing, and hover-probing three's
  `TransformControls.axis` over a ±200 px grid never reported an axis. The
  scene does contain a `TransformControlsGizmo`, but the Area Cut handles in the
  UI (centre sphere plus arrows) may belong to a different control, so the drag
  landed on empty space and the preview recompute never fired.

The next step, if it gets annoying enough: find the interactive objects by
listing scene objects that carry r3f pointer handlers (`object.__r3f`) and their
projected screen positions, then drag one of those. `tools/probe-handlers.js`
was written for this but never run. Failing that, profile with a human doing the
drag: start `Profiler.start` over CDP, drag by hand for ~15 s, then dump.

My working hypothesis is the amber/red preview recolour: a full pass over
499,868 triangles plus a colour-buffer re-upload on every pointer move. Untested.

### Why the patch is wired in the way it is

The bundle exposes no `THREE` global, and r3f runs its own React reconciler, so
the three.js scene lives in a fiber tree that is unreachable from the DOM
(`canvas.__r3f` does not exist; crawling react-dom's tree finds nothing). So
`tools/sync-site.mjs` makes two edits to the mirrored bundle:

1. three.js's `Mesh` constructor publishes the first instance it creates
   (`this.isMesh=!0` → also sets `globalThis.__mp3dMesh`). Walking up from that
   instance to whichever prototype owns `raycast` yields `Mesh.prototype`.
2. A dynamic `import("/mp3d-bvh.js")` is appended to install the patch.

The sync script **throws** if either anchor is missing, so an upstream change
cannot silently leave you running unpatched.

## Layout

```
main.js                  Electron main: static server, window, network rules, menus
src/mp3d-bvh.js          Raycast acceleration (copied into site/ by sync)
site/                    Mirrored website (HTML, JS, CSS, WASM, images, HDRI, fonts)
tools/sync-site.mjs      Re-mirror + re-patch the site
tools/smoke-test.mjs     End-to-end check: load a real model, confirm the viewport
tools/verify-raycast.js  Differential test: accelerated vs original raycast
tools/profile.js         CPU profile of a real orbit, driven over CDP
tools/diag-page.js       Renderer/GPU stats and frame timing
tools/probe-scene.js     Fiber-tree search for the r3f store (diagnostic)
build/icon.icns          App icon
dist/                    Packaged .app output
```

## Suppressed dialogs, and the stable-port fix behind it

The "Welcome" dialog and the "Enjoy your multipart!" dialog are both gated on
the app's own localStorage flags:

| Key | Value | Effect |
|---|---|---|
| `m3d.introSeenRevision` | `2` | Welcome dialog already seen |
| `m3d.thanksHidden` | `1` | post-download dialog dismissed forever |

`tools/sync-site.mjs` generates `site/mp3d-prefs.js`, which sets both, and
injects it into `index.html` as a classic script so it runs before the app
module (module scripts are deferred). No DOM hacking, no React patching — the
app simply believes you already dismissed them.

The flag *values* are read out of the bundle rather than hardcoded, because the
intro is gated on a revision string upstream can bump. If those flags can't be
found, sync throws rather than silently leaving the dialogs on.

**The underlying bug was the server port.** It used to be `listen(0)`, a random
port per launch. Since an origin is `scheme://host:port`, every launch got a
brand-new empty localStorage — which is why these dialogs came back every time
and why "Don't show this again" never worked. The server now prefers a fixed
port (47615, falling back through 47618, then random with a warning), so the
app's settings actually persist. Printer choice and other preferences benefit
too.

To get the dialogs back, delete `site/mp3d-prefs.js` and its `<script>` tag from
`site/index.html`, or run with `MP3D_NO_PREFS=1`.

### Verifying dialog suppression

`MP3D_TEST_DIALOGS=1` loads a model, cuts it, clicks download, and reports
whether either dialog appeared:

```sh
cp ~/some-model.3mf site/__smoke.3mf

# Control: blocks the seed and clears the flags, so both SHOULD be detected
MP3D_SMOKE=1 MP3D_SMOKE_FILE=__smoke.3mf MP3D_TEST_DIALOGS=1 MP3D_NO_PREFS=1 npx electron .

# Real run: expect clean: true
MP3D_SMOKE=1 MP3D_SMOKE_FILE=__smoke.3mf MP3D_TEST_DIALOGS=1 npx electron .
```

Always run the control. A test that reports "clean" is worthless unless you have
shown it can detect the thing it's checking for. Measured: control reports
`introVisible: true, thanksVisible: true`; the real run reports
`clean: true` with the download still completing.

## Colour-preserving 3MF export

Cutting a painted 3MF used to give you unpainted parts. The app already read
Bambu/Orca paint on import (one filament number per triangle) and carried it
through the cut. The stock 3MF writer then threw it away and gave each part a
single display colour.

`src/mp3d-color-export.js` replaces that writer for parts that carry paint. It
writes per-triangle `paint_color`, the attribute Bambu Studio and OrcaSlicer use
for MMU painting.

- **Project mode** (the source was a slicer project): the source's
  `Metadata/project_settings.config` is copied back verbatim and the model is
  marked as a Bambu project. The slicer then gets the filament count and colours
  as well as which triangle uses which filament. The part is placed at the bed
  centre, because slicers don't auto-arrange objects inside a project.
- **Plain mode** (no source config): the stock format plus `paint_color`. The
  painted regions survive, shown in whatever filaments the slicer has loaded.

Cut faces (label 0, no source triangle) take the part's main filament.
STL export can't carry colour, so it's unchanged.

**Limitation:** the app's importer reduces each painted triangle to its
dominant filament. Paint finer than one triangle, which Bambu stores as a
subdivision tree (for example `0442`), becomes whole-triangle paint. Borders
between colours can look slightly more jagged than in the original. On your
high-res meshes this is at triangle scale. Fixing it would mean changing the
cut engine, not the exporter.

`tools/sync-site.mjs` patches the bundle so the stock writer calls this
exporter. If the exporter throws, it falls back to the stock export (you get
unpainted parts, not a failed download). The patch finds its targets by code
shape rather than by minified name. Sync throws if any target doesn't match
exactly the expected number of times.

### Verifying

```sh
zsh tools/color-run.sh ~/Downloads/painted.3mf /tmp/run.txt      # load, cut, export 3MF zip
zsh tools/verify-color-export.sh <parts.zip> ~/Downloads/painted.3mf
```

The verify script prints each part's paint histogram as written, then loads
the part in Bambu Studio's CLI. It reads Bambu's own re-export back, so the
check is what Bambu understood, not what we meant to write.

Measured on `Flexi+Long+Snake.3mf` (1.43M triangles, 393,216 painted, 2
filaments), using the packaged app:

| | triangles | painted (filament 2) | filament_colour |
|---|---|---|---|
| source | 1,429,660 | 393,216 | `#FFFFFF, #000000` |
| part 1, as written | 1,156,770 | 393,216 | `#FFFFFF, #000000` |
| part 1, after Bambu load | 1,156,770 | 393,216 | `#FFFFFF, #000000` |
| part 2 | 292,434 | 0 (that half was unpainted) | same |

All 393,216 painted triangles landed in part 1, and Bambu read every one.
`SUP3R Middle finger alien.3mf` also round-trips cleanly through Bambu.

Not verified in Bambu:
- `alien humanoid 3d model.3mf` won't cut at all. The app reports "Not
  manifold", meaning the mesh itself is broken.
- `hi3d-Ghost-Face-refined.3mf` cuts and exports with its 7 filament colours,
  but Bambu's CLI rejects the **original** file as well as our parts. Its config
  has `skin_infill_line_width` = 100, which fails validation. Bambu's GUI may be
  more lenient. That config is copied from the source, so fixing it in the
  slicer and re-saving would fix both.

## Paint-preserving mesh repair

If a cut fails with "(Not manifold)", the mesh isn't a closed, consistently
facing surface, so the cut engine refuses it. The local build adds a repair
for this that keeps the paint.

Repair is its own feature; you don't need to cut anything. Ways in:

- **Repair a 3MF file…** on the start screen (next to "Try demo model"), or
  **File › Repair 3MF File…** (⌘⇧R): standalone. Pick a file, choose where the
  `_repaired` copy goes (it never overwrites the original), and it's saved.
  Nothing is loaded unless you press **Open in app**; **Show in Finder** is
  there too.
- **Repair** in the top toolbar (next to New File), or **File › Repair Current
  Model**: repairs the loaded model, loads the fixed version and offers
  **Save repaired 3MF…**. With no model loaded it falls back to the standalone
  flow.
- **Repair model (keeps colours)** in the cut tool's red "Not manifold" error:
  same as the toolbar button.

A model that is already clean reports "No problems found" and is left as it
is (nothing is reloaded, so work in progress isn't lost).

Only 3MF is supported, because that's where the paint lives.

### What it does

`src/repair/core.js`, in order:

1. join vertices at identical positions
2. drop collapsed triangles
3. drop duplicate triangles, keeping a painted copy if there is one
4. make triangle winding consistent across each piece (flip the minority)
5. fill holes: one triangle for 3-edge holes, ear clipping for small ones, a
   centre fan for anything else
6. repeat 3–5 until clean, then flip any piece that faces inwards

### Paint

- Original triangles are written back with their **original attribute text**,
  so `paint_color` survives byte for byte, fine sub-triangle detail included.
- New fill triangles take the surrounding colour when the whole hole sits
  inside one plain colour region. Holes on a colour border are left unpainted,
  so they show in the object's base filament and you can paint over them in the
  slicer. The summary tells you how many there are.
- The one lossy case: a flipped triangle with sub-triangle paint is reduced to
  its main filament, because that detail is laid out relative to the corner
  order and would come out mirrored.
- Everything outside the meshes (project settings, filament colours, plates,
  thumbnails) is copied through unchanged.

The heavy work runs on a worker thread in the main process (`service.js`,
`worker.js`), so the window stays responsive. `preload.js` gives the page only
`window.mp3dRepair` (repair, save, progress), and the main process only answers
requests from our own `127.0.0.1` page.

### Measured on `alien humanoid 3d model.3mf` (1.94M triangles)

| | before | after |
|---|---|---|
| Bambu: open edges | 48,738 | 0 |
| Bambu: reversed faces | yes | no |
| Bambu: parts | 136 | 1 |
| volume | 1.38156e+06 | 1.38156e+06 |
| triangles | 1,943,506 | 1,943,516 |
| cut in app | Not manifold | 2 parts, colours exported |

About 12 s in the packaged app. The 48,738 open edges Bambu reports were
mostly 24,492 split vertices; once those are joined, 24 real open edges
(7 holes) remain. Every one of the 1,943,506 original triangles kept its exact
paint (`tools/compare-paint.cjs`). 10 new triangles: 4 took the surrounding
colour, 6 on colour borders were left in the base filament (these numbers count
each geometric triangle once). Every non-mesh file is byte-identical. Clean
files (`Flexi+Long+Snake`, `SUP3R Middle finger alien`) come out unchanged.

That alien file's own print settings have `skin_infill_line_width` =
`skeleton_infill_line_width` = 100, which Bambu's CLI rejects (the original too).
To read Bambu's mesh stats I reset those two values in a throwaway copy. The
repaired file keeps the original settings.

### Testing

```sh
node tools/repair-selftest.cjs                         # synthetic damage, 6 cases
node tools/mesh-diag.mjs file.3mf                      # what's wrong with a mesh
node tools/repair-3mf.cjs in.3mf out.3mf               # repair from the command line
node tools/compare-paint.cjs in.3mf out.3mf            # prove paint survived
zsh tools/repair-run.sh broken.3mf /tmp/log.txt        # in-app: fail, repair, cut, export
zsh tools/standalone-run.sh broken.3mf clean.3mf       # packaged app: start screen + toolbar flows
```

`standalone-run.sh` bypasses the native dialogs via `MP3D_TEST_PICK_IN` /
`MP3D_TEST_PICK_OUT`. `MP3D_CAPTURE=/path.png` saves a screenshot of the window.

The self-test damages icospheres in known ways (1% of triangles removed,
duplicates, flips, a 58-edge hole across a colour border, half a sphere
missing, an inside-out piece, split seams, a collapsed triangle, a clean mesh)
and checks each result is closed, faces outwards, and kept every surviving
triangle's paint.

**Limits:** the repair fixes holes, duplicates and winding. It does not fix
self-intersecting surfaces (parts that pass through each other). If the summary
says "partly repaired", or the cut still fails after repair, that's the likely
cause.

## Auto-cut to fit printer

**Auto-cut to fit** (side panel, under Build Volume) cuts every part that
doesn't fit the selected printer until all parts fit, and adds connectors on
each cut face. Paint is kept. Options: clearance from the bed edge (default
5 mm) and connectors on/off. The connector type and size come from the cut
tool's **Add Connectors** settings (plug by default).

`src/mp3d-autocut.js` drives the app's **own** cut pipeline through its store
(`selectPart → enterCutMode → setCutNormal/Origin → enterConnectorsStage →
addConnectorAtWorld → confirmCut`). So every cut is a normal cut: paint is
carried the same way, it's an Undo step, and colour 3MF export works as
before. `tools/sync-site.mjs` exposes the two stores as
`globalThis.__mp3dCutStore` / `__mp3dPrinterStore`.

How it chooses cuts:

- A part fits if its three sizes, largest first, fit the bed's (90° turns
  allowed).
- It cuts the biggest non-fitting part across its worst axis, at a split that
  leaves the rest coverable in the fewest pieces.
- It tries 9 plane positions, scored by the cut face. One large solid face
  beats many small ones, so it avoids cutting through fingers. A plane in a
  gap between separate pieces is preferred.

Connector safety, from failures found while testing:

- Spots too close to the face edge, or where the wall behind is thinner than
  the connector, are skipped.
- **Overlapping shells:** the GF model is 4 shells pushed into each other.
  Connectors cut where shells overlap come out with doubled surfaces
  (non-manifold edges). A ray-parity test skips those spots.
- **Verify, then undo:** after each cut, if a clean part came out with
  non-manifold edges, that cut is undone and redone glue-only.
- **Zero-thickness walls:** the cut engine sometimes leaves a coincident,
  opposite-facing disc inside a plug pin. Those triangle pairs are removed
  (they enclose no volume).

Measured on the packaged app, 6 ft `GF Larrge` (800 × 1800 × 725 mm, 2.03M
triangles, 4 filaments) on the Kobra S1 Max (350³):

| | |
|---|---|
| result | 29 parts from 1, 28 cuts, 29 / 29 fit |
| time | ~2 minutes |
| connectors | 100; 7 joints glue-only (too small or overlapping shells) |
| Bambu mesh check | 29 / 29: 0 open edges, 0 non-manifold, no reversed faces |
| paint | colours and the 4-filament project carried into every part |

Also: repaired alien ×3 on AD5X (6 parts, 6 / 6 clean), snake on AD5X
(3 parts, 3 / 3 clean).

The setup panel's piece count is a box-based upper bound; real shapes usually
need fewer (54 estimated vs 29 for GF).

**Limits:**
- Planar cuts only (no dovetails).
- A 3MF must be watertight to cut. If it isn't, the result panel offers
  Repair.

Test:

```sh
zsh tools/autocut-run.sh model.3mf anycubic-kobras1max [scale] [app-binary]
zsh tools/check-parts-zip.sh parts.zip             # our mesh check per part
zsh tools/bambu-mesh-check.sh part.3mf             # Bambu's own mesh stats
```

## Plates and project export

**Plates & project export** (Parts panel, under Arrange) opens a plate
planner for the selected printer:

- **Auto-arrange** packs every part onto as few plates as it can. Parts keep
  their orientation if it fits, otherwise they're laid flattest side down, and
  they may be turned 90°. The printer's no-print zone (`bed_exclude_area`,
  e.g. the P1S calibration corner) is kept clear.
- Each part has a plate picker, and you can add plates or remove empty ones.
  A top-down drawing shows every plate.
- **Export project 3MF** writes one Bambu/OrcaSlicer project: every part on
  its plate, the paint, and the printer + filament settings. The bed size is
  set to the selected printer.
- Settings come from the loaded model if it was a slicer project. **Use
  settings from another 3MF…** takes them from any project saved for your
  printer; the dialog warns if the profile names a different printer.
- The prime tower isn't placed; it keeps the project's own position on every
  plate. Move it in the slicer if it lands on a part.

How Bambu reads plates, verified with its CLI (`tools/make-plates-probe.cjs`):
plates are listed in `Metadata/model_settings.config`, each object must
physically sit inside its plate (plate origins on Bambu's grid: columns ≈
√count, stride 1.2 × bed), and a full `project_settings.config` is required.
Meshes go in `3D/Objects/object_N.model`, the layout Bambu itself writes.

Tested (`zsh tools/plates-run.sh model.3mf printer-id [scale] [cut]`):

- Snake ×2 on P1S (packaged app): auto-cut → 4 parts → 2 plates. Bambu
  sliced both plates; 393,216 painted triangles in the file; plate 2 uses
  filaments 1 and 2.
- 6 ft GF on Kobra S1 Max: 29 parts → 21 plates, painted triangles kept.
  Bambu's CLI refuses this project's own settings: the source already has
  out-of-range values (`retraction_distances_when_cut`, two 100 mm line widths)
  and a custom filament-change G-code its CLI can't parse. Past those, it
  reached the prime tower on plate 4, which you move by hand. Not sliced end
  to end.

## Adding a printer to the built-in list

The printer dropdown is a flat array in the bundle, one entry per printer,
grouped by brand in the order they appear. `tools/sync-site.mjs` has an
`EXTRA_PRINTERS` list of `{ after, entry }` pairs: `after` is the exact entry
the new one should follow, `entry` is the printer to insert. Sync throws if
`after` isn't found exactly once, so a silently-skipped addition isn't
possible.

Currently added:
- Anycubic Kobra S1 Max — 350 × 350 × 350 mm
- Flashforge AD5X — 220 × 220 × 220 mm
- Flashforge Creator 5 — 256 × 256 × 256 mm (new brand section, inserted
  between Elegoo and Voron to keep the list's alphabetical brand order)

To add another, find its brand section in `site/assets/index-*.js`, copy the
`after` entry verbatim from there, and add a new pair to `EXTRA_PRINTERS`
following the same `{id, brand, model, buildVolume:{x,y,z}}` shape.

## Updating when the website changes

The bundle filenames are content-hashed, so refreshing individual files is not
enough. Re-mirror, verify, repackage:

```sh
node tools/sync-site.mjs
node tools/smoke-test.mjs ~/Downloads/Perro.stl
npm run package
rm -rf ~/Applications/"Multipart3D Local.app"
cp -R "dist/Multipart3D Local-darwin-arm64/Multipart3D Local.app" ~/Applications/
```

`sync-site.mjs` walks the JS bundle for asset references, so new chunks and
images are picked up automatically. It prints a warning if a URL it needs to
rewrite has disappeared.

## Offline patches applied to the mirror

Two runtime dependencies point at third-party CDNs. Both are made local:

- **HDRI lighting** (`drei`'s `city` preset, from `raw.githack.com`) — the file is
  downloaded to `site/hdri/` and the base URL in the bundle is rewritten.
- **Font data** (`unicode-font-resolver`, from `cdn.jsdelivr.net`, used by the 3D
  labels) — mirrored to `site/fontdata/`. This one is fetched from inside a
  blob-URL worker where a root-relative path has no base to resolve against, so
  the bundle is left untouched and `main.js` redirects the request at the network
  layer instead, where the server port is known.

## Development

```sh
npm start            # run from source
npm run package      # build the .app into dist/
```

Test hooks (environment variables read by `main.js`):

| Variable | Effect |
|---|---|
| `MP3D_SMOKE=1` | Print a renderer report, then quit |
| `MP3D_SMOKE_FILE=<name>` | Load that file from `site/` through the app's file input |
| `MP3D_SMOKE_CUT=1` | Open Planar Cut and apply it (exercises the WASM path) |
| `MP3D_CUT_LABEL=<text>` | Label of the apply button (default `apply cut`; the UI uses `place cut`) |
| `MP3D_PROBE=1` | Dump the visible button labels |
| `MP3D_LOG_EXTERNAL=1` | Log every non-loopback request |
| `MP3D_OFFLINE_TEST=1` | Refuse every non-loopback request, to prove offline operation |
| `MP3D_MAXIMIZE=1` | Maximize the window (profile at a realistic size) |
| `MP3D_PROFILE=1` | CPU-profile a real orbit; prints hot functions with source excerpts |
| `MP3D_VERIFY=1` | Run the differential raycast correctness test |
| `MP3D_DIAG=1` | Print GPU status, canvas size, frame timings |
| `MP3D_PROBE_SCENE=1` | Try to locate the r3f store via the React fiber tree |

Useful combinations:

```sh
# Is interaction smooth? (frame times, hot functions)
MP3D_SMOKE=1 MP3D_SMOKE_FILE=__smoke.stl MP3D_PROFILE=1 MP3D_MAXIMIZE=1 \
  sh -c 'cp ~/Downloads/Perro.stl site/__smoke.stl; npx electron .; rm site/__smoke.stl'

# Is the acceleration still exact? (must report mismatchCount: 0)
MP3D_SMOKE=1 MP3D_SMOKE_FILE=__smoke.stl MP3D_VERIFY=1 \
  sh -c 'cp ~/Downloads/Perro.stl site/__smoke.stl; npx electron .; rm site/__smoke.stl'
```

Re-run the verify test after any upstream sync. It is the only thing standing
between a subtly wrong hit record and a subtly wrong cut.

Verified with `MP3D_OFFLINE_TEST=1`: a 23.8 MB STL and a 6.5 MB 3MF both load,
cut into two parts with correct dimensions, and export options appear — with zero
external requests and no renderer errors.

## Notes

This is a personal offline copy of someone else's free tool. Don't redistribute
it. The upstream project is worth supporting directly:
<https://multipart3d.com/support>.

The bundle is ad-hoc signed, not notarized. That is fine for an app built and run
on this machine; macOS only applies Gatekeeper checks to bundles carrying a
quarantine attribute.
