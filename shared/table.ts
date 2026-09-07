// Flat spreadsheet (CSV / TSV) save format — the simple, Excel-friendly shape.
//
// A CELLS table has one row per point; a header row names the columns. A separate
// IMAGES table has one row per image channel. Both parse into the exact same
// in-memory records the JSON `.maplet` format produces (PointRecord / ImageLayer),
// so the whole viewer is unchanged — only the front door is new.
//
// This module is pure string processing (no DOM, no Node), so it is shared by
// the renderer AND the Electron main process.
//
// Column convention for the CELLS table (names matched case-insensitively):
//   id                      required, unique point id
//   x, y                    required coordinates; z optional (default 0)
//   umap_1, umap_2[, umap_3] optional UMAP embedding
//   outline                 optional packed polygon "x,y; x,y; ..."
//
// Every OTHER column declares its type in the header as `name__type`
// (cat_prototype_06). The type fixes how the app shows + filters it:
//   name__grad     a 0..1 (or any-range) gradient  -> colour ramp + min/max filter
//   name__cat      a discrete category             -> palette + checkboxes
//   name__id       a high-cardinality identifier   -> never coloured; text-match filter
//   name__ranked   a ranked call (+ `name_conf`)   -> top label / confidence + min-conf
// Ranked calls span columns: `K__ranked` + `K_conf`, then `K_2__ranked` +
// `K_2_conf`, … ; `K_reads` etc. ride along as per-candidate detail fields.
// Confidences may be 0..1 or 0..100 (auto-detected per column). A column with NO
// `__type` tag is still accepted — its type is inferred (numeric ⇒ grad, text ⇒
// cat; a `_conf` sibling ⇒ ranked) and a warning suggests tagging it.

import type { Coord, PointRecord, CoordMapDef, DatasetMeta, DeclaredType, HeaderType, ImageLayer, VariableDef } from './types';

export type Delimiter = ',' | '\t';

const NA = new Set(['', 'na', 'n/a', 'nan', 'null', 'none', '#n/a']);
const isMissing = (s: string): boolean => NA.has(s.trim().toLowerCase());
const norm = (s: string): string => s.trim().toLowerCase();

function toNum(s: string): number {
  const t = s.trim();
  if (isMissing(t)) return NaN;
  const n = Number(t);
  return Number.isFinite(n) ? n : NaN;
}

function baseName(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

// A column declares its role in the header as `name__token`. Tokens are either a
// variable type (grad|cat|id|ranked) or a coordinate axis (x0/y0/z0, x1/y1/z1, …
// — axis letter + map index). Split into the clean display name + the raw token.
const TYPE_RE = /^(.*?)__(grad|cat|id|ranked|[xyz]\d+)$/i;
const COORD_RE = /^([xyz])(\d+)$/i;
function splitType(raw: string): { name: string; token?: string } {
  const m = TYPE_RE.exec(raw.trim());
  if (m && m[1]) return { name: m[1].trim(), token: m[2].toLowerCase() };
  return { name: raw.trim() };
}
// A variable type token (grad/cat/id/ranked), or undefined for coordinate/none.
function declaredTypeOf(token: string | undefined): HeaderType | undefined {
  return token === 'grad' || token === 'cat' || token === 'id' || token === 'ranked' ? token : undefined;
}
// Strip a trailing rank suffix (`_2`, `_3`, …) to get a ranked variable's base.
function stripRank(base: string): string {
  const m = /^(.*)_(\d+)$/.exec(base);
  return m ? m[1] : base;
}

// ---------------------------------------------------------------------------
// Delimiter + low-level parse
// ---------------------------------------------------------------------------

export function detectDelimiter(text: string, filename?: string): Delimiter {
  const f = (filename ?? '').toLowerCase();
  if (f.endsWith('.tsv') || f.endsWith('.tab')) return '\t';
  if (f.endsWith('.csv')) return ',';
  const line = text.split(/\r?\n/).find((l) => l.trim() !== '') ?? '';
  const tabs = (line.match(/\t/g) || []).length;
  const commas = (line.match(/,/g) || []).length;
  return tabs > commas ? '\t' : ',';
}

// RFC4180-ish: quoted fields, doubled quotes, newlines inside quotes. A line
// whose first field starts with '#' (outside quotes) is a comment.
export function parseDelimited(text: string, delim: Delimiter): string[][] {
  const bom = text.charCodeAt(0) === 0xfeff ? 1 : 0; // strip BOM

  // Fast path: when the file has NO quoted fields (the common case for numeric
  // scientific tables), split natively by line + delimiter. This is several times
  // faster than the character scanner below (which does `field += c` per char) and
  // produces byte-identical rows. The scanner handles quotes when they appear.
  if (text.indexOf('"', bom) === -1) {
    const rows: string[][] = [];
    const len = text.length;
    let from = bom;
    while (from < len) {
      let nl = text.indexOf('\n', from);
      if (nl === -1) nl = len;
      let end = nl;
      if (end > from && text.charCodeAt(end - 1) === 13) end--; // trailing \r
      if (end > from && text.charCodeAt(from) !== 35) {
        // not blank and not a '#' comment line
        const cells = text.slice(from, end).split(delim);
        if (!(cells.length === 1 && cells[0].trim() === '')) rows.push(cells);
      }
      from = nl + 1;
    }
    return rows;
  }

  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;
  let atFieldStart = true;
  let atRowStart = true;
  let i = bom;
  const n = text.length;

  const pushField = () => {
    row.push(field);
    field = '';
    atFieldStart = true;
  };
  const pushRow = () => {
    rows.push(row);
    row = [];
    atRowStart = true;
    atFieldStart = true;
  };

  while (i < n) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (atRowStart && atFieldStart && c === '#') {
      while (i < n && text[i] !== '\n') i++;
      i++;
      continue;
    }
    if (c === '"' && atFieldStart) {
      inQuotes = true;
      atFieldStart = false;
      atRowStart = false;
      i++;
      continue;
    }
    if (c === delim) {
      pushField();
      atRowStart = false;
      i++;
      continue;
    }
    if (c === '\r') {
      i++;
      continue;
    }
    if (c === '\n') {
      pushField();
      pushRow();
      i++;
      continue;
    }
    field += c;
    atFieldStart = false;
    atRowStart = false;
    i++;
  }
  if (field !== '' || row.length > 0) {
    pushField();
    pushRow();
  }
  return rows.filter((r) => !(r.length === 1 && r[0].trim() === ''));
}

// ---------------------------------------------------------------------------
// Points table
// ---------------------------------------------------------------------------

export interface PointsTableResult {
  meta: DatasetMeta;
  variables: VariableDef[];
  maps: CoordMapDef[]; // coordinate maps declared by the header, sorted by index
  points: PointRecord[];
  warnings: string[];
  // Columns whose type had to be INFERRED (no `__type` tag). The app surfaces
  // these in a confirmation dialog so the user can tag them or override in-app.
  inferred: { key: string; type: DeclaredType }[];
  // Multi-frame (long format): the dataset's sorted, distinct frame/time values.
  // When set (length > 1), each point carries a per-frame position track
  // (PointRecord.track) aligned to this array; absent/undefined for a single-frame
  // table.
  frames?: number[];
  // The time axis is CONTINUOUS (header token `time`/`t`) vs DISCRETE frame indices
  // (`frame`/`step`). Continuous scrubs over the real value range; discrete steps
  // through equal frames. Either way positions are held (no interpolation).
  continuousTime?: boolean;
  // Set only when the table had NO type tags and the id + coordinate columns had to
  // be detected by name/value (a raw metadata export). Drives the "confirm what we
  // detected" summary in the type-review dialog.
  rawImport?: RawImportInfo;
}

// What the raw-table importer detected for a plain (untagged) table.
export interface RawImportInfo {
  idColumn: string | null; // the column used as the point id, or null when synthesized
  synthesizedId: boolean; // ids were fabricated from the row number (no id column found)
  coordColumns: string[]; // source column names used as coordinates (across all maps)
}

interface RankSlot {
  labelIdx: number;
  confIdx: number;
  extras: { field: string; idx: number }[];
}
interface RankedVar {
  key: string; // display key (original case of the rank-1 label column)
  base: string; // lower-cased base
  ranks: RankSlot[];
  confPercent: boolean;
  declared: boolean; // true when a `__ranked` tag declared it (vs `_conf` inference)
}

// One resolved coordinate map: the axis columns' indices + display names.
interface RawMapResolved {
  index: number;
  xi: number;
  yi: number;
  zi: number; // -1 for a 2D map
  xName: string;
  yName: string;
  zName: string;
}

// A single typed value column (grad -> continuous, cat/id -> categorical).
interface ScalarCol {
  key: string;
  idx: number;
  kind: 'continuous' | 'categorical';
  identifier: boolean; // a high-cardinality `id` column
  suggestedType: DeclaredType; // grad | cat | id
  declared: boolean; // header carried an explicit type
}

