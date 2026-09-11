// Parse a RawMaplet (manifest + points) into a normalized, column-oriented
// Dataset the viewer and store consume. Variables are resolved from the
// manifest registry AND inferred for any undeclared keys, so custom variables
// load without the app being hard-coded for them.

import type {
  CategoryDef,
  MapletManifest,
  PointRecord,
  ClassCall,
  Coord,
  CoordMapDef,
  DatasetMeta,
  DeclaredType,
  ImageLayer,
  RawMaplet,
  VariableDef,
} from '../../shared/types';
import {
  assignmentFromInspect,
  buildTableFromAssignment,
  inspectTable,
  type Assignment,
  type CapOption,
  type RawImportInfo,
} from '../../shared/table';
import { categoricalColor, DEFAULT_COLORMAP, hexToRgb, rgbToHex, RGB } from './colormaps';

// Cap on distinct categories shown for a categorical/ranked variable. The long
// tail collapses into a single "(other)" bucket so e.g. thousands of distinct
// barcodes stay colorable and filterable.
const MAX_CATEGORIES = 36;
const OTHER_LABEL = '(other)';
const OTHER_COLOR: RGB = [0.5, 0.5, 0.5];

export interface ResolvedCategory {
  index: number;
  value: string;
  label: string;
  color: RGB; // normalized 0..1
  colorHex: string;
  count: number;
  isOther?: boolean;
}

export interface ColumnBase {
  key: string;
  label: string;
  unit?: string;
  description?: string;
  nMissing: number;
  // The type the file declared, or the parser inferred (grad/cat/id/ranked), and
  // whether it was explicitly tagged. Drives the per-variable type override in
  // the Filter panel and the "differs from the file" warning. Preserved across a
  // manual override so the warning always compares against the ORIGINAL file type.
  suggestedType: DeclaredType;
  typeDeclared: boolean;
}

export interface ContinuousColumn extends ColumnBase {
  kind: 'continuous';
  data: Float32Array; // NaN = missing
  domain: [number, number]; // resolved color/filter range
  dataMin: number;
  dataMax: number;
  scale: 'linear' | 'log';
  colormap: string;
}

export interface CategoricalColumn extends ColumnBase {
  kind: 'categorical';
  data: Int32Array; // colour-palette category index; -1 = missing (capped into "(other)")
  categories: ResolvedCategory[]; // capped palette (for colour + legend)
  nDistinct: number; // total distinct values BEFORE capping into the "(other)" bucket
  // EVERY distinct value with its count (not capped), sorted by frequency then
  // natural label — powers the searchable filter checkbox list at any cardinality.
  distinct: { value: string; count: number }[];
  // The real per-point value string (null = missing). Used for value-set filtering
  // and to show the true value when it fell into the colour "(other)" bucket.
  rawValues: (string | null)[];
  // (dormant) former high-cardinality-identifier flag; the new loader never sets it.
  isIdentifier?: boolean;
}

export interface RankedColumn extends ColumnBase {
  kind: 'ranked';
  top: Int32Array; // top-label category index; -1 = missing
  conf: Float32Array; // top confidence; NaN = missing
  categories: ResolvedCategory[];
  nDistinct: number; // total distinct top-labels BEFORE capping into the "(other)" bucket
  colormap: string; // used by the "color by top confidence" sub-mode
}

export type Column = ContinuousColumn | CategoricalColumn | RankedColumn;

export interface Bounds {
  min: [number, number, number];
  max: [number, number, number];
  center: [number, number, number];
  radius: number; // half space-diagonal, for camera framing
}

// How one axis maps its WORLD coordinate to the DATA value shown on tick labels:
// dataValue = world * scale + offset. Real coordinate maps use identity (world IS
// the value); a synthetic dot-plot map scales a variable's range into the world box
// but labels the true values.
export interface AxisFrame {
  label: string;
  unit?: string;
  scale: number;
  offset: number;
}

// A synthetic dot-plot map is stored at this sentinel index (never 0, so it never
// picks up map-0's spatial overlays / images).
export const VARIABLE_MAP_INDEX = -1;

// One coordinate mapping resolved for rendering: its axis names, dimensionality,
// a packed n*3 position buffer (z=0 for 2D maps; NaN triple where a point has no
// coordinates in this map), and its own framing bounds.
export interface CoordMap {
  index: number; // the {n} from the `__x{n}` columns
  axes: string[]; // display names, length 2 or 3
  dims: 2 | 3;
  label: string; // "(spatial_x, spatial_y, spatial_z)" — the panel/dropdown title
  positions: Float32Array; // n * 3 — the CURRENT frame (frame 0 for an animated map)
  bounds: Bounds; // framed over ALL frames for an animated map, so the camera fits the whole track
  count: number; // points present in this map (in any frame)
  // Set when this map is a synthetic 1-D variable dot plot (row index on x, value
  // on y). `frames` gives the per-axis world→value mapping for the axis labels.
  variableKey?: string;
  frames?: AxisFrame[];
  // Multi-frame (long format): one n*3 position buffer per frame index (aligned to
  // Dataset.frames). Present only for a map whose points move across frames; the
  // viewer swaps `positions` to framePositions[currentFrame]. positions === framePositions[0].
  framePositions?: Float32Array[];
  frameCount?: number; // framePositions.length when animated
}

export interface Dataset {
  source: string; // reload path/id (folder or file)
  sourceName: string; // display name — the loaded file's basename (e.g. "points.tsv")
  meta: DatasetMeta;
  // Per-point records, index-aligned to the columns. For LARGE datasets this is a
  // lazy view backed by the columnar typed arrays (see makePointsView) — reading
  // `points[i]` reconstructs the record on demand, so millions of points don't sit
  // in memory as JS objects. Small datasets keep a plain array.
  points: PointRecord[]; // only points with a valid id + at least one map (index-aligned to columns)
  pointIds: string[]; // every point's id (kept flat so id lookups/labels don't reconstruct records)
  n: number;
  // Coordinate maps declared by the file (≥1, sorted by index). Each viewer panel
  // renders one of these; the user picks which via the panel's dropdown.
  maps: CoordMap[];
  // Multi-frame (long / 4D) timeline: sorted distinct frame/time values. Empty for
  // a single-frame dataset. `frameCount` is frames.length, or 1 when static.
  frames: number[];
  frameCount: number;
  // Time axis is CONTINUOUS (real-valued scrub over the value range) vs DISCRETE
  // (equal frame steps). Positions HOLD between samples either way (no interpolation).
  continuousTime: boolean;
  primaryMap: number; // index of the default map shown by the main viewer (= maps[0].index)
  positions: Float32Array; // n * 3 — alias of the primary map's positions (incidental consumers)
  bounds: Bounds; // alias of the primary map's bounds
  columns: Column[];
  columnByKey: Map<string, Column>;
  images: ImageLayer[];
  warnings: string[];
  // Columns whose type had to be inferred (no `__type` tag). The app pops a
  // confirmation dialog listing these so the user can tag the file or override.
  inferred: { key: string; type: DeclaredType }[];
  // Set only when this was a raw / untagged table whose id + coordinate columns
  // were detected by name (see shared/table.ts). Lets the confirm dialog show
  // exactly what was detected before the user confirms the types.
  rawImport?: RawImportInfo;
}

