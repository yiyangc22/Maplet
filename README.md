# Maplet — a local viewer for spatial single-cell data

![demo_image](maplet-demo.png)

A local, standalone desktop app for **interactively viewing sequenced cells in 3D** —
their location, outline, cell-type calls, spatial barcodes, methylation, and any
custom variables — loaded from a plain **CSV / TSV spreadsheet** (one row per cell,
opens in Excel). **When a file loads, the app shows every column and asks you to
assign each one** — an id, a coordinate axis (up to four linked maps), or a
**numerical** / **categorical** variable — so nothing is hard-coded and the header
needs no special notation.

Same code runs on **Windows, macOS, and Linux**. It also runs as a plain web
page in any browser. The look follows the ThreadMap prototype: black/grey/white,
sharp edges, JetBrains Mono, color reserved for meaning (amber = selection/active).

## What it does

- **3D point cloud** of every cell at its `xyz`, orbit / pan / zoom.
- **Assign columns on load.** A dialog lists every column with example values and
  a proposed role (guessed from names + values); you confirm or change each — id,
  a coordinate axis of **map 0** (the main viewer) or maps **1–3** (smaller linked
  viewers, e.g. a UMAP or a second assay), or a **numerical** / **categorical**
  variable. Two types, nothing else.
- **Color by any variable** — a **numerical** ramp (perceptual colormap + colorbar,
  linear or log) or a **categorical** palette + legend. A categorical with thousands
  of distinct values is left out of the colour menu (a colour per value would be
  noise) but still filters normally.
- **Filter by any variable** — a **min/max range** for numerical variables, and for
  categorical ones a **searchable, scrollable checkbox list** of every distinct
  value (tick to include, untick to exclude) that works the same whether there are
  5 values or 50,000. Filtered-out cells ghost or hide; the "shown" count updates live.
- **Select & inspect** — click a cell to see its cell-type and barcode values, its
  methylation, and every custom value.
  **Hover** shows a basic tag near the cursor (ID + type); **select one** cell for
  full detail on the right; **select many** for a summary (cell-type composition
  **pie**, average methylation, average call confidences, region/section
  composition) — and then hovering shows the full card near the cursor. Selected
  cells show their segmentation **outline** when the file provides one.
- **Linked auxiliary viewers.** Assign an embedding's two columns (a UMAP, a second
  assay's coordinates, …) to **map 1** (or 2/3) on load, and each gets its own small
  scatter beside the 3D view. Hovering or selecting in any viewer **highlights the
  same cells in all of them**.
- **Select a cluster or a region.** The **same color** button (details panel)
  grabs every cell of the current cell's color — click a UMAP cluster, get exactly
  those cells in 3D. The **lasso** toolbar toggle lets you draw a freehand boundary
  in either view and select everything inside (shift-drag adds; Esc cancels).
  Selected cells get a **white** boundary in both views.
- **Custom variables are first-class.** Any column you add becomes
  colorable/filterable automatically — the app is **not** hard-coded to a fixed set
  of columns. You set each column's role (and its numerical / categorical type) in
  the **load-time assignment dialog**, and every variable also has a **type dropdown**
  in the left panel to switch numerical ↔ categorical live (the file on disk is never
  modified).
- **Image overlays.** Microscopy layers (fluorescence channels, or per-FOV masks)
  render as planes at their z — additive for fluorescence, normal for masks. Many
  tiles can share a **group** (shown as one row); toggle whole groups in Display,
  and select/hide **individual** images by ctrl-clicking them in the view. Axes,
  3D grid (adjustable spacing), and per-cell outline are independent toggles.
- **View & export.** The view **opens looking straight down at the XY plane**
  (top-down); orbit to tilt. Snap the camera to the XY / XZ / YZ plane, fit to all
  or only-visible cells, frame the selection, or toggle **Orthographic On/Off** —
  parallel projection so 3D structures flatten without perspective distortion for a
  true-scale export. Export the current view as a **PNG** (raster, chosen size +
  background) or a publication-ready **SVG** (true vector: each cell a circle,
  overlays embedded). A reproducible **`.maplet.json` preset is written next to
  every exported figure**, so the exact view can be re-created.
- **Picks up where you left off.** The desktop app reopens your last experiment on
  launch, and every dataset remembers its filters, colors, selection, and camera
  between sessions. **Preset → Save / Load** writes a small `.maplet.json` that
  captures a pointer to the dataset plus the entire view (color, filters,
  selection, display settings, camera); loading it reopens the dataset and
  reproduces the plot exactly. (In the browser, presets download as a file and the
  view is remembered per file; the desktop app can reopen datasets by path.)