// The header roles both formats resolve to; `assembleTable` turns this + the data
// rows into the final points / variables / meta.
interface ResolvedTable {
  idIdx: number;
  coordMaps: RawMapResolved[];
  outlineIdx: number;
  ranked: RankedVar[];
  scalarCols: ScalarCol[];
  inferred: { key: string; type: DeclaredType }[];
}

function parseOutline(s: string): [number, number][] | null {
  const t = s.trim();
  if (!t || isMissing(t)) return null;
  const pts: [number, number][] = [];
  for (const part of t.split(/[;|]/)) {
    const xy = part
      .trim()
      .split(/[,\s]+/)
      .map(Number);
    if (xy.length >= 2 && Number.isFinite(xy[0]) && Number.isFinite(xy[1])) pts.push([xy[0], xy[1]]);
  }
  return pts.length >= 2 ? pts : null;
}

// Cell-count cap: when a loaded table exceeds the cap, the app asks the user how to
// reduce it (uniform random draw, or a hard cut-off at the first N); the chosen method
// rides down to the parser here.
export type CapMethod = 'random' | 'head';
export interface CapOption {
  max: number;
  method: CapMethod;
}

// Approximate DATA-row count of a raw table, counted cheaply from newlines (never
// building the split rows) so the loader can decide whether to prompt for the cap on a
// huge file without parsing it first. Off by the header row count (1–2), immaterial
// against a 100k threshold.
export function countDataLines(text: string): number {
  let lines = 0;
  const n = text.length;
  for (let i = 0; i < n; i++) if (text.charCodeAt(i) === 10) lines++;
  if (n > 0 && text.charCodeAt(n - 1) !== 10) lines++; // last line, no trailing newline
  return Math.max(0, lines - 1); // minus the (single) header row
}

// The most points the viewer stays fully smooth with. GPU rendering handles far more,
// but hover picking is a brute-force O(n) raycast and colour/filter/visibility recompute
// is O(n) per change, so this is the point where every interaction still feels instant.
// A larger table is offered as "load the first N" or "Load anyway" (full, may be less
// snappy), never silently failed.
export const CELL_CAP = 250_000;

// Header row + up to `nRows` DATA rows, by a cheap newline scan (no full parse). Used
// to reduce a huge table to a loadable prefix without splitting every row first.
export function headText(text: string, nRows: number): string {
  let idx = 0;
  let seen = 0;
  const need = nRows + 1; // header + nRows data rows
  const len = text.length;
  while (idx < len && seen < need) {
    const nl = text.indexOf('\n', idx);
    if (nl === -1) return text; // fewer than `need` lines — the whole text is already small
    idx = nl + 1;
    seen++;
  }
  return text.slice(0, idx);
}

// Reduce data rows to `max` by the chosen method: a hard cut-off keeps the first N in
// file order; a random draw takes a uniform, unbiased sample via reservoir sampling.
function sampleRows(rows: string[][], max: number, method: CapMethod): string[][] {
  if (rows.length <= max) return rows;
  if (method === 'head') return rows.slice(0, max);
  const out = rows.slice(0, max);
  for (let i = max; i < rows.length; i++) {
    const j = Math.floor(Math.random() * (i + 1));
    if (j < max) out[j] = rows[i];
  }
  return out;
}

export function parsePointsTable(text: string, source = 'points table', delimHint?: Delimiter, cap?: CapOption): PointsTableResult {
  const delim = delimHint ?? detectDelimiter(text, source);
  let all = parseDelimited(text, delim);
  const warnings: string[] = [];
  if (all.length < 2) throw new Error('Points table has no data rows (need a header row and at least one point).');

  // Cell cap: subsample the DATA rows (keeping the header) when the table exceeds the
  // cap, so a huge table never builds more than `cap.max` point records downstream.
  if (cap && cap.max > 0) {
    const H = isTwoRowHeader(all) ? 2 : 1;
    const dataCount = all.length - H;
    if (dataCount > cap.max) {
      all = [...all.slice(0, H), ...sampleRows(all.slice(H), cap.max, cap.method)];
      warnings.push(
        `Loaded ${cap.max.toLocaleString()} of ${dataCount.toLocaleString()} cells — ${cap.method === 'head' ? `first ${cap.max.toLocaleString()} (hard cut-off)` : 'uniform random subsample'}.`,
      );
    }
  }

  // Two-row header (names on row 1, type tokens on row 2) — the newer format.
  if (isTwoRowHeader(all)) return parseTwoRowTable(all, source, warnings);

  const rawHeader = all[0].map((h) => h.trim());
  const typed = rawHeader.map(splitType);
  const header = typed.map((t) => t.name); // display names (token stripped)
  const tokenOf = typed.map((t) => t.token); // raw token: grad|cat|id|ranked|x0|y0|… |undefined
  const typeOf = tokenOf.map(declaredTypeOf); // variable type only (coords excluded)
  const lower = header.map(norm);
  const rows = all.slice(1);

  // No coordinate tags (`__x0`/`__y0`) anywhere → a plain / raw table (e.g. a
  // MERFISH or AnnData metadata export). Detect the id + coordinate columns by name
  // and infer each remaining column's type from its values; the app then asks the
  // user to confirm/adjust the types. Any `__grad`/`__cat`/`__id` variable tag that
  // IS present is still honoured. (Tagged files keep the typed path below.)
  if (!tokenOf.some((t) => t && COORD_RE.test(t))) {
    return parseRawTable(header, typeOf, rows, source, warnings);
  }

  const lowerToIdx = new Map<string, number>();
  lower.forEach((l, i) => {
    if (l && !lowerToIdx.has(l)) lowerToIdx.set(l, i);
  });
  const findCol = (...names: string[]): number => {
    for (const nm of names) {
      const i = lowerToIdx.get(nm);
      if (i !== undefined) return i;
    }
    return -1;
  };

  const idIdx = findCol('id', 'cell_id', 'cellid', 'point', 'name', 'point_id', 'point');
  if (idIdx < 0) throw new Error('Table needs an "id" column.');

  const used = new Set<number>();
  used.add(idIdx);

  // Coordinate maps: columns tagged `<axis>__x{n}` / `__y{n}` / `__z{n}` group by
  // the map index n. e.g. spatial_x__x0, spatial_y__y0, spatial_z__z0 → map 0
  // (axes [spatial_x, spatial_y, spatial_z]); umap__x1, umap2__y1 → map 1 (2D).
  // z is optional per map (its absence makes a 2D map). Each column's display
  // name is the axis label shown in the panel title.
  interface RawMap { index: number; xi: number; yi: number; zi: number; xName: string; yName: string; zName: string }
  const rawMaps = new Map<number, RawMap>();
  for (let i = 0; i < header.length; i++) {
    const cm = tokenOf[i] ? COORD_RE.exec(tokenOf[i] as string) : null;
    if (!cm) continue;
    const axis = cm[1].toLowerCase() as 'x' | 'y' | 'z';
    const mi = parseInt(cm[2], 10);
    let m = rawMaps.get(mi);
    if (!m) {
      m = { index: mi, xi: -1, yi: -1, zi: -1, xName: '', yName: '', zName: '' };
      rawMaps.set(mi, m);
    }
    m[axis === 'x' ? 'xi' : axis === 'y' ? 'yi' : 'zi'] = i;
    m[axis === 'x' ? 'xName' : axis === 'y' ? 'yName' : 'zName'] = header[i] || axis + mi;
    used.add(i);
  }

  // Keep only complete maps (both x and y). A lone x{n}/y{n} can't place a point.
  const coordMaps = [...rawMaps.values()]
    .filter((m) => {
      if (m.xi >= 0 && m.yi >= 0) return true;
      warnings.push(`Coordinate map ${m.index} is missing its ${m.xi < 0 ? 'x' : 'y'}${m.index} column and was ignored.`);
      return false;
    })
    .sort((a, b) => a.index - b.index);
  if (!coordMaps.length) {
    throw new Error('Table needs coordinate columns, e.g. spatial_x__x0 and spatial_y__y0 (add __z0 for 3D).');
  }

  const outlineIdx = findCol('outline', 'polygon', 'boundary');
  if (outlineIdx >= 0) used.add(outlineIdx);

  // Columns whose type had to be inferred (no `__type` tag), for the confirm dialog.
  const inferred: { key: string; type: DeclaredType }[] = [];

  // Ranked groups: a base is ranked when EITHER a label column is tagged
  // `<base>__ranked`, OR (legacy, untyped) it has a `<base>_conf` sibling. An
  // explicit non-ranked tag (grad/cat/id) on the label column suppresses the
  // legacy inference.
  const explicitRanked = new Set<string>();
  const rankedBases = new Set<string>();
  for (let i = 0; i < header.length; i++) {
    if (used.has(i) || !header[i]) continue;
    if (typeOf[i] === 'ranked') {
      const base = stripRank(lower[i]);
      explicitRanked.add(base);
      rankedBases.add(base);
    }
  }
  for (let i = 0; i < header.length; i++) {
    if (used.has(i) || !header[i]) continue;
    if (typeOf[i]) continue; // an explicitly-typed `*_conf` column (e.g. barcode_conf__grad) is standalone
    const m = /^(.*)_conf$/.exec(lower[i]);
    if (m && m[1]) rankedBases.add(stripRank(m[1]));
  }

  const ranked: RankedVar[] = [];
  for (const base of rankedBases) {
    const lab1 = lowerToIdx.get(base);
    // No rank-1 label column -> not a ranked group (e.g. a stray `foo_conf`); leave
    // its columns for the scalar pass rather than consuming them here.
    if (lab1 === undefined) continue;
    // Respect an explicit non-ranked tag on the rank-1 label column.
    if (!explicitRanked.has(base) && typeOf[lab1] && typeOf[lab1] !== 'ranked') continue;

    const ranks: RankSlot[] = [];
    for (let r = 1; ; r++) {
      const labLower = r === 1 ? base : `${base}_${r}`;
      const labelIdx = lowerToIdx.get(labLower) ?? -1;
      const confIdx = lowerToIdx.get(`${labLower}_conf`) ?? -1;
      if (labelIdx < 0 && confIdx < 0) break;
      ranks.push({ labelIdx, confIdx, extras: [] });
      if (labelIdx >= 0) used.add(labelIdx);
      if (confIdx >= 0) used.add(confIdx);
    }
    if (!ranks.length || ranks[0].labelIdx < 0) continue;

    // Extra per-candidate fields: unused columns prefixed with the base.
    for (let i = 0; i < header.length; i++) {
      if (used.has(i)) continue;
      const hl = lower[i];
      if (!hl.startsWith(base + '_')) continue;
      let rest = hl.slice(base.length + 1);
      let rank = 1;
      const rm = /^(\d+)_(.+)$/.exec(rest);
      if (rm) {
        rank = parseInt(rm[1], 10);
        rest = rm[2];
      }
      if (/^\d+$/.test(rest)) continue; // a numbered label rank
      while (ranks.length < rank) ranks.push({ labelIdx: -1, confIdx: -1, extras: [] });
      ranks[rank - 1].extras.push({ field: rest, idx: i });
      used.add(i);
    }

    let maxConf = 0;
    for (const rk of ranks) {
      if (rk.confIdx < 0) continue;
      for (const r of rows) {
        const c = toNum(r[rk.confIdx] ?? '');
        if (Number.isFinite(c) && c > maxConf) maxConf = c;
      }
    }
    const key = header[ranks[0].labelIdx];
    const declared = explicitRanked.has(base);
    if (!declared) inferred.push({ key, type: 'ranked' });
    ranked.push({
      key,
      base,
      ranks,
      confPercent: maxConf > 1.001,
      declared,
    });
  }

  // Everything still unused is a single typed value column: grad -> continuous,
  // cat/id -> categorical (id is a high-cardinality identifier), untyped ->
  // inferred (numeric ⇒ continuous, else categorical) with a warning.
  const scalarCols: ScalarCol[] = [];
  for (let i = 0; i < header.length; i++) {
    if (used.has(i) || !header[i]) continue;
    const t = typeOf[i]; // 'grad' | 'cat' | 'id' | 'ranked' | 'umap' | undefined
    let kind: 'continuous' | 'categorical';
    let identifier = false;
    let suggestedType: DeclaredType;
    const declared = t === 'grad' || t === 'cat' || t === 'id';
    if (t === 'grad') {
      kind = 'continuous';
      suggestedType = 'grad';
    } else if (t === 'id') {
      kind = 'categorical';
      identifier = true;
      suggestedType = 'id';
    } else if (t === 'cat') {
      kind = 'categorical';
      suggestedType = 'cat';
    } else {
      // Untyped: infer numeric ⇒ gradient, else category, and flag for the dialog.
      let numeric = true;
      let sawVal = false;
      for (const r of rows) {
        const raw = r[i] ?? '';
        if (isMissing(raw)) continue;
        sawVal = true;
        if (!Number.isFinite(toNum(raw))) {
          numeric = false;
          break;
        }
      }
      kind = sawVal && numeric ? 'continuous' : 'categorical';
      suggestedType = kind === 'continuous' ? 'grad' : 'cat';
      inferred.push({ key: header[i], type: suggestedType });
    }
    scalarCols.push({ key: header[i], idx: i, kind, identifier, suggestedType, declared });
    used.add(i);
  }

  return assembleTable(rows, { idIdx, coordMaps, outlineIdx, ranked, scalarCols, inferred }, source, warnings);
}

