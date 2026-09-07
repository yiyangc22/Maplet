# The Maplet save-file format (cat_prototype_06)

A save file describes a set of sequenced cells for the Maplet Viewer: where each
cell sits in 3D, what it might be (cell type, spatial barcode, methylation) and
**any** number of custom variables.

**Cells load only from a spreadsheet.** One `.csv` / `.tsv`, one row per cell,
opens in Excel. (JSON `.maplet` files are no longer supported — export your cells
to CSV/TSV.) Overlay images come from a *second* spreadsheet.

The app is **data-driven**: it reads your columns and builds the color / filter /
detail controls from them. What makes that work well is that **each column
declares its type in the header**, so the app knows how to show and filter it.

---

## 1. Cells table — one row per cell

A plain delimited text file (`.csv` or `.tsv`; tab is safest for barcodes). The
first row is the header. Column names are matched case-insensitively.

### Structural columns (no type tag)

| column | meaning |
|--------|---------|
| `id` | **required** — unique cell id |
| `x`, `y` | **required** — coordinates (microns, or whatever space you view in) |
| `z` | optional — depth / section (default `0`) |
| `name__umap` | optional — a UMAP embedding **axis** (see below) |
| `outline` | optional — segmentation polygon, packed as `x,y; x,y; …` |

### Variable columns — the type goes in the name: `name__type`

Every other column names a **variable** and declares its **type** with a
double-underscore suffix. The type decides how the cell is coloured and filtered:

| header suffix | type | how the app shows & filters it |
|---------------|------|--------------------------------|
| `name__grad` | **gradient** | a number. Coloured with a perceptual ramp + colorbar; filtered with a **min/max range** slider. Use for methylation, confidence, QC scores, expression. |
| `name__cat` | **category** | a discrete label. Coloured with a palette + legend; filtered with **checkboxes**. Use for cell class, region, section, donor. Best under ~36 distinct values. |
| `name__id` | **identifier** | a high-cardinality string (thousands of values). **Never** offered as a colour — a per-value colour would be noise. Shown in details; filtered with a **text search** over a distinct-count + top-values summary. Use for spatial / assigned barcodes. |
| `name__ranked` | **ranked call** | a top label + confidence + ranked alternatives (see below). Coloured by top label **or** by confidence; filtered by top label + a **min-confidence** slider. Use for a cell-type call. |

So the display name the app shows is the part **before** `__type` (e.g.
`mCH__grad` displays as `mCH`).

**UMAP axes are a special structural type.** Tag each embedding axis `name__umap`
(e.g. `umap_1__umap`, `umap_2__umap`; add a third for a 3D embedding). They are
taken in header order — 1st `__umap` column → axis 1, 2nd → axis 2, 3rd → axis 3 —
and, like `x`/`y`/`z`, are used **only** to build the linked UMAP scatter: never
coloured, never filtered, never listed as a variable. (Bare `umap_1`/`umap_2` names
still work as a legacy fallback when nothing is tagged `__umap`.)

The type is the **only** thing that decides a column's behaviour — the app reads
no meaning from a column's *name* (there's no special handling of "cell_type",
"barcode", "methylation", etc.), so any workflow's variables display correctly
from their tag alone.

**Ranked calls span several columns.** A ranked variable `K` is written as the
label column `K__ranked` plus its confidence `K_conf`; further candidates are
`K_2__ranked` + `K_2_conf`, `K_3__ranked` + `K_3_conf`, …  Any extra
per-candidate field (`K_reads`, `K_2_reads`, …) rides along and is shown in the
details panel. Confidence may be written `0..1` or `0..100` (auto-detected per
column).

**Missing** values may be empty or `NA` / `NaN` / `null`; every filter has an
*include missing* toggle. Lines beginning with `#` are comments.

**Untyped columns still load.** A column with no `__type` tag is inferred
(numeric ⇒ `grad`, text ⇒ `cat`; a `_conf` sibling ⇒ `ranked`). On load the app
pops a dialog listing every inferred column and the type it guessed, so nothing is
displayed a way you didn't agree to. Tagging is how you get the *right* behaviour —
e.g. an untagged barcode column would be treated as a category and clog the colour
menu; tag it `__id` and it becomes a searchable identifier instead.