- **Everything is a command, and everything is undoable.** Every adjustment —
  color, filter, selection, display, view — is logged in the console as its `/`
  command. Type the same command to do the same thing; **click a past command to
  revert** to that state. **Ctrl+Z / Ctrl+Shift+Z** (or Ctrl+Y) undo & redo.
- **Console** — press **Enter** for the activity log + command line (`/help`
  lists commands); Esc closes it. Hover any control for a one-line description.

## Large datasets

The viewer draws smoothly up to **100,000 cells**. Load a bigger table and it asks how
to trim it first — a **uniform random subsample** (representative of the whole dataset)
or a **hard cut-off** at the first 100,000 rows — then renders the reduced set. The
whole file is still read into memory to parse, so there is also a practical **~250 MB
file-size limit**; for anything larger, subsample or split it before loading (a
one-line `pandas`/`awk` filter, or export fewer cells). Points are drawn opaque
(depth-tested), so nearer cells correctly occlude farther ones when you tilt into 3D.

## Run

Two ways — pick what fits.

### A. Zero install — the single-file app (any OS)

**Double-click `MapletViewer.html`.** It opens in your default browser and runs
the whole app — no Node, no build, no internet, no install. It is one
self-contained file (code, styles, and fonts inlined, ~1 MB), so it behaves the
same on Windows, macOS, and Linux, and you can copy or email just that one file.
Load your own data with **Open** or by dragging a `.csv` / `.tsv` onto the window —
including the demo dataset, [`sample-data/merfish-hypothalamus.cells.tsv`](sample-data/merfish-hypothalamus.cells.tsv),
which ships alongside as a separate download (open it and assign its columns). In
the browser, an images sheet's `file` paths must be `data:` URIs or URLs.
(Regenerate the app after code changes with `npm run build:web`.)

### B. Native desktop app (Electron)

A real window with native Open dialogs and a recent-files list.

| OS | How |
|----|-----|
| **Windows** | double-click **`run-windows.bat`** |
| **macOS**   | double-click **`run-mac.command`** (first time: `chmod +x run-mac.command`) |
| **Linux**   | `chmod +x run-linux.sh` then `./run-linux.sh` |

First launch installs dependencies and builds (a few minutes, needs internet);
after that it starts instantly and works offline, opening to the welcome screen.
This path needs Node; the launchers use, in order: a
**portable Node bundled in `tools/node/<platform>/`** (the Windows one ships in
this folder, so Windows needs no install), then a system Node, otherwise they
point you back to `MapletViewer.html`. To bundle Node for another OS, drop that
platform's portable Node into `tools/node/darwin-arm64/`, `tools/node/linux-x64/`,
etc.

> **Copying to another computer:** the single-file `MapletViewer.html` always
> just works. For the Electron app, copy the folder without `node_modules/`,
> `dist/`, `dist-electron/` (platform-specific; they regenerate on first run).

### Developer commands