// ===========================================================================
// Load-time column assignment (cat_prototype_10)
// ---------------------------------------------------------------------------
// The header/type NOTATION (`name__grad`, `name__x0`, two-row type rows, `_conf`
// ranked siblings) is no longer read as authoritative. Instead, on load the app
// INSPECTS the table — proposing an id column, coordinate maps, and a numerical /
// categorical type per column from the column NAMES and VALUES — and the user
// confirms or edits that in a modal. The confirmed Assignment drives the build.
//
// There are exactly TWO variable types now: numerical (a number ramp) and
// categorical (a searchable value list). A former ranked group is just its label
// column (categorical) + its confidence column (numerical) — two plain columns —
// and a former identifier is just a categorical. `inspectTable` builds the
// proposal; `buildTableFromAssignment` turns text + Assignment into the dataset.
// ===========================================================================

// The only two variable types the app exposes. `grad` = numerical, `cat` = categorical.
export type VarType = 'grad' | 'cat';

// One coordinate map in an assignment: its viewer index (0 = main viewer, 1..3 =
// the smaller auxiliary viewers) and the FILE COLUMN INDICES of its axes. zi = -1
// makes it a 2-D map. Columns are referenced by index (never by name) so duplicate
// or blank column names are never ambiguous.
export interface MapAssign {
  index: number;
  xi: number;
  yi: number;
  zi: number;
}

// A fully-resolved assignment of source columns to roles. Any column not named as
// the id, a coordinate axis, or a variable is dropped (ignored).
export interface Assignment {
  delimiter: Delimiter;
  header: string[]; // display names (any legacy __token stripped), aligned to file columns
  idIdx: number; // -1 = synthesize ids from the row number
  maps: MapAssign[]; // >= 1 after validation; each needs xi and yi (zi optional)
  variables: { idx: number; type: VarType }[];
}

// The proposed role for one column, shown (and editable) in the assignment modal.
export type InspectRole =
  | { kind: 'id' }
  | { kind: 'coord'; map: number; axis: 'x' | 'y' | 'z' }
  | { kind: 'grad' }
  | { kind: 'cat' }
  | { kind: 'ignore' };

export interface ColumnInspect {
  idx: number; // file column index
  name: string; // display name (legacy token stripped)
  numeric: boolean; // every sampled non-missing value parses as a number
  distinct: number; // approx distinct count (scan capped at 2000, then reported as 2001)
  samples: string[]; // a few example values, for the modal
  role: InspectRole; // the proposed role
}

export interface TableInspect {
  delimiter: Delimiter;
  rowCount: number; // approx DATA-row count (drives the cap prompt)
  columns: ColumnInspect[];
  maps: number; // how many coordinate maps the proposal uses (0..4)
}

const INSPECT_SAMPLE = 4000; // rows scanned to infer numeric / distinct / examples
const UMAP_X = ['umap_1', 'umap1', 'umap_x', 'umapx', 'umap-1', 'umap.1', 'x_umap', 'x_umap0', 'xumap0'];
const UMAP_Y = ['umap_2', 'umap2', 'umap_y', 'umapy', 'umap-2', 'umap.2', 'y_umap', 'x_umap1', 'xumap1'];
const UMAP_Z = ['umap_3', 'umap3', 'umap_z', 'umap-3', 'umap.3'];