// Look up a coordinate map by its index (the {n} in `__x{n}`).
export function mapByIndex(ds: Dataset, index: number): CoordMap | undefined {
  return ds.maps.find((m) => m.index === index);
}

// ---------------------------------------------------------------------------
// Virtual numeric columns (id + coordinate axes)
// ---------------------------------------------------------------------------
// The id and the coordinate-map columns are consumed by the loader (they aren't in
// `columns`), but every variable dropdown (color / size / panel axes) should still
// offer them. They're exposed as read-only numeric columns living ONLY in
// `columnByKey` — so they never get a filter block or duplicate into a saved bundle.
export const ID_KEY = '@id';
export function mapAxisKey(index: number, axis: 'x' | 'y' | 'z'): string {
  return `@m${index}:${axis}`;
}

function numericColumn(key: string, label: string, data: Float32Array): ContinuousColumn {
  let lo = Infinity;
  let hi = -Infinity;
  let nMissing = 0;
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    if (Number.isFinite(v)) {
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    } else nMissing++;
  }
  if (!Number.isFinite(lo)) [lo, hi] = [0, 1];
  return {
    kind: 'continuous',
    key,
    label,
    nMissing,
    suggestedType: 'grad',
    typeDeclared: false,
    data,
    domain: [lo, hi],
    dataMin: lo,
    dataMax: hi,
    scale: 'linear',
    colormap: 'viridis',
  };
}

// The id as a number — the whole id when it's numeric, else its trailing number
// ("cell_00042" → 42); ids with no number are missing, and if NONE parse the row
// index stands in. Then each map's native axes.
function idNumber(s: string | null | undefined): number {
  if (s == null || s.trim() === '') return NaN;
  const v = Number(s);
  if (Number.isFinite(v)) return v;
  const m = /(\d+(?:\.\d+)?)\D*$/.exec(s);
  return m ? Number(m[1]) : NaN;
}
function virtualColumns(maps: CoordMap[], pointIds: string[]): ContinuousColumn[] {
  const n = pointIds.length;
  const ids = new Float32Array(n);
  let parsed = 0;
  for (let i = 0; i < n; i++) {
    const v = idNumber(pointIds[i]);
    ids[i] = v;
    if (Number.isFinite(v)) parsed++;
  }
  if (parsed === 0) for (let i = 0; i < n; i++) ids[i] = i;
  const out = [numericColumn(ID_KEY, 'id', ids)];
  for (const m of maps) {
    (['x', 'y', 'z'] as const).slice(0, m.dims).forEach((axis, off) => {
      const data = new Float32Array(n);
      for (let i = 0; i < n; i++) data[i] = m.positions[i * 3 + off];
      out.push(numericColumn(mapAxisKey(m.index, axis), m.axes[off] ?? axis, data));
    });
  }
  return out;
}

// columnByKey for a dataset: the real columns plus the virtual id / axis columns.
export function indexColumns(columns: Column[], maps: CoordMap[], pointIds: string[]): Map<string, Column> {
  const byKey = new Map<string, Column>();
  for (const c of virtualColumns(maps, pointIds)) byKey.set(c.key, c);
  for (const c of columns) byKey.set(c.key, c);
  return byKey;
}

// Every variable a dropdown can pick, in one flat list: the id, each map's
// coordinate axes, then the file's variables in file order. `axis` is set on the
// coordinate entries (the panel axis pickers bind those as native map axes).
export interface VariableOption {
  key: string;
  label: string;
  axis?: { index: number; axis: 'x' | 'y' | 'z' };
}
export function variableOptions(ds: Dataset): VariableOption[] {
  const out: VariableOption[] = [{ key: ID_KEY, label: 'id' }];
  for (const m of ds.maps) {
    (['x', 'y', 'z'] as const).slice(0, m.dims).forEach((axis, off) => {
      out.push({ key: mapAxisKey(m.index, axis), label: m.axes[off] ?? axis, axis: { index: m.index, axis } });
    });
  }
  for (const c of ds.columns) out.push({ key: c.key, label: c.label });
  return out;
}

// A column read as numbers (continuous value; categorical palette index; ranked top
// confidence) plus its natural range — used by "size by" and the panel axes so every
// variable type can drive them.
export function numericValue(col: Column, i: number): number {
  if (col.kind === 'continuous') return col.data[i];
  if (col.kind === 'categorical') return col.data[i] >= 0 ? col.data[i] : NaN;
  return col.conf[i];
}
export function numericDomain(col: Column): [number, number] {
  if (col.kind === 'continuous') return [col.dataMin, col.dataMax];
  if (col.kind === 'categorical') return [0, Math.max(1, col.categories.length - 1)];
  return [0, 1];
}

