// Types shared across the Electron IPC boundary AND used by the renderer's
// format layer. The on-disk ".maplet" save file is described here; the parser
// and variable inference live in src/format/maplet.ts.
//
// See FORMAT.md for the human-facing spec.

// ----------------------------------------------------------------------------
// Variable registry — makes the app data-driven. Every column the viewer can
// color / filter / inspect by is declared here, so nothing is hard-coded.
// ----------------------------------------------------------------------------

export type VariableKind =
  | 'continuous' // a real number per point (mCH, reads, ...)
  | 'categorical' // one label per point (region, slice, sample, ...)
  | 'ranked'; // a ranked list of candidate labels + confidence (cell_type, barcode)

// The type a column DECLARES in its header via the `name__type` suffix
// (cat_prototype_06). Each maps onto a storage `kind` + a display/filter
// strategy: grad -> continuous gradient; cat -> categorical palette;
// id -> a high-cardinality identifier (categorical storage, but never coloured
// by value and filtered by text match, not checkboxes); ranked -> a ranked call.
// This is the SOLE thing that decides how a column behaves — the app reads no
// meaning from a column's NAME (no cell_type / barcode / methylation special
// cases), so any workflow's variables display correctly from their type alone.
export type DeclaredType = 'grad' | 'cat' | 'id' | 'ranked';

// Header tokens the parser understands for a *variable* column: the four
// variable types. Coordinate columns use a separate family of tokens
// (`x0`/`y0`/`z0`, `x1`/…) handled by the table parser, not listed here.
export type HeaderType = DeclaredType;

export interface CategoryDef {
  value: string;
  label?: string;
  color?: string; // "#rrggbb"; auto-assigned from a palette when omitted
}

export interface VariableDef {
  key: string; // matches a key in point.values or point.classes
  label?: string; // display name; falls back to key
  kind: VariableKind;
  unit?: string;
  description?: string;

  // The type the column's header declared (grad/cat/id/ranked), or — when the
  // header had no `__type` tag — the type the parser INFERRED. `typeDeclared`
  // says which it was, so the UI can flag a manual override that disagrees with
  // what the file suggested.
  suggestedType?: DeclaredType;
  typeDeclared?: boolean;

  // continuous hints (all optional; the app computes sensible defaults)
  domain?: [number, number]; // color/filter range; computed from data when absent
  scale?: 'linear' | 'log';
  colormap?: string; // name in src/format/colormaps.ts

  // categorical / ranked hints (optional)
  categories?: CategoryDef[]; // explicit order + colors

  // A high-cardinality identifier (declared `name__id`): stored like a
  // categorical, but never offered as a colour axis and filtered by text match
  // rather than per-value checkboxes (e.g. spatial_barcode with thousands of values).
  identifier?: boolean;
}

// ----------------------------------------------------------------------------
// Dataset-level metadata
// ----------------------------------------------------------------------------

export interface DatasetMeta {
  name: string;
  description?: string;
  created?: string; // YYYY-MM-DD
  unit?: string; // spatial unit, e.g. "micron"
  z_meaning?: string; // e.g. "section slice"
  default_color_by?: string; // variable key to color by on load
  default_point_size?: number;
}

// ----------------------------------------------------------------------------
// Per-point record
// ----------------------------------------------------------------------------

export interface ClassCall {
  label: string;
  confidence?: number; // 0..1
  // arbitrary extra fields are preserved and shown in the details panel,
  // e.g. { reads: 327 } for a barcode call.
  [extra: string]: unknown;
}

// A data point's location in one coordinate map: 2D (x, y) or 3D (x, y, z).
export type Coord = [number, number] | [number, number, number];

// One coordinate mapping the file declares. The columns
// `spatial_x__x0, spatial_y__y0, spatial_z__z0` define map 0 with axis names
// ["spatial_x", "spatial_y", "spatial_z"]; `umap__x1, umap2__y1` define map 1.
// A point may be placed in several maps (a physical map, a UMAP embedding, a
// second assay's coordinates, …); each viewer panel renders one of them.
export interface CoordMapDef {
  index: number; // the {n} in __x{n}/__y{n}/__z{n}
  axes: string[]; // per-axis display names — length 2 (x, y) or 3 (x, y, z)
}

export interface PointRecord {
  id: string;
  // Location in each declared coordinate map, indexed by map index; a slot is
  // undefined when this point has no coordinates in that map. For a multi-frame
  // dataset this holds the point's FRAME-0 (default) position.
  coords: (Coord | undefined)[];
  // Multi-frame (long format) only: per-map position TRACK. track[mapIndex] is an
  // array indexed by FRAME INDEX (aligned to Dataset.frames); an entry is
  // undefined where the point is absent/hidden at that frame. Carry-forward is
  // already resolved into these positions at parse time. Absent for single-frame
  // datasets and for maps that don't vary over frames.
  track?: (Coord | undefined)[][];
  outline?: [number, number][]; // optional xy polygon in map 0's space, at the point's z
  classes?: Record<string, ClassCall[]>; // ranked candidate lists, keyed by variable key
  values?: Record<string, number | string | null>; // scalars / categoricals
}