// Inspect a raw table: strip any legacy type tokens from the header, sample the
// values to tell numeric from categorical, and PROPOSE a structure (id, coordinate
// maps by name, a type per column). The modal seeds its editable state from this.
export function inspectTable(text: string, source = 'points table', delimHint?: Delimiter): TableInspect {
  const delim = delimHint ?? detectDelimiter(text, source);
  const all = parseDelimited(text, delim);
  if (all.length < 2) throw new Error('Points table has no data rows (need a header row and at least one point).');
  const twoRow = isTwoRowHeader(all);
  const header = all[0].map((h) => splitType((h ?? '').trim()).name); // drop any legacy __token
  const rows = all.slice(twoRow ? 2 : 1);
  const lower = header.map(norm);
  const nCols = header.length;

  const firstIdx = new Map<string, number>();
  lower.forEach((l, i) => {
    if (l && !firstIdx.has(l)) firstIdx.set(l, i);
  });
  const find = (names: string[]): number => {
    for (const nm of names) {
      const i = firstIdx.get(nm);
      if (i !== undefined) return i;
    }
    return -1;
  };

  // Per-column value inspection over a sample of the rows.
  const numeric = new Array<boolean>(nCols).fill(true);
  const saw = new Array<number>(nCols).fill(0);
  const distinctSets: (Set<string> | null)[] = header.map(() => new Set<string>());
  const samples: string[][] = header.map(() => []);
  const cap = Math.min(rows.length, INSPECT_SAMPLE);
  for (let r = 0; r < cap; r++) {
    const row = rows[r];
    for (let c = 0; c < nCols; c++) {
      const raw = (row[c] ?? '').trim();
      if (isMissing(raw)) continue;
      saw[c]++;
      if (numeric[c] && !Number.isFinite(toNum(raw))) numeric[c] = false;
      const ds = distinctSets[c];
      if (ds) {
        if (ds.size <= 2000) ds.add(raw);
        else distinctSets[c] = null;
      }
      if (samples[c].length < 3 && !samples[c].includes(raw)) samples[c].push(raw);
    }
  }
  const isNumeric = (c: number) => saw[c] > 0 && numeric[c];
  const distinctOf = (c: number) => (distinctSets[c] ? (distinctSets[c] as Set<string>).size : 2001);

  const usedCoord = new Set<number>();
  const roles: InspectRole[] = header.map(() => ({ kind: 'ignore' }));

  // Coordinate maps by name: spatial x/y(/z) -> map 0; a UMAP pair -> the next map.
  let mapCount = 0;
  const sx = find(RAW_X);
  const sy = find(RAW_Y);
  if (sx >= 0 && sy >= 0 && sx !== sy) {
    roles[sx] = { kind: 'coord', map: 0, axis: 'x' };
    roles[sy] = { kind: 'coord', map: 0, axis: 'y' };
    usedCoord.add(sx);
    usedCoord.add(sy);
    const sz = find(RAW_Z);
    if (sz >= 0 && !usedCoord.has(sz)) {
      roles[sz] = { kind: 'coord', map: 0, axis: 'z' };
      usedCoord.add(sz);
    }
    mapCount = 1;
  }
  const ux = find(UMAP_X);
  const uy = find(UMAP_Y);
  if (ux >= 0 && uy >= 0 && ux !== uy && !usedCoord.has(ux) && !usedCoord.has(uy)) {
    const m = mapCount;
    roles[ux] = { kind: 'coord', map: m, axis: 'x' };
    roles[uy] = { kind: 'coord', map: m, axis: 'y' };
    usedCoord.add(ux);
    usedCoord.add(uy);
    const uz = find(UMAP_Z);
    if (uz >= 0 && !usedCoord.has(uz)) {
      roles[uz] = { kind: 'coord', map: m, axis: 'z' };
      usedCoord.add(uz);
    }
    mapCount = m + 1;
  }

  // Id column: by name, then an unnamed leading column, then a value-unique fallback.
  let idIdx = find(RAW_ID);
  if (idIdx >= 0 && usedCoord.has(idIdx)) idIdx = -1;
  if (idIdx < 0 && (header[0] ?? '') === '' && !usedCoord.has(0)) idIdx = 0;
  if (idIdx < 0) idIdx = detectUniqueColumn(rows, nCols, usedCoord);
  if (idIdx >= 0) roles[idIdx] = { kind: 'id' };

  // Everything else: numeric -> numerical, otherwise categorical.
  for (let c = 0; c < nCols; c++) {
    if (usedCoord.has(c) || c === idIdx || !header[c]) continue;
    roles[c] = isNumeric(c) ? { kind: 'grad' } : { kind: 'cat' };
  }

  const columns: ColumnInspect[] = header.map((name, idx) => ({
    idx,
    name: name || `column ${idx + 1}`,
    numeric: isNumeric(idx),
    distinct: distinctOf(idx),
    samples: samples[idx],
    role: roles[idx],
  }));
  return { delimiter: delim, rowCount: Math.max(0, countDataLines(text) - (twoRow ? 1 : 0)), columns, maps: mapCount };
}

// Seed an editable Assignment from an inspection proposal (the modal's starting state).
export function assignmentFromInspect(ins: TableInspect): Assignment {
  const header = ins.columns.map((c) => c.name);
  const mapsByIdx = new Map<number, MapAssign>();
  const variables: { idx: number; type: VarType }[] = [];
  let idIdx = -1;
  for (const c of ins.columns) {
    const r = c.role;
    if (r.kind === 'id') idIdx = c.idx;
    else if (r.kind === 'coord') {
      let m = mapsByIdx.get(r.map);
      if (!m) {
        m = { index: r.map, xi: -1, yi: -1, zi: -1 };
        mapsByIdx.set(r.map, m);
      }
      if (r.axis === 'x') m.xi = c.idx;
      else if (r.axis === 'y') m.yi = c.idx;
      else m.zi = c.idx;
    } else if (r.kind === 'grad' || r.kind === 'cat') {
      variables.push({ idx: c.idx, type: r.kind });
    }
  }
  const maps = [...mapsByIdx.values()].sort((a, b) => a.index - b.index);
  return { delimiter: ins.delimiter, header, idIdx, maps, variables };
}

// Turn raw text + a confirmed Assignment into the shared PointsTableResult (which
// buildDataset then consumes). No notation is read here — the Assignment is the sole
// authority. Coordinate maps are re-indexed densely from the user's map order so the
// FIRST assigned map is the main viewer's map 0.
export function buildTableFromAssignment(text: string, a: Assignment, source = 'points table', cap?: CapOption): PointsTableResult {
  const all = parseDelimited(text, a.delimiter);
  const warnings: string[] = [];
  if (all.length < 2) throw new Error('Points table has no data rows.');
  let rows = all.slice(isTwoRowHeader(all) ? 2 : 1);
  if (cap && cap.max > 0 && rows.length > cap.max) {
    const before = rows.length;
    rows = sampleRows(rows, cap.max, cap.method);
    warnings.push(
      `Loaded ${cap.max.toLocaleString()} of ${before.toLocaleString()} cells — ${cap.method === 'head' ? `first ${cap.max.toLocaleString()} (hard cut-off)` : 'uniform random subsample'}.`,
    );
  }
  const header = a.header;
  const name = (i: number, fb: string) => (i >= 0 ? header[i] || fb : fb);

  const coordMaps: RawMapResolved[] = [];
  const valid = a.maps.filter((m) => m.xi >= 0 && m.yi >= 0).sort((x, y) => x.index - y.index);
  valid.forEach((m, i) => {
    coordMaps.push({
      index: i,
      xi: m.xi,
      yi: m.yi,
      zi: m.zi >= 0 ? m.zi : -1,
      xName: name(m.xi, `x${i}`),
      yName: name(m.yi, `y${i}`),
      zName: name(m.zi, `z${i}`),
    });
  });
  if (!coordMaps.length) throw new Error('Assign at least one coordinate map (an X and a Y column) before loading.');

  const used = new Set<number>();
  if (a.idIdx >= 0) used.add(a.idIdx);
  for (const m of coordMaps) {
    used.add(m.xi);
    used.add(m.yi);
    if (m.zi >= 0) used.add(m.zi);
  }

  // Optional outline polygon column, auto-detected by name among unassigned columns.
  let outlineIdx = -1;
  for (let i = 0; i < header.length; i++) {
    if (used.has(i)) continue;
    const l = norm(header[i]);
    if (l === 'outline' || l === 'polygon' || l === 'boundary') {
      outlineIdx = i;
      used.add(i);
      break;
    }
  }

  const scalarCols: ScalarCol[] = [];
  for (const v of a.variables) {
    if (v.idx < 0 || v.idx >= header.length || used.has(v.idx)) continue;
    used.add(v.idx);
    scalarCols.push({
      key: header[v.idx] || `column ${v.idx + 1}`,
      idx: v.idx,
      kind: v.type === 'grad' ? 'continuous' : 'categorical',
      identifier: false,
      suggestedType: v.type,
      declared: true, // the user assigned it — authoritative, so no "inferred" warning
    });
  }

  return assembleTable(rows, { idIdx: a.idIdx, coordMaps, outlineIdx, ranked: [], scalarCols, inferred: [] }, source, warnings);
}

// ---------------------------------------------------------------------------
// Raw / untagged table import — detect id + coordinate columns by NAME (with a
// value-based id fallback) and infer every other column's type from its values.
// This is what lets a raw metadata export (MERFISH, AnnData `obs`, …) load with no
// hand-editing: the app then pops a dialog to confirm/adjust the inferred types.
// It resolves to the SAME ResolvedTable the typed path uses, so once loaded the
// dataset behaves identically.
// ---------------------------------------------------------------------------