// Build an on-the-fly "dot plot" map for a 1-D numeric variable: every point is a
// dot at (row index in the file, its value). Rendered by the same viewer as a real
// coordinate map, so it shares the store's colour / selection / hover / lasso — the
// dots stay in sync with the other panels. The value range is scaled into a square
// world box (so the spread is visible at any data scale); `frames` records the
// inverse mapping so the axes still label the true row numbers and values.
export function buildVariableDotMap(ds: Dataset, key: string): CoordMap {
  const col = ds.columnByKey.get(key);
  const n = ds.n;
  const positions = new Float32Array(n * 3).fill(NaN);
  const continuous = col?.kind === 'continuous' ? col : null;

  let vmin = Infinity;
  let vmax = -Infinity;
  if (continuous) {
    for (let i = 0; i < n; i++) {
      const v = continuous.data[i];
      if (Number.isFinite(v)) {
        if (v < vmin) vmin = v;
        if (v > vmax) vmax = v;
      }
    }
  }
  if (!Number.isFinite(vmin)) {
    vmin = 0;
    vmax = 1;
  } else if (vmin === vmax) {
    vmin -= 0.5;
    vmax += 0.5;
  }

  const span = Math.max(1, n - 1); // world extent along x (rows 0 … n-1)
  const yScale = span / (vmax - vmin); // value → world-y (so the box is ~square)
  let count = 0;
  if (continuous) {
    for (let i = 0; i < n; i++) {
      const v = continuous.data[i];
      if (Number.isFinite(v)) {
        positions[i * 3] = i;
        positions[i * 3 + 1] = (v - vmin) * yScale;
        positions[i * 3 + 2] = 0;
        count++;
      }
    }
  }

  const label = col?.label ?? key;
  return {
    index: VARIABLE_MAP_INDEX,
    axes: ['row', label],
    dims: 2,
    label: `${label} vs row`,
    positions,
    bounds: computeBounds(positions, n),
    count,
    variableKey: key,
    frames: [
      { label: 'row', scale: 1, offset: 0 }, // world-x IS the row index
      { label, unit: col?.unit, scale: 1 / yScale, offset: vmin }, // world-y → value
    ],
  };
}

// ---------------------------------------------------------------------------
// Per-panel axis assignment (custom scatter)
// ---------------------------------------------------------------------------
// A panel can bind ANY numerical variable or coordinate-map axis to each of X / Y /
// Z (see AxisRef / PanelTarget in model/viewstate). These builders turn a target
// into the CoordMap the viewer renders — reusing a real coordinate map when the
// chosen axes ARE that map's native axes (so map 0's overlays / images / animation
// still work when you're just looking at the native spatial view), and otherwise
// building a synthetic scatter buffer on the fly. Type-only import to avoid a
// runtime cycle (viewstate imports Dataset from here).
import type { AxisRef, PanelTarget } from '../model/viewstate';

// Reader for one axis source, over the CURRENT (frame-0) data.
function axisAccessor(ds: Dataset, ref: AxisRef): { get: (i: number) => number; label: string } {
  if (ref.src === 'var') {
    // Any variable type: a categorical separates groups by palette index (missing → NaN).
    const col = ds.columnByKey.get(ref.key);
    if (col) return { get: (i) => numericValue(col, i), label: col.label };
    return { get: () => NaN, label: ref.key };
  }
  const m = mapByIndex(ds, ref.index);
  const off = ref.axis === 'x' ? 0 : ref.axis === 'y' ? 1 : 2;
  if (!m) return { get: () => NaN, label: ref.axis };
  const pos = m.positions;
  return { get: (i) => pos[i * 3 + off], label: m.axes[off] ?? ref.axis };
}

// Build a synthetic scatter map from three axis refs (Z optional → 2-D). A point is
// placed only where BOTH X and Y are finite (matching the coordinate-map rule); a
// non-finite Z floors to 0. index = VARIABLE_MAP_INDEX so it never picks up map-0's
// spatial overlays.
export function buildAxisMap(ds: Dataset, x: AxisRef, y: AxisRef, z: AxisRef | null): CoordMap {
  const n = ds.n;
  const ax = axisAccessor(ds, x);
  const ay = axisAccessor(ds, y);
  const az = z ? axisAccessor(ds, z) : null;
  const dims: 2 | 3 = az ? 3 : 2;
  const positions = new Float32Array(n * 3).fill(NaN);
  let count = 0;
  for (let i = 0; i < n; i++) {
    const xv = ax.get(i);
    const yv = ay.get(i);
    if (Number.isFinite(xv) && Number.isFinite(yv)) {
      positions[i * 3] = xv;
      positions[i * 3 + 1] = yv;
      const zv = az ? az.get(i) : 0;
      positions[i * 3 + 2] = Number.isFinite(zv) ? zv : 0;
      count++;
    }
  }
  const axes = az ? [ax.label, ay.label, az.label] : [ax.label, ay.label];
  return {
    index: VARIABLE_MAP_INDEX,
    axes,
    dims,
    label: axes.join(' × '),
    positions,
    bounds: computeBounds(positions, n),
    count,
  };
}

// The native-axes 'axes' target for a real coordinate map (X→x, Y→y, and Z→z for a
// 3-D map). Used for defaults and when a panel is set to a whole map.
export function nativeTarget(m: CoordMap): PanelTarget {
  return {
    kind: 'axes',
    x: { src: 'map', index: m.index, axis: 'x' },
    y: { src: 'map', index: m.index, axis: 'y' },
    z: m.dims === 3 ? { src: 'map', index: m.index, axis: 'z' } : null,
  };
}

// If an 'axes' target is exactly one real map's native axes, return that map (so we
// reuse it, overlays and all) — else null.
function nativeMapOf(ds: Dataset, t: Extract<PanelTarget, { kind: 'axes' }>): CoordMap | null {
  if (t.x.src !== 'map' || t.y.src !== 'map' || t.x.axis !== 'x' || t.y.axis !== 'y') return null;
  const idx = t.x.index;
  if (t.y.index !== idx) return null;
  const m = mapByIndex(ds, idx);
  if (!m) return null;
  if (m.dims === 3) {
    if (!t.z || t.z.src !== 'map' || t.z.index !== idx || t.z.axis !== 'z') return null;
  } else if (t.z) {
    return null;
  }
  return m;
}

// Resolve a PanelTarget to the CoordMap the viewer renders.
export function resolveTargetMap(ds: Dataset, target: PanelTarget): CoordMap | null {
  if (target.kind === 'map') return mapByIndex(ds, target.index) ?? ds.maps[0] ?? null;
  if (target.kind === 'hist') return buildVariableDotMap(ds, target.key);
  return nativeMapOf(ds, target) ?? buildAxisMap(ds, target.x, target.y, target.z);
}