Requires Node on PATH (a portable copy is at `tools/node/win-x64/`, or
`D:\Projects\Thread\tools\node-v24.18.0-win-x64\`).

```sh
npm install          # once
npm run sample       # regenerate a small CSV/TSV sample (MERFISH: make-merfish-sample.py)
npm run dev          # Vite + Electron, hot reload
npm run dev:web      # Vite only — open http://127.0.0.1:5173 in a browser
npm run build        # typecheck + bundle + compile electron (launchers run this)
npm run build:web    # bundle everything into the single MapletViewer.html
npm start            # build, then launch Electron
```

## The save file

**One spreadsheet.** A `.csv` / `.tsv` with a header row and one row per cell. The
header carries **no special notation** — when the file loads you map its columns in
the assignment dialog:

| role | what it is |
|------|------------|
| **id** | a unique per-cell id (auto-detected from an `id`-like column, else the row number) |
| **coordinate axis** | X / Y / Z of a map — **map 0** is the main 3-D viewer; **maps 1–3** open smaller linked viewers (a UMAP, another assay) |
| **numerical** | a real number per cell — colour ramp + colorbar; min/max range filter |
| **categorical** | a label per cell — palette + legend; a searchable value-checkbox list at any cardinality |

Coordinate and id columns are **proposed from common names** (`x`/`y`/`z`,
`center_x`/`center_y`, `umap_1`/`umap_2`, `id`/`cell_id`, …) and each type is guessed
from the values, so a raw metadata export usually needs only a glance before you hit
Load. Opens in Excel. **Overlay images load from a *second* spreadsheet** (image
coordinates + file paths) via the **+ images** button; that sheet is documented in
[`FORMAT.md`](FORMAT.md).

**Demo dataset.** [`sample-data/merfish-hypothalamus.cells.tsv`](sample-data/merfish-hypothalamus.cells.tsv)
is the **MERFISH mouse-hypothalamus** dataset (Moffitt et al., 2018) — 73,655 cells
across 12 serial sections **stacked into a 3-D volume** (Centroid_X/Y/Z), each with a
linked **UMAP** embedding (UMAP_1/UMAP_2), 16 cell classes, 70 neuron clusters, and
marker-gene + transcript gradients, under the reference dataset's own column names. It
ships as a **separate file** (not embedded in the app): open it via **Open** / drag-drop
and confirm the proposed assignment — the app maps Centroid_X/Y/Z → map 0 and
UMAP_1/2 → map 1; set Bregma categorical to filter by section. Regenerate it from
squidpy with `python sample-data/make-merfish-sample.py` (needs `pip install squidpy
scanpy`; the UMAP is computed there).

> **Data attribution.** Moffitt et al., *Science* 2018, [doi:10.1126/science.aau5324](https://doi.org/10.1126/science.aau5324). Source data on Dryad ([doi:10.5061/dryad.8t8s248](https://doi.org/10.5061/dryad.8t8s248)), released under **CC0 1.0** — free to reuse; please cite the paper.

**Experiment-folder workflow.** A converter turns raw sequencing output into
`cells.tsv` + `images.tsv` dropped *inside the experiment folder* (in a
`maplet/` subfolder, next to the images); **Open folder** on that experiment
folder then finds and loads both, resolving image paths for you.
`scripts/convert-experiment.mjs` is a working example for Mercury/piseq:

```sh
node scripts/convert-experiment.mjs <experimentFolder> <spatialCounts.txt>
```

It decodes each cell's spatial location from its barcode reads and lays each
per-FOV segmentation mask as a 366 µm overlay tile at its recorded coordinate.
A spatial barcode is 5 "bits" applied **together**, and every valid 5-bit submask
maps to an `(x, y)` in `config_bit_scheme.csv`. Single-bit reads are ambient
background, so only *co-occurrence* (reads showing ≥ 2 bits) counts: each cell goes
to the submask its co-occurring reads best support, with a **probability** for that
submask, for each plausible alternative, and for "no barcode at all". Cells with no
co-occurrence are left unplaced rather than guessed. The full derivation, the
validation (91.1% agreement with harmony; confidence is calibrated), and the
approaches that were tried and rejected are in [`METHODS.md`](METHODS.md).

The converter writes the top `spatial_barcode` call plus a `spatial_barcode_conf`
confidence column (and the alternatives). On load these come in as two plain columns
— assign `spatial_barcode` **categorical** (a searchable value list; thousands of
distinct barcodes make per-label colours useless) and `spatial_barcode_conf`
**numerical** to colour and filter cells by barcode confidence. QC columns
(`no_call`, `cooc_reads`, `cooc_frac`, `no_bc_frac`, …) let you filter harder. All
cells share one spatial-barcode grid
(one slide) and load on **one plane** (z = 0); `slide` (the S# in the cell id) and
`plate` are filterable columns, not a z axis. (Cell types / methylation / UMAP come
later in the pipeline; this pre-harmony step is spatial only.)

## Layout

```
electron/    main process: window, native dialogs, all disk I/O
shared/      types + the CSV/TSV table parser, shared across the IPC boundary
src/
  format/    dataset builder + column model (numerical/categorical); colormaps
  model/     zustand store; commands + ViewState snapshots (undo/redo); derivation
  viewer/    imperative Three.js: 3D scene (perspective/orthographic) + linked map scatters, camera, export
  panels/    menu bar, color / filter / display / details + selection summary, assignment dialog, export dialog, status bar
  console/   Enter-activated console: command log + click-to-revert history
  platform/  one loader for Electron (IPC) and the browser (File API / fetch)
  ui/        shared brutalist widgets + the hover-tooltip layer
shared/table.ts  inspects a table + builds it from the confirmed column assignment
sample-data/ sample generators + the generated demo TSV (a separate download)
scripts/     single-file finalize + a static server for testing the standalone build
tools/node/  bundled portable Node per platform (Windows shipped) for the launchers
MapletViewer.html  the zero-install single-file app (built by npm run build:web)
run-*        Windows / macOS / Linux launchers for the Electron app
```

No AI inside; runs entirely offline after the first install.