// Column-name synonyms recognised for each coordinate axis (case-insensitive). The
// spatial x/y(/z) triple becomes map 0; a UMAP pair (if present) becomes map 1.
const RAW_X = ['x', 'center_x', 'centre_x', 'x_centroid', 'centroid_x', 'x_center', 'x_centre', 'global_x', 'x_global', 'x_ccf', 'ccf_x', 'x_reconstructed', 'x_um', 'x_micron', 'x_microns', 'pos_x', 'x_position', 'spatial_x', 'x_spatial', 'x_coord', 'xcoord', 'x_pixel'];
const RAW_Y = ['y', 'center_y', 'centre_y', 'y_centroid', 'centroid_y', 'y_center', 'y_centre', 'global_y', 'y_global', 'y_ccf', 'ccf_y', 'y_reconstructed', 'y_um', 'y_micron', 'y_microns', 'pos_y', 'y_position', 'spatial_y', 'y_spatial', 'y_coord', 'ycoord', 'y_pixel'];
const RAW_Z = ['z', 'center_z', 'centre_z', 'z_centroid', 'centroid_z', 'z_center', 'z_centre', 'global_z', 'z_global', 'z_ccf', 'ccf_z', 'z_reconstructed', 'z_um', 'z_micron', 'z_microns', 'pos_z', 'z_position', 'spatial_z', 'z_spatial', 'z_coord', 'zcoord'];
const RAW_ID = ['id', 'cell_id', 'cellid', 'cell_label', 'celllabel', 'cell', 'cell_name', 'barcode', 'cell_barcode', 'cellbarcode', 'point_id', 'pointid', 'point', 'name', 'sample_id', 'spot_id', 'spot', 'index', '_index', 'unnamed: 0', 'unnamed:0'];

function parseRawTable(
  header: string[],
  typeOf: (HeaderType | undefined)[],
  rows: string[][],
  source: string,
  warnings: string[],
): PointsTableResult {
  const lower = header.map((h) => norm(h));
  const firstIdx = new Map<string, number>();
  lower.forEach((l, i) => {
    if (l !== '' && !firstIdx.has(l)) firstIdx.set(l, i);
  });
  const findName = (names: string[]): number => {
    for (const nm of names) {
      const i = firstIdx.get(nm);
      if (i !== undefined) return i;
    }
    return -1;
  };

  // Coordinate maps: a spatial x/y(/z) map, then an optional UMAP map.
  const usedCoord = new Set<number>();
  const coordMaps: RawMapResolved[] = [];
  const addMap = (xi: number, yi: number, zi: number, fb: [string, string, string]) => {
    coordMaps.push({
      index: coordMaps.length,
      xi,
      yi,
      zi,
      xName: header[xi] || fb[0],
      yName: header[yi] || fb[1],
      zName: zi >= 0 ? header[zi] || fb[2] : fb[2],
    });
    usedCoord.add(xi);
    usedCoord.add(yi);
    if (zi >= 0) usedCoord.add(zi);
  };
  const sx = findName(RAW_X);
  const sy = findName(RAW_Y);
  if (sx >= 0 && sy >= 0) addMap(sx, sy, findName(RAW_Z), ['x', 'y', 'z']);
  // UMAP pair → its own 2-D map. The x/y token sets are kept mutually exclusive so
  // they can never resolve to the same column; `x_umap0`/`x_umap1` covers scanpy's
  // 0-indexed obsm export, the rest cover the common 1-indexed / suffixed spellings.
  const ux = findName(['umap_1', 'umap1', 'umap_x', 'umapx', 'umap-1', 'umap.1', 'x_umap', 'x_umap0', 'xumap0']);
  const uy = findName(['umap_2', 'umap2', 'umap_y', 'umapy', 'umap-2', 'umap.2', 'y_umap', 'x_umap1', 'xumap1']);
  const uz = findName(['umap_3', 'umap3', 'umap_z', 'umap-3', 'umap.3']);
  if (ux >= 0 && uy >= 0 && ux !== uy) addMap(ux, uy, uz !== ux && uz !== uy ? uz : -1, ['umap 1', 'umap 2', 'umap 3']);

  if (!coordMaps.length) {
    throw new Error(
      'No coordinate columns found. Name them x and y (optionally z) — or center_x/center_y, or umap_1/umap_2 — or tag them in the header (spatial_x__x0, spatial_y__y0).',
    );
  }

  // Id column: by name, then an unnamed leading index column, then a value-based
  // near-unique fallback, else synthesize ids from the row number.
  let idIdx = findName(RAW_ID);
  if (idIdx < 0 && (header[0] ?? '').trim() === '' && !usedCoord.has(0)) idIdx = 0;
  if (idIdx >= 0 && usedCoord.has(idIdx)) idIdx = -1; // never let a coordinate double as the id
  if (idIdx < 0) idIdx = detectUniqueColumn(rows, header.length, usedCoord);
  const synthesizedId = idIdx < 0;

  // Every remaining column is a scalar variable; infer its type from the values,
  // honouring any explicit `__grad`/`__cat`/`__id` tag that happens to be present.
  const scalarCols: ScalarCol[] = [];
  const inferred: { key: string; type: DeclaredType }[] = [];
  for (let i = 0; i < header.length; i++) {
    if (i === idIdx || usedCoord.has(i) || !header[i]) continue;
    const tok = typeOf[i];
    let kind: 'continuous' | 'categorical';
    let identifier = false;
    let suggestedType: DeclaredType;
    let declared = false;
    if (tok === 'grad') {
      kind = 'continuous';
      suggestedType = 'grad';
      declared = true;
    } else if (tok === 'id') {
      kind = 'categorical';
      identifier = true;
      suggestedType = 'id';
      declared = true;
    } else if (tok === 'cat') {
      kind = 'categorical';
      suggestedType = 'cat';
      declared = true;
    } else {
      const t = inferColumnType(rows, i); // ranked tags (rare here) fall through to value inference
      suggestedType = t;
      kind = t === 'grad' ? 'continuous' : 'categorical';
      identifier = t === 'id';
      inferred.push({ key: header[i], type: t });
    }
    scalarCols.push({ key: header[i], idx: i, kind, identifier, suggestedType, declared });
  }

  const resolved: ResolvedTable = { idIdx, coordMaps, outlineIdx: -1, ranked: [], scalarCols, inferred };
  const res = assembleTable(rows, resolved, source, warnings);
  const coordColumns = coordMaps.flatMap((m) => (m.zi >= 0 ? [m.xName, m.yName, m.zName] : [m.xName, m.yName]));
  res.rawImport = { idColumn: idIdx >= 0 ? header[idIdx] || null : null, synthesizedId, coordColumns };
  const idDesc = synthesizedId ? 'row numbers (no id column found)' : `"${header[idIdx]}"`;
  warnings.unshift(
    `Raw table detected — id: ${idDesc}; coordinates: ${coordColumns.join(', ')}. ${inferred.length} column type(s) inferred; confirm them in the dialog.`,
  );
  return res;
}

// Value-based id fallback: the leftmost non-coordinate column that is present on
// ~every row and (near-)unique across a sample. Returns -1 when none qualifies.
function detectUniqueColumn(rows: string[][], nCols: number, exclude: Set<number>): number {
  const SAMPLE = Math.min(rows.length, 20000);
  if (SAMPLE < 8) return -1;
  for (let c = 0; c < nCols; c++) {
    if (exclude.has(c)) continue;
    const seen = new Set<string>();
    let nonMissing = 0;
    for (let r = 0; r < SAMPLE; r++) {
      const v = (rows[r][c] ?? '').trim();
      if (v === '' || isMissing(v)) continue;
      nonMissing++;
      seen.add(v);
    }
    if (nonMissing < SAMPLE * 0.9) continue; // an id is present on nearly every row
    if (seen.size / Math.max(1, nonMissing) >= 0.98) return c; // leftmost near-unique wins
  }
  return -1;
}

// Infer a column's type from its values: all-numeric → gradient; otherwise a string
// column that is (near-)unique or has thousands of distinct values → identifier,
// else a category. (Scans up to 50k rows — enough to classify a huge file cheaply.)
function inferColumnType(rows: string[][], idx: number): DeclaredType {
  const cap = Math.min(rows.length, 50000);
  let numeric = true;
  let saw = 0;
  const distinct = new Set<string>();
  let capped = false;
  for (let r = 0; r < cap; r++) {
    const raw = rows[r][idx] ?? '';
    if (isMissing(raw)) continue;
    saw++;
    if (numeric && !Number.isFinite(toNum(raw))) numeric = false;
    if (!capped) {
      distinct.add(raw.trim());
      if (distinct.size > 2000) capped = true;
    }
  }
  if (saw === 0) return 'cat';
  if (numeric) return 'grad';
  if (capped) return 'id'; // > 2000 distinct strings → an identifier
  if (saw >= 50 && distinct.size >= 0.9 * saw) return 'id'; // essentially unique per row
  return 'cat';
}

// ---------------------------------------------------------------------------
// Shared assembly — turn the resolved header roles + data rows into the final
// points, variable registry and dataset meta. Called by BOTH header formats.
// ---------------------------------------------------------------------------