// The X / Y / Z axis refs a target displays — used by the panel's axis dropdowns to
// show the current assignment. A legacy 'map' target reads back as that map's native
// axes; a legacy 'hist' (dot plot) as the primary map's X against the variable on Y.
export function targetAxes(ds: Dataset, target: PanelTarget): { x: AxisRef; y: AxisRef; z: AxisRef | null } {
  if (target.kind === 'axes') return { x: target.x, y: target.y, z: target.z };
  if (target.kind === 'map') {
    const m = mapByIndex(ds, target.index) ?? ds.maps[0];
    return {
      x: { src: 'map', index: m.index, axis: 'x' },
      y: { src: 'map', index: m.index, axis: 'y' },
      z: m.dims === 3 ? { src: 'map', index: m.index, axis: 'z' } : null,
    };
  }
  const m = ds.maps[0];
  return { x: { src: 'map', index: m.index, axis: 'x' }, y: { src: 'var', key: target.key }, z: null };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function parseRawMaplet(raw: RawMaplet, cap?: CapOption, assignment?: Assignment): Dataset {
  // cat_prototype_10: points load ONLY from a flat CSV/TSV spreadsheet, and the
  // header/type NOTATION is no longer read — an explicit column `assignment` (built
  // by the load-time modal) is the authority. When none is supplied (bundle reload,
  // console, worker), auto-detect a sensible one from the column names + values.
  if (raw.pointsTable != null && raw.pointsTable.trim() !== '') {
    const a = assignment ?? assignmentFromInspect(inspectTable(raw.pointsTable, raw.source));
    return parseTableMaplet(raw, a, cap);
  }
  throw new Error(
    'No point data found — the file is empty, could not be read (it may be too large), or is not a CSV/TSV table with one row per point.',
  );
}

// Build a Dataset from a flat points table + a confirmed column assignment. An
// optional side-manifest still rides along to carry dataset meta + already-parsed
// image overlays (the Electron experiment-folder path) — never point structure.
function parseTableMaplet(raw: RawMaplet, assignment: Assignment, cap?: CapOption): Dataset {
  const table = buildTableFromAssignment(raw.pointsTable as string, assignment, raw.source, cap);

  let side: Partial<MapletManifest> = {};
  const mj = raw.manifestJson?.trim();
  if (mj && mj !== '{}') {
    try {
      side = JSON.parse(mj) as Partial<MapletManifest>;
    } catch {
      /* a non-JSON manifest string just means "table only" */
    }
  }

  const manifest: MapletManifest = {
    maplet_version: '1.0',
    dataset: { ...table.meta, ...(side.dataset ?? {}) },
    variables: table.variables, // the assignment is authoritative; ignore any manifest variables
    images: side.images,
  };

  const ds = buildDataset(raw.source, manifest, table.points, table.maps, raw.sourceName, table.frames, table.continuousTime);
  ds.warnings = [...table.warnings, ...ds.warnings];
  ds.inferred = table.inferred;
  ds.rawImport = table.rawImport;
  return ds;
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

export function buildDataset(
  source: string,
  manifest: MapletManifest,
  rawCells: PointRecord[],
  mapDefs: CoordMapDef[],
  sourceName?: string,
  frames?: number[],
  continuousTime = false,
): Dataset {
  const warnings: string[] = [];
  // Multi-frame timeline (long format). Single-frame datasets have no frames.
  const frameList = frames && frames.length > 1 ? frames : [];
  const frameCount = frameList.length || 1;

  // Keep only points with an id and coordinates in at least one map.
  const points: PointRecord[] = [];
  let skipped = 0;
  for (const c of rawCells) {
    if (c && typeof c.id === 'string' && Array.isArray(c.coords) && c.coords.some((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]))) {
      points.push(c);
    } else {
      skipped++;
    }
  }
  if (skipped > 0) warnings.push(`${skipped} point(s) skipped: missing id or no valid coordinates.`);
  if (points.length === 0) throw new Error('No points with a valid id and coordinates.');

  const n = points.length;
  const maps = buildMaps(points, n, mapDefs, frameList);
  const primary = maps[0];
  const positions = primary.positions;
  const bounds = primary.bounds;

  // Which keys are ranked (present in point.classes) vs plain values.
  const classKeys = new Set<string>();
  const valueKeys = new Set<string>();
  for (const c of points) {
    if (c.classes) for (const k of Object.keys(c.classes)) classKeys.add(k);
    if (c.values) for (const k of Object.keys(c.values)) valueKeys.add(k);
  }

  const declared = new Map<string, VariableDef>();
  for (const v of manifest.variables ?? []) {
    if (v && typeof v.key === 'string') declared.set(v.key, v);
  }

  // Column order: declared variables first (registry order), then any
  // undeclared keys we discovered, so authors control the panel order.
  const orderedKeys: string[] = [];
  const seen = new Set<string>();
  for (const v of manifest.variables ?? []) {
    if (v && typeof v.key === 'string' && !seen.has(v.key)) {
      orderedKeys.push(v.key);
      seen.add(v.key);
    }
  }
  for (const k of [...classKeys, ...valueKeys]) {
    if (!seen.has(k)) {
      orderedKeys.push(k);
      seen.add(k);
    }
  }

  const columns: Column[] = [];
  for (const key of orderedKeys) {
    const def = declared.get(key);
    // A column's kind comes SOLELY from its declared type (ranked stores its data
    // in point.classes). No name-based guessing — undeclared keys fall back to
    // "ranked iff it has candidate lists".
    const isRanked = def ? def.kind === 'ranked' : classKeys.has(key);
    try {
      if (isRanked) {
        columns.push(buildRankedColumn(key, def, points, n));
      } else if (valueKeys.has(key) || def) {
        columns.push(buildValueColumn(key, def, n, (i) => points[i].values?.[key] ?? null, warnings));
      }
    } catch (e) {
      warnings.push(`Variable "${key}" skipped: ${(e as Error).message}`);
    }
  }

  const columnByKey = indexColumns(columns, maps, points.map((p) => p.id));

  const images = Array.isArray(manifest.images)
    ? manifest.images.filter((im) => im && Array.isArray(im.extent) && im.extent.length === 4 && Array.isArray(im.channels))
    : [];
  if (images.length) warnings.push(`${images.length} image overlay layer(s) loaded.`);

  return {
    source,
    sourceName: sourceName || baseName(source),
    meta: normalizeMeta(manifest.dataset, source),
    points,
    pointIds: points.map((p) => p.id),
    n,
    maps,
    frames: frameList,
    frameCount,
    continuousTime: continuousTime && frameCount > 1,
    primaryMap: primary.index,
    positions,
    bounds,
    columns,
    columnByKey,
    images,
    warnings,
    inferred: [],
  };
}

// Pack one point's coordinate into a position buffer at slot i (NaN if absent).
function writeCoord(buf: Float32Array, i: number, p: PointRecord['coords'][number], dims: 2 | 3): boolean {
  if (p && Number.isFinite(p[0]) && Number.isFinite(p[1])) {
    buf[i * 3] = p[0];
    buf[i * 3 + 1] = p[1];
    buf[i * 3 + 2] = dims === 3 && p.length >= 3 && Number.isFinite(p[2]) ? (p[2] as number) : 0;
    return true;
  }
  return false;
}

// Resolve each declared coordinate map into a packed position buffer + bounds. For
// a multi-frame dataset, a map whose points carry a per-frame `track` becomes an
// ANIMATED map: one n*3 buffer per frame (positions = frame 0), framed over all
// frames so the camera fits the whole motion. Maps without tracks stay static
// (their fixed position repeats across frames — the viewer just never swaps them).
function buildMaps(points: PointRecord[], n: number, mapDefs: CoordMapDef[], frames: number[]): CoordMap[] {
  const F = frames.length;
  const multi = F > 1;
  return mapDefs.map((def) => {
    const dims: 2 | 3 = def.axes.length >= 3 ? 3 : 2;
    const label = `(${def.axes.join(', ')})`;
    const animated = multi && points.some((p) => p.track && p.track[def.index]);

    if (animated) {
      const framePositions: Float32Array[] = [];
      for (let f = 0; f < F; f++) {
        const buf = new Float32Array(n * 3).fill(NaN);
        for (let i = 0; i < n; i++) {
          const tr = points[i].track?.[def.index];
          // A point on a static map (no track for this map) sits at its fixed coord.
          writeCoord(buf, i, tr ? tr[f] : points[i].coords[def.index], dims);
        }
        framePositions.push(buf);
      }
      // A point counts if it is present in ANY frame.
      let count = 0;
      for (let i = 0; i < n; i++) {
        const tr = points[i].track?.[def.index];
        const present = tr ? tr.some((c) => c !== undefined) : !!points[i].coords[def.index];
        if (present) count++;
      }
      return {
        index: def.index,
        axes: def.axes,
        dims,
        label,
        positions: framePositions[0],
        bounds: computeBoundsMulti(framePositions, n),
        count,
        framePositions,
        frameCount: F,
      };
    }

    const positions = new Float32Array(n * 3).fill(NaN);
    let count = 0;
    for (let i = 0; i < n; i++) if (writeCoord(positions, i, points[i].coords[def.index], dims)) count++;
    return { index: def.index, axes: def.axes, dims, label, positions, bounds: computeBounds(positions, n), count };
  });
}

function normalizeMeta(meta: DatasetMeta | undefined, source: string): DatasetMeta {
  const base: DatasetMeta = meta ? { ...meta } : ({ name: '' } as DatasetMeta);
  if (!base.name) base.name = baseName(source);
  return base;
}

function baseName(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

function computeBounds(positions: Float32Array, n: number): Bounds {
  return computeBoundsMulti([positions], n);
}

// Bounds over one or more position buffers (an animated map passes every frame's
// buffer, so the camera frames the whole track). Skips NaN (absent) slots.
function computeBoundsMulti(buffers: Float32Array[], n: number): Bounds {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const positions of buffers) {
    for (let i = 0; i < n; i++) {
      if (!Number.isFinite(positions[i * 3])) continue;
      for (let a = 0; a < 3; a++) {
        const v = positions[i * 3 + a];
        if (v < min[a]) min[a] = v;
        if (v > max[a]) max[a] = v;
      }
    }
  }
  if (!Number.isFinite(min[0])) {
    // Empty map (no points placed here) — a harmless unit box.
    return { min: [0, 0, 0], max: [1, 1, 1], center: [0.5, 0.5, 0.5], radius: 1 };
  }
  const center: [number, number, number] = [
    (min[0] + max[0]) / 2,
    (min[1] + max[1]) / 2,
    (min[2] + max[2]) / 2,
  ];
  const dx = max[0] - min[0];
  const dy = max[1] - min[1];
  const dz = max[2] - min[2];
  const radius = Math.max(1e-6, 0.5 * Math.sqrt(dx * dx + dy * dy + dz * dz));
  return { min, max, center, radius };
}

// ---------------------------------------------------------------------------
// Column builders
// ---------------------------------------------------------------------------

function inferValueKind(n: number, getRaw: RawGetter): 'continuous' | 'categorical' {
  let sawValue = false;
  for (let i = 0; i < n; i++) {
    const v = getRaw(i);
    if (v === null || v === undefined || v === '') continue;
    sawValue = true;
    if (typeof v !== 'number') return 'categorical';
  }
  return sawValue ? 'continuous' : 'categorical';
}

// A point's stored raw value → number. Values arrive as numbers (columns the
// parser typed as gradient) OR strings (categories), so a runtime re-type to
// gradient must still parse numeric text. Empty string is missing, not 0.
const asNumber = (v: unknown): number =>
  typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;

// The type token this column represents + whether the file declared it, carried
// on every column so the type-override UI can show the current type and warn on
// a change that disagrees with the file's suggestion.
function typeMeta(
  def: VariableDef | undefined,
  fallback: DeclaredType,
): { suggestedType: DeclaredType; typeDeclared: boolean } {
  return { suggestedType: def?.suggestedType ?? fallback, typeDeclared: def?.typeDeclared ?? false };
}

// Raw per-point value accessor: returns the point's value for this column (number
// or string, or null/undefined when missing). Decouples column-building from the
// storage shape — the initial build reads point.values; a runtime re-type reads
// the existing column's typed data, so re-typing needs no per-point object array.
type RawGetter = (i: number) => number | string | null | undefined;

function buildValueColumn(
  key: string,
  def: VariableDef | undefined,
  n: number,
  getRaw: RawGetter,
  warnings: string[],
): Column {
  const kind = def?.kind === 'continuous' || def?.kind === 'categorical'
    ? def.kind
    : inferValueKind(n, getRaw);
  const isIdentifier = def?.identifier === true;

  if (kind === 'continuous') {
    const data = new Float32Array(n).fill(NaN);
    let dataMin = Infinity;
    let dataMax = -Infinity;
    let nMissing = 0;
    for (let i = 0; i < n; i++) {
      const num = asNumber(getRaw(i));
      if (Number.isFinite(num)) {
        data[i] = num;
        if (num < dataMin) dataMin = num;
        if (num > dataMax) dataMax = num;
      } else {
        nMissing++;
      }
    }
    if (dataMin === Infinity) {
      dataMin = 0;
      dataMax = 1;
      warnings.push(`Variable "${key}" has no numeric values.`);
    }
    let domain: [number, number] = def?.domain ?? [dataMin, dataMax];
    if (domain[0] === domain[1]) domain = [domain[0] - 0.5, domain[1] + 0.5];
    const scale: 'linear' | 'log' = def?.scale === 'log' && dataMin > 0 ? 'log' : 'linear';
    return {
      kind: 'continuous',
      key,
      label: def?.label ?? key,
      ...typeMeta(def, 'grad'),
      unit: def?.unit,
      description: def?.description,
      data,
      domain,
      dataMin,
      dataMax,
      scale,
      colormap: def?.colormap ?? DEFAULT_COLORMAP,
      nMissing,
    };
  }

  // categorical
  const rawValues: (string | null)[] = new Array(n);
  const counts = new Map<string, number>();
  let nMissing = 0;
  for (let i = 0; i < n; i++) {
    const v = getRaw(i);
    if (v === null || v === undefined || v === '') {
      rawValues[i] = null;
      nMissing++;
    } else {
      const s = String(v);
      rawValues[i] = s;
      counts.set(s, (counts.get(s) ?? 0) + 1);
    }
  }
  const { categories, indexOf, nDistinct } = resolveCategories(counts, def?.categories);
  const data = new Int32Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    const s = rawValues[i];
    if (s !== null) data[i] = indexOf(s);
  }
  // Full distinct-value list (every value, not just the capped colour palette) for
  // the searchable filter checkbox list — sorted by frequency then natural label.
  const distinct = [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value, undefined, { numeric: true, sensitivity: 'base' }));
  return {
    kind: 'categorical',
    key,
    label: def?.label ?? key,
    ...typeMeta(def, isIdentifier ? 'id' : 'cat'),
    unit: def?.unit,
    description: def?.description,
    data,
    categories,
    nDistinct,
    nMissing,
    distinct,
    rawValues,
    ...(isIdentifier ? { isIdentifier: true as const } : {}),
  };
}