**You can also override a type in-app.** Every variable in the left panel has a
type dropdown (gradient / category / identifier); changing it re-derives that
column live from the same values. If your choice disagrees with what the file
declared, the app asks you to confirm first. This only changes how *this app*
shows the column — the file on disk is untouched. (Ranked spans several columns, so
its type is fixed by the file.)

### Example `cells.tsv`

```
id    x      y     z  cell_type__ranked  cell_type_conf  cell_type_2__ranked  cell_type_2_conf  spatial_barcode__id  barcode_conf__grad  mCH__grad  mCG__grad  region__cat
c1    677.8  -482  0  InN                0.80            ExN                  0.05              I02-I03-I05-I11-I16  0.69                0.0369     0.792      Hypothalamus
c2    210.4  135.9 0  ExN                0.91                                                   I05-I12-I13-I15-I19  0.44                0.0411     0.771      Cortex
c3    -88.1  402.0 10 Oligo              0.62            Astro                0.20              I01-I04-I08-I10-I17  0.55                0.0288     0.812      Cortex
```

Here `cell_type` is a ranked call, `spatial_barcode` is an identifier (searchable,
never coloured), `barcode_conf` / `mCH` / `mCG` are gradients, and `region` is a
category — all determined by the header, with no separate declaration.

---

## 2. Images table — one row per image channel

Overlay images are **not** in the cells table. Load them from a second
spreadsheet (in the app: **+ images**, or drag it onto the window). One row per
image channel; rows sharing an `image_id` compose into one layer (so a
multichannel fluorescence image is several rows). Image columns are plain (no
`__type` tags):

| column | meaning |
|--------|---------|
| `image_id` | groups a layer's channels (optional; else each row is its own layer) |
| `group` | panel grouping for many tiles, e.g. `Section 1 masks` (optional) |
| `x0,y0,x1,y1` | image extent in the same xy space as the cells … |
| …or `cx,cy` + `size` | … *or* a center plus a size (square) / `w`,`h` (handy for FOV tiles) |
| `z` | plane depth (optional, default 0) |
| `opacity` | 0..1 (optional) |
| `flip_x`, `flip_y` | mirror the texture (optional; microscope inversion) |
| `blend` | `additive` (fluorescence, default) or `normal` (masks / photos) |
| `channel` | channel name (optional) |
| `color` | `#rrggbb` tint (optional, default white) |
| `file` | **required** — image location |

`file` is a path (relative to the sheet's own folder), an `http(s)` URL, or a
`data:` URI. The **desktop app** reads local image files and inlines them; in the
**browser** (no filesystem) the `file` column must be a `data:` URI or URL.

### Example `images.tsv`

```
image_id  group            cx      cy    size  z  flip_x  flip_y  blend    channel  color    file
fov_000   Section 1 masks  -11129  2977  366   0  1       1       normal   mask     #ffffff  ../image_mask/fov_000.png
sec0      fluorescence     -2200   -1600 4400  0  0       0       additive DAPI     #5b8cff  channels/sec0_dapi.png
sec0      fluorescence     -2200   -1600 4400  0  0       0       additive NeuN     #46e39a  channels/sec0_neun.png
```

The two `sec0` rows become one layer with two additively-blended channels; each
`fov_*` row is its own mask tile, all shown under one **Section 1 masks** row you
can expand and select tile-by-tile.

---

## 3. Folders (the experiment-folder workflow)

Put `cells.tsv` (and optionally `images.tsv`) in a `maplet/` subfolder of your
experiment folder and use **Open folder** on the experiment folder — the app finds
both and loads cells + images together, resolving image paths for you.
`scripts/convert-experiment.mjs` writes exactly this (with typed headers) from a
Mercury/piseq run.

---

## Coordinate convention

`x`/`y` is whatever space you view in (typically microns). `z` commonly encodes
the tissue **section/slice**. The viewer only reads the coordinates; how you
compute them (e.g. decoding a spatial barcode to x,y via a bit scheme, and mapping
slice → z) is up to the converter that writes the file. See `METHODS.md` for the
spatial-barcode decoding used by the example converter.

## Worked example

[`examples/`](examples/) holds a ready-to-load synthetic dataset in this typed
spreadsheet format — `tissue-sample.cells.tsv` plus overlay images (and a
`README` on loading it). Regenerate with `npm run sample:tsv`. The built-in
**Sample** button loads a similar typed dataset embedded in the app.