// One point's ranked calls from a single row (label + confidence + extra fields).
function buildCalls(r: string[], rv: RankedVar): { label: string; confidence?: number; [k: string]: unknown }[] {
  const calls: { label: string; confidence?: number; [k: string]: unknown }[] = [];
  for (const rk of rv.ranks) {
    if (rk.labelIdx < 0) continue;
    const lab = (r[rk.labelIdx] ?? '').trim();
    if (!lab || isMissing(lab)) continue;
    const call: { label: string; confidence?: number; [k: string]: unknown } = { label: lab };
    if (rk.confIdx >= 0) {
      let c = toNum(r[rk.confIdx] ?? '');
      if (Number.isFinite(c)) {
        if (rv.confPercent) c /= 100;
        call.confidence = c;
      }
    }
    for (const ex of rk.extras) {
      const raw = (r[ex.idx] ?? '').trim();
      if (!isMissing(raw)) {
        const nn = toNum(raw);
        call[ex.field] = Number.isFinite(nn) ? nn : raw;
      }
    }
    calls.push(call);
  }
  return calls;
}

// Variable registry in column order (ranked then scalar), matching the spreadsheet.
function buildVariables(ranked: RankedVar[], scalarCols: ScalarCol[]): VariableDef[] {
  const defByOrder: { order: number; def: VariableDef }[] = [];
  for (const rv of ranked) {
    defByOrder.push({
      order: rv.ranks[0].labelIdx,
      def: { key: rv.key, label: rv.key, kind: 'ranked', suggestedType: 'ranked', typeDeclared: rv.declared },
    });
  }
  for (const sc of scalarCols) {
    defByOrder.push({
      order: sc.idx,
      def: {
        key: sc.key,
        label: sc.key,
        kind: sc.kind,
        identifier: sc.identifier || undefined,
        suggestedType: sc.suggestedType,
        typeDeclared: sc.declared,
      },
    });
  }
  defByOrder.sort((a, b) => a.order - b.order);
  return defByOrder.map((d) => d.def);
}

// Default colour axis, by type/order only: first ranked, else a gradient, else a
// non-identifier category. Identifiers are never a sensible colour axis.
function defaultColorByOf(ranked: RankedVar[], scalarCols: ScalarCol[]): string | undefined {
  return (
    ranked[0]?.key ??
    scalarCols.find((s) => s.kind === 'continuous')?.key ??
    scalarCols.find((s) => s.kind === 'categorical' && !s.identifier)?.key
  );
}

function tableMeta(source: string, defaultColorBy: string | undefined): DatasetMeta {
  const name = baseName(source)
    .replace(/\.(points|point|points|data)\.(c|t)sv$/i, '')
    .replace(/\.(c|t)sv$/i, '');
  return { name: name || 'data table', default_color_by: defaultColorBy };
}

function pushInferredWarning(inferred: { key: string; type: DeclaredType }[], warnings: string[]): void {
  if (!inferred.length) return;
  const shown = inferred.map((c) => `${c.key} (${c.type})`).slice(0, 8).join(', ');
  warnings.push(
    `${inferred.length} column(s) had no type tag and were inferred: ${shown}${inferred.length > 8 ? ', …' : ''}. Tag them like name__grad / name__cat / name__id / name__ranked (or add a two-row type header) to be explicit.`,
  );
}

function assembleTable(
  rows: string[][],
  resolved: ResolvedTable,
  source: string,
  warnings: string[],
): PointsTableResult {
  const { idIdx, coordMaps, outlineIdx, ranked, scalarCols, inferred } = resolved;

  const maps: CoordMapDef[] = coordMaps.map((m) => ({
    index: m.index,
    axes: m.zi >= 0 ? [m.xName, m.yName, m.zName] : [m.xName, m.yName],
  }));

  // Build points. A raw import with no id column (idIdx < 0) synthesizes stable
  // ids from the row number; the typed/two-row paths always pass a real idIdx.
  const points: PointRecord[] = [];
  let skipped = 0;
  let ri = -1;
  for (const r of rows) {
    ri++;
    const id = idIdx >= 0 ? (r[idIdx] ?? '').trim() : `row_${ri}`;
    if (!id) {
      skipped++;
      continue;
    }
    const coords: PointRecord['coords'] = [];
    let placed = false;
    for (const m of coordMaps) {
      const x = toNum(r[m.xi] ?? '');
      const y = toNum(r[m.yi] ?? '');
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue; // point absent from this map
      if (m.zi >= 0) {
        const z = toNum(r[m.zi] ?? '');
        coords[m.index] = [x, y, Number.isFinite(z) ? z : 0];
      } else {
        coords[m.index] = [x, y];
      }
      placed = true;
    }
    if (!placed) {
      skipped++;
      continue;
    }
    const rec: PointRecord = { id, coords };

    if (outlineIdx >= 0) {
      const o = parseOutline(r[outlineIdx] ?? '');
      if (o) rec.outline = o;
    }

    for (const rv of ranked) {
      const calls = buildCalls(r, rv);
      if (calls.length) (rec.classes ??= {})[rv.key] = calls;
    }

    for (const sc of scalarCols) {
      const raw = (r[sc.idx] ?? '').trim();
      if (isMissing(raw)) continue;
      if (sc.kind === 'continuous') {
        const nn = toNum(raw);
        if (Number.isFinite(nn)) (rec.values ??= {})[sc.key] = nn;
      } else {
        (rec.values ??= {})[sc.key] = raw;
      }
    }
    points.push(rec);
  }
  if (skipped) warnings.push(`${skipped} row(s) skipped: missing id or no valid coordinates.`);
  if (!points.length) throw new Error('No valid rows (each needs an id and coordinates in at least one map).');

  const variables = buildVariables(ranked, scalarCols);
  pushInferredWarning(inferred, warnings);
  const meta = tableMeta(source, defaultColorByOf(ranked, scalarCols));
  return { meta, variables, maps, points, warnings, inferred };
}

// ---------------------------------------------------------------------------
// Two-row header (names row + type-token row)
// ---------------------------------------------------------------------------

// Detect the two-row header shape: no `name__token` tag in row 1 (that would be
// the legacy single-row format), and row 2 is a type row carrying at least an
// `id`, an `x` and a `y` token — the minimum for a points table.
function isTwoRowHeader(all: string[][]): boolean {
  if (all.length < 3) return false; // two header rows + at least one data row
  const row0 = all[0].map((s) => (s ?? '').trim());
  if (row0.some((h) => TYPE_RE.test(h))) return false;
  const t = all[1].map((s) => (s ?? '').trim().toLowerCase());
  return t.includes('id') && t.includes('x') && t.includes('y');
}

// Split a ranked-family token into its role + candidate index: trailing digits
// are the candidate number (default 1), the rest is the role — `ranked` (label),
// `conf` (confidence), or any other word (a per-candidate extra field, e.g.
// `reads`). So `ranked2` -> {ranked, 2}, `conf` -> {conf, 1}, `reads2` -> {reads, 2}.
function parseRankToken(token: string): { role: string; idx: number } | null {
  if (!token) return null;
  const dm = /(\d+)$/.exec(token);
  const idx = dm ? parseInt(dm[1], 10) : 1;
  const role = dm ? token.slice(0, dm.index) : token;
  if (!role) return null;
  return { role, idx };
}