function buildRankedColumn(
  key: string,
  def: VariableDef | undefined,
  points: PointRecord[],
  n: number,
): RankedColumn {
  const topLabels: (string | null)[] = new Array(n);
  const conf = new Float32Array(n).fill(NaN);
  const counts = new Map<string, number>();
  let nMissing = 0;
  for (let i = 0; i < n; i++) {
    const list = points[i].classes?.[key];
    if (!Array.isArray(list) || list.length === 0) {
      topLabels[i] = null;
      nMissing++;
      continue;
    }
    // Highest-confidence call; ties keep the first (lists are usually pre-sorted).
    let best = list[0];
    for (const call of list) {
      const bc = typeof best.confidence === 'number' ? best.confidence : -Infinity;
      const cc = typeof call.confidence === 'number' ? call.confidence : -Infinity;
      if (cc > bc) best = call;
    }
    const label = String(best.label);
    topLabels[i] = label;
    counts.set(label, (counts.get(label) ?? 0) + 1);
    if (typeof best.confidence === 'number' && Number.isFinite(best.confidence)) {
      conf[i] = best.confidence;
    }
  }
  const { categories, indexOf, nDistinct } = resolveCategories(counts, def?.categories);
  const top = new Int32Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    const s = topLabels[i];
    if (s !== null) top[i] = indexOf(s);
  }
  return {
    kind: 'ranked',
    key,
    label: def?.label ?? key,
    ...typeMeta(def, 'ranked'),
    unit: def?.unit,
    description: def?.description,
    top,
    conf,
    categories,
    nDistinct,
    colormap: def?.colormap ?? DEFAULT_COLORMAP,
    nMissing,
  };
}