// ----------------------------------------------------------------------------
// The manifest (bundle: manifest.json; single-file: this + inline `points`)
// ----------------------------------------------------------------------------

// ----------------------------------------------------------------------------
// Optional image overlays — e.g. stitched multichannel microscopy for a section.
// Each layer is a rectangle in the dataset's xy space, at a given z; each
// channel is a (typically grayscale) image tinted a color and blended additively
// so multiple fluorescence channels composite into one view.
// ----------------------------------------------------------------------------

export interface ImageChannel {
  src: string; // data URI (works everywhere) or a path/URL (resolved by the loader)
  name?: string;
  color?: string; // "#rrggbb" tint; defaults to white
}

export interface ImageLayer {
  id?: string;
  label?: string;
  group?: string; // layers sharing a group are shown as one row in the panel
  z?: number; // plane depth in the dataset's coordinate space (default 0)
  extent: [number, number, number, number]; // [xmin, ymin, xmax, ymax]
  opacity?: number; // 0..1, default 1
  flip?: [boolean, boolean]; // flip texture [x, y] (e.g. microscope inversion)
  blend?: 'additive' | 'normal'; // additive for fluorescence (default), normal for masks/photos
  channels: ImageChannel[];
}

export interface MapletManifest {
  maplet_version: string; // "1.0"
  dataset: DatasetMeta;
  variables: VariableDef[];
  images?: ImageLayer[]; // optional overlays
  points?: PointRecord[]; // present in single-file form; absent in bundle form
}

// ----------------------------------------------------------------------------
// IPC transport — the platform layer reads bytes; the renderer parses them, so
// Electron and the browser fallback share one parser.
// ----------------------------------------------------------------------------

export interface RawMaplet {
  source: string; // path (Electron) or filename (browser), used to RELOAD the dataset
  sourceName?: string; // human display name (the actual file's basename, e.g. "points.tsv"); defaults to basename(source)
  manifestJson: string; // JSON text of the manifest (may inline `points`); "{}" when points come from a table
  pointsJsonl?: string | null; // bundle form: newline-delimited point JSON; null for single-file
  pointsTable?: string | null; // flat CSV/TSV points table (one row per point); when set, points come from here
  // Set when the file was too large to hold in memory, so `pointsTable` is only the
  // FIRST rows (a prefix). `rows` is the file's (estimated) true row count, so the app
  // can offer "load the first N" with an honest total instead of silently failing.
  oversize?: { rows: number };
}

// A parsed + (in Electron) path-inlined set of image overlay layers, loaded from
// a separate images spreadsheet after the points are already shown.
export interface ImagesResult {
  source: string;
  images: ImageLayer[];
}

// A native save/load result for presets and figure export.
export interface SaveResult {
  ok: boolean;
  path?: string;
  canceled?: boolean;
  error?: string;
}

export interface ExportSavePayload {
  format: 'png' | 'svg';
  dataBase64?: string; // PNG bytes (base64, no data: prefix)
  text?: string; // SVG markup
  suggestedName: string;
  presetJson: string; // written as a sidecar .maplet.json next to the image
}

// The API the preload bridge exposes to the renderer as window.maplet.
export interface MapletAPI {
  platform: 'electron';
  open(): Promise<RawMaplet | null>; // native file dialog + read (JSON or CSV/TSV points table)
  // Universal "Browse" that starts in the bundled samples folder — returns the raw
  // file for the renderer to route (table / .yml view / .json bundle). Optional so
  // an older preload without it falls back to the DOM file input.
  browseSample?(): Promise<{ text: string; name: string; path: string } | null>;
  openFolder(): Promise<RawMaplet | null>; // native folder dialog (bundle / experiment folder) + read
  openImages(): Promise<ImagesResult | null>; // native dialog for a separate images spreadsheet (paths inlined)
  loadPath(path: string): Promise<RawMaplet>; // open a known path (recent files)
  loadSample(name: string): Promise<RawMaplet>; // read a sample file from the bundled sample-data/ folder
  recent(): Promise<string[]>;
  clearRecent(): Promise<void>;
  // Session memory + presets (see src/app/session.ts, src/platform/persist.ts).
  sessionGet(): Promise<string | null>;
  sessionSet(json: string): Promise<void>;
  saveExport(p: ExportSavePayload): Promise<SaveResult>;
  savePreset(p: { json: string; suggestedName: string }): Promise<SaveResult>;
  loadPreset(): Promise<{ ok: boolean; text?: string; path?: string; canceled?: boolean } | null>;
}

declare global {
  interface Window {
    maplet?: MapletAPI;
  }
}