// Resolve a two-row header into the shared ResolvedTable, then assemble. Columns
// that share a NAME (row 1) form one variable / coordinate map; the type row
// (row 2) gives each column's role. Multi-frame (`frame`/long format) is
// recognised but not yet rendered — only the first row per id is kept.
function parseTwoRowTable(all: string[][], source: string, warnings: string[]): PointsTableResult {
  const names = all[0].map((h) => (h ?? '').trim());
  const types = all[1].map((h) => (h ?? '').trim().toLowerCase());
  const rows = all.slice(2);
  const nCols = names.length;

  const idCols: number[] = [];
  for (let i = 0; i < nCols; i++) if (types[i] === 'id') idCols.push(i);
  if (!idCols.length) throw new Error('Two-row header needs an `id` type column in the second row.');
  const idIdx = idCols[0];

  // A `frame` (or t/time/step) column marks the long / multi-frame format: one row
  // per point per frame, assembled into per-point position tracks (see below). The
  // token also picks the time axis: `time`/`t` = continuous, `frame`/`step` = discrete.
  const frameIdx = types.findIndex((t) => t === 'frame' || t === 't' || t === 'time' || t === 'step');
  const continuousTime = frameIdx >= 0 && (types[frameIdx] === 'time' || types[frameIdx] === 't');

  const used = new Set<number>();
  used.add(idIdx);
  if (frameIdx >= 0) used.add(frameIdx);

  let outlineIdx = -1;
  for (let i = 0; i < nCols; i++) {
    if (types[i] === 'outline') {
      outlineIdx = i;
      used.add(i);
      break;
    }
  }

  // Coordinate maps: x/y/z columns grouped by name, indexed by first appearance.
  interface TwoMap {
    name: string;
    xi: number;
    yi: number;
    zi: number;
  }
  const mapByName = new Map<string, TwoMap>();
  const mapOrder: string[] = [];
  for (let i = 0; i < nCols; i++) {
    const t = types[i];
    if (t !== 'x' && t !== 'y' && t !== 'z') continue;
    used.add(i);
    const key = names[i];
    let m = mapByName.get(key);
    if (!m) {
      m = { name: key, xi: -1, yi: -1, zi: -1 };
      mapByName.set(key, m);
      mapOrder.push(key);
    }
    if (t === 'x') m.xi = i;
    else if (t === 'y') m.yi = i;
    else m.zi = i;
  }
  const coordMaps: RawMapResolved[] = [];
  let mapIndex = 0;
  for (const key of mapOrder) {
    const m = mapByName.get(key) as TwoMap;
    if (m.xi >= 0 && m.yi >= 0) {
      coordMaps.push({
        index: mapIndex++,
        xi: m.xi,
        yi: m.yi,
        zi: m.zi,
        xName: `${m.name} x`,
        yName: `${m.name} y`,
        zName: `${m.name} z`,
      });
    } else {
      warnings.push(`Coordinate map "${m.name}" is missing its ${m.xi < 0 ? 'x' : 'y'} column and was ignored.`);
    }
  }
  if (!coordMaps.length) {
    throw new Error('Two-row header needs a coordinate map: an `x` and a `y` type column that share a name.');
  }

  // Ranked variables: any name carrying a `ranked` (or `ranked<r>`) token. All
  // columns of that name are its candidates' label / conf / extra fields.
  const rankedNames: string[] = [];
  const rankedSeen = new Set<string>();
  for (let i = 0; i < nCols; i++) {
    if (used.has(i)) continue;
    const p = parseRankToken(types[i]);
    if (p && p.role === 'ranked' && !rankedSeen.has(names[i])) {
      rankedSeen.add(names[i]);
      rankedNames.push(names[i]);
    }
  }
  const ranked: RankedVar[] = [];
  for (const rname of rankedNames) {
    const cand = new Map<number, RankSlot>();
    for (let i = 0; i < nCols; i++) {
      if (used.has(i) || names[i] !== rname) continue;
      const p = parseRankToken(types[i]);
      if (!p) continue;
      let slot = cand.get(p.idx);
      if (!slot) {
        slot = { labelIdx: -1, confIdx: -1, extras: [] };
        cand.set(p.idx, slot);
      }
      if (p.role === 'ranked') slot.labelIdx = i;
      else if (p.role === 'conf') slot.confIdx = i;
      else slot.extras.push({ field: p.role, idx: i });
      used.add(i);
    }
    const maxR = Math.max(...cand.keys());
    const ranks: RankSlot[] = [];
    for (let r = 1; r <= maxR; r++) ranks.push(cand.get(r) ?? { labelIdx: -1, confIdx: -1, extras: [] });
    if (!ranks.length || ranks[0].labelIdx < 0) continue;
    let maxConf = 0;
    for (const rk of ranks) {
      if (rk.confIdx < 0) continue;
      for (const r of rows) {
        const c = toNum(r[rk.confIdx] ?? '');
        if (Number.isFinite(c) && c > maxConf) maxConf = c;
      }
    }
    ranked.push({
      key: names[ranks[0].labelIdx],
      base: rname.toLowerCase(),
      ranks,
      confPercent: maxConf > 1.001,
      declared: true,
    });
  }

  // Remaining columns are scalar values (grad / cat / id-identifier) or inferred.
  const scalarCols: ScalarCol[] = [];
  const inferred: { key: string; type: DeclaredType }[] = [];
  for (let i = 0; i < nCols; i++) {
    if (used.has(i) || !names[i]) continue;
    const t = types[i];
    let kind: 'continuous' | 'categorical';
    let identifier = false;
    let suggestedType: DeclaredType;
    let declared = true;
    if (t === 'id') {
      kind = 'categorical';
      identifier = true;
      suggestedType = 'id';
    } else if (t === 'grad') {
      kind = 'continuous';
      suggestedType = 'grad';
    } else if (t === 'cat') {
      kind = 'categorical';
      suggestedType = 'cat';
    } else {
      let numeric = true;
      let saw = false;
      for (const r of rows) {
        const raw = r[i] ?? '';
        if (isMissing(raw)) continue;
        saw = true;
        if (!Number.isFinite(toNum(raw))) {
          numeric = false;
          break;
        }
      }
      kind = saw && numeric ? 'continuous' : 'categorical';
      suggestedType = kind === 'continuous' ? 'grad' : 'cat';
      declared = false;
      inferred.push({ key: names[i], type: suggestedType });
      if (t) warnings.push(`Unknown type token "${t}" on column "${names[i]}" — inferred ${suggestedType}.`);
    }
    scalarCols.push({ key: names[i], idx: i, kind, identifier, suggestedType, declared });
    used.add(i);
  }

  const resolved: ResolvedTable = { idIdx, coordMaps, outlineIdx, ranked, scalarCols, inferred };
  return frameIdx >= 0
    ? assembleLongFormat(rows, resolved, frameIdx, continuousTime, source, warnings)
    : assembleTable(rows, resolved, source, warnings);
}

// ---------------------------------------------------------------------------
// Long-format assembly — one row per point PER FRAME. Rows grouped by id build a
// per-point position track over the dataset's frames. Frame semantics (Ian's
// choices): frames are discrete step indices (no interpolation); a point with NO
// row at a frame is HIDDEN there; a blank cell CARRIES FORWARD the last frame's
// value (any column, incl. coordinates); an explicit NA/nan means genuinely
// MISSING at that frame. Phase A animates POSITION; scalar/ranked values are the
// point's first-seen (carried) value — per-frame value animation is Phase B.
// ---------------------------------------------------------------------------

function assembleLongFormat(
  rows: string[][],
  resolved: ResolvedTable,
  frameIdx: number,
  continuousTime: boolean,
  source: string,
  warnings: string[],
): PointsTableResult {
  const { idIdx, coordMaps, outlineIdx, ranked, scalarCols, inferred } = resolved;

  const maps: CoordMapDef[] = coordMaps.map((m) => ({
    index: m.index,
    axes: m.zi >= 0 ? [m.xName, m.yName, m.zName] : [m.xName, m.yName],
  }));

  // Global timeline: the sorted, distinct frame values across every row.
  const frameValSet = new Set<number>();
  for (const r of rows) {
    const f = toNum(r[frameIdx] ?? '');
    if (Number.isFinite(f)) frameValSet.add(f);
  }
  const frames = [...frameValSet].sort((a, b) => a - b);
  if (!frames.length) throw new Error('The frame column has no numeric values.');
  const frameIndexOf = new Map<number, number>();
  frames.forEach((v, i) => frameIndexOf.set(v, i));
  const F = frames.length;

  // Group rows by id, preserving first-appearance order for stable point order.
  const order: string[] = [];
  const byId = new Map<string, string[][]>();
  let looseRows = 0;
  for (const r of rows) {
    const id = (r[idIdx] ?? '').trim();
    if (!id) {
      looseRows++;
      continue;
    }
    let g = byId.get(id);
    if (!g) {
      g = [];
      byId.set(id, g);
      order.push(id);
    }
    g.push(r);
  }

  const points: PointRecord[] = [];
  let skipped = 0;
  for (const id of order) {
    const grp = byId.get(id) as string[][];

    // The point's row at each global frame index (last wins on a duplicate frame).
    const rowAt = new Array<string[] | undefined>(F);
    for (const r of grp) {
      const fi = frameIndexOf.get(toNum(r[frameIdx] ?? ''));
      if (fi !== undefined) rowAt[fi] = r;
    }

    // Per-map position track over all frames, with carry-forward + hide semantics.
    const track: (Coord | undefined)[][] = [];
    const coords: PointRecord['coords'] = [];
    let anyPlaced = false;
    for (const m of coordMaps) {
      const arr = new Array<Coord | undefined>(F);
      let last: Coord | undefined;
      for (let fi = 0; fi < F; fi++) {
        const r = rowAt[fi];
        if (!r) {
          // Continuous time HOLDS the last position across gaps — a point updates
          // only on a new value or an explicit missing mark. Discrete frames hide a
          // point that has no row that frame.
          arr[fi] = continuousTime && last ? ([...last] as Coord) : undefined;
          continue;
        }
        const xr = (r[m.xi] ?? '').trim();
        const yr = (r[m.yi] ?? '').trim();
        const xEmpty = xr === '';
        const yEmpty = yr === '';
        // Explicit NA/nan (not just blank) → genuinely missing this frame.
        if ((!xEmpty && isMissing(xr)) || (!yEmpty && isMissing(yr))) {
          arr[fi] = undefined;
          if (continuousTime) last = undefined; // a missing mark stops the hold until a new value
          continue;
        }
        // A blank coordinate carries the last known position forward.
        if (xEmpty || yEmpty) {
          arr[fi] = last ? ([...last] as Coord) : undefined;
          continue;
        }
        const x = toNum(xr);
        const y = toNum(yr);
        if (!Number.isFinite(x) || !Number.isFinite(y)) {
          arr[fi] = undefined;
          continue;
        }
        let coord: Coord;
        if (m.zi >= 0) {
          const zr = (r[m.zi] ?? '').trim();
          const z = zr === '' && last && last.length >= 3 ? (last[2] as number) : toNum(zr);
          coord = [x, y, Number.isFinite(z) ? z : 0];
        } else {
          coord = [x, y];
        }
        arr[fi] = coord;
        last = coord;
        anyPlaced = true;
      }
      track[m.index] = arr;
      coords[m.index] = arr.find((c) => c !== undefined); // default/frame-0 fallback
    }
    if (!anyPlaced) {
      skipped++;
      continue;
    }

    const rec: PointRecord = { id, coords, track };

    // Outline: from the first frame-row that has one.
    if (outlineIdx >= 0) {
      for (const r of grp) {
        const o = parseOutline(r[outlineIdx] ?? '');
        if (o) {
          rec.outline = o;
          break;
        }
      }
    }

    // Scalars / ranked (Phase A: static — the first non-missing value in frame
    // order, which is what carry-forward stabilises a static column to).
    const inFrameOrder = [...grp].sort((a, b) => toNum(a[frameIdx] ?? '') - toNum(b[frameIdx] ?? ''));
    for (const rv of ranked) {
      for (const r of inFrameOrder) {
        const calls = buildCalls(r, rv);
        if (calls.length) {
          (rec.classes ??= {})[rv.key] = calls;
          break;
        }
      }
    }
    for (const sc of scalarCols) {
      for (const r of inFrameOrder) {
        const raw = (r[sc.idx] ?? '').trim();
        if (isMissing(raw)) continue;
        if (sc.kind === 'continuous') {
          const nn = toNum(raw);
          if (Number.isFinite(nn)) {
            (rec.values ??= {})[sc.key] = nn;
            break;
          }
        } else {
          (rec.values ??= {})[sc.key] = raw;
          break;
        }
      }
    }
    points.push(rec);
  }

  if (skipped) warnings.push(`${skipped} point(s) skipped: no valid coordinates in any frame.`);
  if (looseRows) warnings.push(`${looseRows} row(s) skipped: missing id.`);
  if (!points.length) throw new Error('No valid points (each needs an id and coordinates in at least one frame).');

  const variables = buildVariables(ranked, scalarCols);
  pushInferredWarning(inferred, warnings);
  const meta = tableMeta(source, defaultColorByOf(ranked, scalarCols));
  warnings.push(`Loaded ${points.length} point(s) across ${F} frame(s).`);
  return { meta, variables, maps, points, warnings, inferred, frames, continuousTime };
}