// Re-derive one column under a different type, reusing the same raw per-point
// values (point.values[key]). Powers the per-variable type override: switching
// among gradient / category / identifier just rebuilds the column view — the
// underlying data is untouched. The ORIGINAL file suggestion (suggestedType /
// typeDeclared) is preserved so the "differs from the file" warning keeps
// comparing against the header, not the previous override. Only the scalar
// family is re-typable here; `ranked` spans several columns and stays as-is.
export function rebuildColumnAs(ds: Dataset, key: string, type: 'grad' | 'cat'): Column {
  const old = ds.columnByKey.get(key);
  const def: VariableDef = {
    key,
    label: old?.label ?? key,
    kind: type === 'grad' ? 'continuous' : 'categorical',
    unit: old?.unit,
    description: old?.description,
    suggestedType: old?.suggestedType ?? type,
    typeDeclared: old?.typeDeclared ?? false,
  };
  // Re-type reads the raw value back out of the EXISTING column's typed data, so it
  // works without a per-point object array (large datasets have none).
  return buildValueColumn(key, def, ds.n, (i) => rawFromColumn(old, i), []);
}

// The raw per-point value stored in a built column, for re-typing / reconstruction.
// Continuous → the number; categorical → its category value (or the kept raw string
// for identifiers); ranked isn't re-typable so returns null.
function rawFromColumn(col: Column | undefined, i: number): number | string | null {
  if (!col) return null;
  if (col.kind === 'continuous') return Number.isFinite(col.data[i]) ? col.data[i] : null;
  if (col.kind === 'categorical') {
    // Prefer the true per-point string (kept for every categorical) over the capped
    // colour-category value, which may be the "(other)" bucket label.
    if (col.rawValues) return col.rawValues[i] ?? null;
    const idx = col.data[i];
    return idx >= 0 ? (col.categories[idx]?.value ?? null) : null;
  }
  return null;
}

// Build the display category list (declared order first, then by count desc,
// capped with an "(other)" bucket) and a value->index lookup.
function resolveCategories(
  counts: Map<string, number>,
  declared?: CategoryDef[],
): { categories: ResolvedCategory[]; indexOf: (value: string) => number; nDistinct: number } {
  const orderedValues: string[] = [];
  const seen = new Set<string>();
  const declaredColor = new Map<string, string>();
  const declaredLabel = new Map<string, string>();

  if (declared) {
    for (const d of declared) {
      if (!d || typeof d.value !== 'string' || seen.has(d.value)) continue;
      orderedValues.push(d.value);
      seen.add(d.value);
      if (d.color) declaredColor.set(d.value, d.color);
      if (d.label) declaredLabel.set(d.value, d.label);
    }
  }
  const remaining = [...counts.keys()].filter((v) => !seen.has(v));
  remaining.sort((a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0) || a.localeCompare(b));
  for (const v of remaining) orderedValues.push(v);

  const capped = orderedValues.slice(0, MAX_CATEGORIES);
  const overflow = orderedValues.length > MAX_CATEGORIES;

  const indexByValue = new Map<string, number>();
  const categories: ResolvedCategory[] = capped.map((value, index) => {
    indexByValue.set(value, index);
    const declaredHex = declaredColor.get(value);
    const color = (declaredHex && hexToRgb(declaredHex)) || categoricalColor(index);
    return {
      index,
      value,
      label: declaredLabel.get(value) ?? value,
      color,
      colorHex: rgbToHex(color),
      count: counts.get(value) ?? 0,
    };
  });

  let otherIndex = -1;
  if (overflow) {
    otherIndex = categories.length;
    let otherCount = 0;
    for (let i = MAX_CATEGORIES; i < orderedValues.length; i++) {
      otherCount += counts.get(orderedValues[i]) ?? 0;
    }
    categories.push({
      index: otherIndex,
      value: OTHER_LABEL,
      label: `${OTHER_LABEL} ${orderedValues.length - MAX_CATEGORIES} more`,
      color: OTHER_COLOR,
      colorHex: rgbToHex(OTHER_COLOR),
      count: otherCount,
      isOther: true,
    });
  }

  const indexOf = (value: string): number => {
    const idx = indexByValue.get(value);
    if (idx !== undefined) return idx;
    return otherIndex; // -1 when there is no overflow bucket and value is unknown
  };

  return { categories, indexOf, nDistinct: orderedValues.length };
}

// ---------------------------------------------------------------------------
// Columnar (large-dataset) representation — a Dataset whose per-point records are
// reconstructed on demand from the typed-array columns instead of living as
// millions of JS objects. Produced by the parse worker (src/format/parseWorker.ts).
// ---------------------------------------------------------------------------

// The serializable slice of a Dataset that crosses the worker→main boundary: the
// columns/maps (typed-array-backed, structured-cloneable) + the flat id list + SPARSE
// per-point ranked calls / outlines (null when the dataset has none). The derived
// columnByKey / positions / bounds and the lazy `points` view are rebuilt on the main
// thread by payloadToDataset.
export interface DatasetPayload {
  source: string;
  sourceName: string;
  meta: DatasetMeta;
  maps: CoordMap[];
  columns: Column[];
  pointIds: string[];
  pointClasses: (Record<string, ClassCall[]> | undefined)[] | null;
  pointOutlines: (([number, number][]) | undefined)[] | null;
  frames: number[];
  frameCount: number;
  continuousTime: boolean;
  primaryMap: number;
  images: ImageLayer[];
  warnings: string[];
  inferred: { key: string; type: DeclaredType }[];
  rawImport?: RawImportInfo;
}

// Strip a built Dataset down to its transferable payload (runs in the worker). The
// heavy transient `points`/intermediate arrays stay behind and are GC'd there.
export function datasetToPayload(ds: Dataset): DatasetPayload {
  const hasRanked = ds.columns.some((c) => c.kind === 'ranked');
  const hasOutline = ds.points.some((p) => p.outline);
  return {
    source: ds.source,
    sourceName: ds.sourceName,
    meta: ds.meta,
    maps: ds.maps,
    columns: ds.columns,
    pointIds: ds.pointIds,
    // Ranked candidate lists / outlines can't be reconstructed from the columns
    // (which keep only the top call), so ship them — but only when present (a huge
    // scalar table like MERFISH has neither → null → no per-point overhead).
    pointClasses: hasRanked ? ds.points.map((p) => p.classes) : null,
    pointOutlines: hasOutline ? ds.points.map((p) => p.outline) : null,
    frames: ds.frames,
    frameCount: ds.frameCount,
    continuousTime: ds.continuousTime,
    primaryMap: ds.primaryMap,
    images: ds.images,
    warnings: ds.warnings,
    inferred: ds.inferred,
    rawImport: ds.rawImport,
  };
}

// Rebuild a Dataset from a worker payload (runs on the main thread): reconstruct
// columnByKey + positions/bounds aliases, and install the lazy `points` view.
export function payloadToDataset(p: DatasetPayload): Dataset {
  const columnByKey = indexColumns(p.columns, p.maps, p.pointIds);
  const primary = p.maps.find((m) => m.index === p.primaryMap) ?? p.maps[0];
  return {
    source: p.source,
    sourceName: p.sourceName,
    meta: p.meta,
    points: makePointsView(p),
    pointIds: p.pointIds,
    n: p.pointIds.length,
    maps: p.maps,
    frames: p.frames,
    frameCount: p.frameCount,
    continuousTime: p.continuousTime,
    primaryMap: p.primaryMap,
    positions: primary.positions,
    bounds: primary.bounds,
    columns: p.columns,
    columnByKey,
    images: p.images,
    warnings: p.warnings,
    inferred: p.inferred,
    rawImport: p.rawImport,
  };
}

// Reconstruct one point's coords across all maps from the maps' position buffers.
function coordsAt(maps: CoordMap[], i: number): (Coord | undefined)[] {
  const coords: (Coord | undefined)[] = [];
  for (const m of maps) {
    const x = m.positions[i * 3];
    if (!Number.isFinite(x)) continue; // absent from this map
    coords[m.index] = m.dims === 3 ? [x, m.positions[i * 3 + 1], m.positions[i * 3 + 2]] : [x, m.positions[i * 3 + 1]];
  }
  return coords;
}

// Reconstruct one point's values object from the value columns (skips ranked).
function valuesAt(columns: Column[], i: number): Record<string, number | string | null> {
  const values: Record<string, number | string | null> = {};
  for (const c of columns) {
    if (c.kind === 'ranked') continue;
    const raw = rawFromColumn(c, i);
    if (raw !== null && raw !== undefined) values[c.key] = raw;
  }
  return values;
}