// ---------------------------------------------------------------------------
// Images table
// ---------------------------------------------------------------------------

export interface ImagesTableResult {
  images: ImageLayer[];
  warnings: string[];
}

export function parseImagesTable(text: string, source = 'images table', delimHint?: Delimiter): ImagesTableResult {
  const delim = delimHint ?? detectDelimiter(text, source);
  const all = parseDelimited(text, delim);
  const warnings: string[] = [];
  if (all.length < 2) throw new Error('Images table has no data rows.');

  const header = all[0].map((h) => h.trim());
  const lower = header.map(norm);
  const rows = all.slice(1);
  const col = (...names: string[]): number => {
    for (const nm of names) {
      const i = lower.indexOf(nm);
      if (i >= 0) return i;
    }
    return -1;
  };

  const idIdx = col('image_id', 'image', 'img', 'id', 'layer');
  const labelIdx = col('label', 'title', 'name');
  const groupIdx = col('group', 'section');
  const zIdx = col('z', 'z_um', 'depth');
  const opIdx = col('opacity', 'alpha');
  const fxIdx = col('flip_x', 'flipx', 'mirror_x');
  const fyIdx = col('flip_y', 'flipy', 'mirror_y');
  const blendIdx = col('blend', 'blending', 'mode');
  const chIdx = col('channel', 'channel_name', 'ch');
  const colorIdx = col('color', 'colour', 'tint');
  const fileIdx = col('file', 'src', 'path', 'image_file', 'filename');
  const x0i = col('x0', 'xmin', 'x_min', 'left');
  const y0i = col('y0', 'ymin', 'y_min');
  const x1i = col('x1', 'xmax', 'x_max', 'right');
  const y1i = col('y1', 'ymax', 'y_max');
  const cxi = col('cx', 'center_x', 'centre_x', 'x_center', 'x');
  const cyi = col('cy', 'center_y', 'centre_y', 'y_center', 'y');
  const sizei = col('size', 'fov', 'side', 'extent_um');
  const wi = col('w', 'width');
  const hi = col('h', 'height');
  if (fileIdx < 0) throw new Error('Images table needs a "file" (or "src") column with each image location.');

  const at = (r: string[], i: number): string => (i >= 0 ? r[i] ?? '' : '');
  const num = (r: string[], i: number): number => toNum(at(r, i));
  const truthy = (s: string): boolean => /^(1|true|yes|y|t)$/i.test(s.trim());

  const groups = new Map<string, ImageLayer>();
  let skipped = 0;

  rows.forEach((r, ri) => {
    const file = at(r, fileIdx).trim();
    if (!file || isMissing(file)) {
      skipped++;
      return;
    }
    let extent: [number, number, number, number] | null = null;
    const x0 = num(r, x0i);
    const y0 = num(r, y0i);
    const x1 = num(r, x1i);
    const y1 = num(r, y1i);
    if ([x0, y0, x1, y1].every((v) => Number.isFinite(v))) {
      extent = [Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)];
    } else {
      const cx = num(r, cxi);
      const cy = num(r, cyi);
      const size = num(r, sizei);
      let w = num(r, wi);
      let h = num(r, hi);
      if (!Number.isFinite(w) && Number.isFinite(size)) w = size;
      if (!Number.isFinite(h) && Number.isFinite(size)) h = size;
      if (!Number.isFinite(h) && Number.isFinite(w)) h = w;
      if (Number.isFinite(cx) && Number.isFinite(cy) && Number.isFinite(w) && Number.isFinite(h)) {
        extent = [cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2];
      }
    }
    if (!extent) {
      skipped++;
      warnings.push(`image row ${ri + 2}: no usable extent (need x0..y1 or center + size).`);
      return;
    }

    const idRaw = at(r, idIdx).trim();
    const key = idRaw || file || `img_${ri}`;
    let layer = groups.get(key);
    if (!layer) {
      const blendRaw = at(r, blendIdx);
      layer = {
        id: key,
        label: at(r, labelIdx).trim() || idRaw || undefined,
        group: at(r, groupIdx).trim() || undefined,
        z: Number.isFinite(num(r, zIdx)) ? num(r, zIdx) : undefined,
        extent,
        opacity: Number.isFinite(num(r, opIdx)) ? num(r, opIdx) : undefined,
        flip: fxIdx >= 0 || fyIdx >= 0 ? [truthy(at(r, fxIdx)), truthy(at(r, fyIdx))] : undefined,
        blend: /norm/i.test(blendRaw) ? 'normal' : /add/i.test(blendRaw) ? 'additive' : undefined,
        channels: [],
      };
      groups.set(key, layer);
    }
    layer.channels.push({
      src: file,
      name: at(r, chIdx).trim() || undefined,
      color: at(r, colorIdx).trim() || undefined,
    });
  });

  const images = [...groups.values()].filter((l) => l.channels.length);
  if (skipped) warnings.push(`${skipped} image row(s) skipped.`);
  if (!images.length) throw new Error('No usable image layers in the images table.');
  return { images, warnings };
}

// Heuristic used to route a dropped/opened file: is this an images sheet?
export function looksLikeImagesTable(text: string, filename?: string): boolean {
  if ((filename ?? '').toLowerCase().includes('.images.')) return true;
  const first = parseDelimited(text, detectDelimiter(text, filename))[0];
  if (!first) return false;
  const l = first.map(norm);
  const hasFile = ['file', 'src', 'path', 'image_file', 'filename'].some((k) => l.includes(k));
  const hasExtent =
    ['x0', 'xmin', 'x_min', 'cx', 'center_x'].some((k) => l.includes(k)) || (l.includes('x') && l.includes('size'));
  return hasFile && hasExtent;
}

// Is this delimited text a POINTS table (has id + a coordinate map)? Routes opens.
export function looksLikePointsTable(text: string, filename?: string): boolean {
  const f = (filename ?? '').toLowerCase();
  if (f.endsWith('.csv') || f.endsWith('.tsv') || f.endsWith('.tab')) {
    const head = parseDelimited(text, detectDelimiter(text, filename));
    const first = head[0];
    if (!first) return false;
    const l = first.map(norm);
    const hasCoordMap = l.some((h) => /__[xy]\d+$/.test(h));
    // A plain header counts too: an id-ish column, OR literal x & y coordinate
    // columns (the raw-table importer detects the rest by name/value).
    if (hasCoordMap || l.includes('id') || l.includes('cell_id') || l.includes('cell_label') || l.includes('point_id')) return true;
    if (l.includes('x') && l.includes('y')) return true;
    // Two-row header: the SECOND row carries the type tokens (id + x + y).
    const second = head[1];
    if (second) {
      const t = second.map(norm);
      if (t.includes('id') && t.includes('x') && t.includes('y')) return true;
    }
  }
  return false;
}