// Reconstruct one point's ranked calls (TOP call only) from the ranked columns —
// used when the payload didn't ship full candidate lists (large datasets).
function topClassesAt(columns: Column[], i: number): Record<string, ClassCall[]> {
  const classes: Record<string, ClassCall[]> = {};
  for (const c of columns) {
    if (c.kind !== 'ranked') continue;
    const idx = c.top[i];
    if (idx < 0) continue;
    const call: ClassCall = { label: c.categories[idx]?.value ?? String(idx) };
    if (Number.isFinite(c.conf[i])) call.confidence = c.conf[i];
    classes[c.key] = [call];
  }
  return classes;
}

// A lazy, array-like `points` that reconstructs a PointRecord on index access from
// the columnar payload — so a multi-million-point dataset holds only typed arrays +
// the id list, never millions of objects. Supports what the app uses on
// `dataset.points`: indexing, `.length`, `.findIndex`, and iteration.
function makePointsView(p: DatasetPayload): PointRecord[] {
  const n = p.pointIds.length;
  const cols = p.columns;
  const build = (i: number): PointRecord => {
    const rec: PointRecord = { id: p.pointIds[i], coords: coordsAt(p.maps, i) };
    const values = valuesAt(cols, i);
    if (Object.keys(values).length) rec.values = values;
    const classes = p.pointClasses ? p.pointClasses[i] : topClassesAt(cols, i);
    if (classes && Object.keys(classes).length) rec.classes = classes;
    const outline = p.pointOutlines?.[i];
    if (outline) rec.outline = outline;
    return rec;
  };
  const handler: ProxyHandler<PointRecord[]> = {
    get(_t, prop) {
      if (prop === 'length') return n;
      if (prop === 'findIndex') {
        return (fn: (r: PointRecord, i: number) => boolean) => {
          for (let i = 0; i < n; i++) if (fn(build(i), i)) return i;
          return -1;
        };
      }
      if (prop === Symbol.iterator) {
        return function* () {
          for (let i = 0; i < n; i++) yield build(i);
        };
      }
      if (typeof prop === 'string') {
        const i = Number(prop);
        if (Number.isInteger(i) && i >= 0 && i < n) return build(i);
      }
      return undefined;
    },
    has(_t, prop) {
      if (typeof prop === 'string') {
        const i = Number(prop);
        if (Number.isInteger(i)) return i >= 0 && i < n;
      }
      return prop === 'length' || prop === 'findIndex' || prop === Symbol.iterator;
    },
  };
  return new Proxy([] as PointRecord[], handler);
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

// Human labels for the declared variable types (dropdowns, dialogs).
export const TYPE_LABELS: Record<DeclaredType, string> = {
  grad: 'numerical',
  cat: 'categorical',
  id: 'categorical', // (dormant) former identifier — now just categorical
  ranked: 'categorical', // (dormant) former ranked — now split into label + confidence columns
};

export function formatNumber(v: number): string {
  if (!Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  if (a !== 0 && (a < 1e-3 || a >= 1e6)) return v.toExponential(3);
  if (Number.isInteger(v)) return v.toLocaleString();
  return v.toPrecision(a >= 1 ? 5 : 3).replace(/\.?0+$/, '');
}

/**
 * True when a categorical/ranked variable had more distinct values than the
 * palette can show (so it carries an "(other)" bucket). Thousands of spatial
 * barcodes hit this — colouring by top label would be meaningless, so callers
 * colour by confidence instead.
 */
export function hasCategoryOverflow(col: Column): boolean {
  return col.kind !== 'continuous' && col.categories.some((c) => c.isOther);
}

/**
 * True for a high-cardinality identifier column (declared `name__id`, e.g.
 * spatial_barcode). Identifiers are stored like categoricals but are never
 * offered as a colour axis and are filtered by a text match rather than
 * per-value checkboxes.
 */
export function isIdentifierColumn(col: Column): col is CategoricalColumn {
  return col.kind === 'categorical' && col.isIdentifier === true;
}

/**
 * Category order for *display only* (legend + filter list): natural
 * alphanumeric by label ("S1, S2, … S10", "I02-…, I03-…"), with the "(other)"
 * overflow bucket pinned last. Returns a sorted copy — the underlying
 * `categories` array must stay in index order because per-point codes index it
 * positionally (see `columnValueLabel`, derive.ts, SelectionSummary).
 */
export function displayCategories(categories: ResolvedCategory[]): ResolvedCategory[] {
  return [...categories].sort((a, b) => {
    if (!!a.isOther !== !!b.isOther) return a.isOther ? 1 : -1;
    return a.label.localeCompare(b.label, undefined, { numeric: true, sensitivity: 'base' });
  });
}

function topLabelOf(list: ClassCall[] | undefined): string | null {
  if (!Array.isArray(list) || list.length === 0) return null;
  let best = list[0];
  for (const c of list) {
    const bc = typeof best.confidence === 'number' ? best.confidence : -Infinity;
    const cc = typeof c.confidence === 'number' ? c.confidence : -Infinity;
    if (cc > bc) best = c;
  }
  return String(best.label);
}

/**
 * Human-readable value of a column for point i (for tooltips / details). When a
 * high-cardinality categorical/ranked value fell into the "(other)" bucket, show
 * the point's ACTUAL value (e.g. its real assigned_barcode) rather than the bucket
 * label — the raw value is still on the point record.
 */
export function columnValueLabel(dataset: Dataset, col: Column, i: number): string {
  if (col.kind === 'continuous') {
    const v = col.data[i];
    return Number.isNaN(v) ? '—' : formatNumber(v) + (col.unit ? ` ${col.unit}` : '');
  }
  if (col.kind === 'categorical') {
    const idx = col.data[i];
    if (idx >= 0 && !col.categories[idx]?.isOther) return col.categories[idx].label;
    const raw = dataset.points[i]?.values?.[col.key];
    return raw == null || raw === '' ? '—' : String(raw);
  }
  // ranked
  const idx = col.top[i];
  if (idx < 0) return '—';
  const c = col.conf[i];
  let label = col.categories[idx]?.label ?? '—';
  if (col.categories[idx]?.isOther) {
    const raw = topLabelOf(dataset.points[i]?.classes?.[col.key]);
    if (raw) label = raw;
  }
  return Number.isNaN(c) ? label : `${label} (${(c * 100).toFixed(0)}%)`;
}
