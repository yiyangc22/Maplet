// A ViewState is the full, serializable snapshot of everything the user can
// adjust (color, filters, selection, display settings). The command/undo system
// stores one ViewState per step; restoring a step just re-applies it. The
// dataset itself is immutable and lives outside ViewState.

import type { Dataset } from '../format/maplet';
import { hasCategoryOverflow } from '../format/maplet';
import type { Filter } from './derive';

export interface ViewerSettings {
  pointSize: number;
  pointOpacity: number;
  ghostMode: boolean;
  ghostOpacity: number;
  showAxes: boolean;
  showGrid: boolean;
  showImages: boolean;
  imageOpacity: number;
  hiddenImages: number[]; // indices of overlay layers currently hidden
  orthographic: boolean; // parallel projection (no perspective distortion) — accurate flattened export
  showTraces: boolean; // multi-frame: draw every VISIBLE point's path across frames
  labelAll: boolean; // draw a name label above every VISIBLE point
  showBlips: boolean; // multi-frame: flash a point once (radar ping) when its position updates
}

// What a viewport shows. The main viewer is always a coordinate map; a bottom
// panel can also show a 1-D numeric variable as a dot plot. Kept here (not in the
// store) so the panel layout can live inside a ViewState and be undoable.
export type PanelTarget = { kind: 'map'; index: number } | { kind: 'hist'; key: string };
export interface LayoutState {
  mainMap: number;
  panels: PanelTarget[];
}

export interface SerialContinuousFilter {
  kind: 'continuous';
  min: number;
  max: number;
  includeMissing: boolean;
}
export interface SerialCategoricalFilter {
  kind: 'categorical';
  disabled: string[]; // values ticked OFF (empty = all pass)
  includeMissing: boolean;
}
export interface SerialRankedFilter {
  kind: 'ranked';
  enabledTop: number[];
  minConf: number;
  includeMissing: boolean;
}
export type SerialFilter = SerialContinuousFilter | SerialCategoricalFilter | SerialRankedFilter;

export interface ViewState {
  colorKey: string | null;
  sizeKey: string | null; // "size by" a numeric variable (null = uniform)
  sizeDomain: [number, number] | null; // value range mapped to [min,max] dot size (floors/ceils outside)
  rankedMode: 'label' | 'confidence';
  colormaps: Record<string, string>; // per-variable colormap override
  domains: Record<string, [number, number]>; // per-variable color-range override
  filters: Record<string, SerialFilter>;
  selection: number[];
  primary: number | null;
  labeledPoints: number[]; // points with a persistent name label (independent of selection)
  tracedPoints: number[]; // points with a persistent highlighted trace (independent of selection)
  settings: ViewerSettings;
  layout?: LayoutState; // which map/variable each viewport shows (undoable panel layout)
}

export function defaultSettings(ds: Dataset): ViewerSettings {
  return {
    pointSize: ds.meta.default_point_size ?? 1,
    pointOpacity: 0.95,
    ghostMode: true,
    ghostOpacity: 0.05,
    showAxes: true,
    showGrid: true,
    showImages: true,
    imageOpacity: 0.5,
    hiddenImages: [],
    orthographic: false,
    showTraces: false,
    labelAll: false,
    showBlips: false,
  };
}

/**
 * Ranked variables with more distinct labels than the palette can show (e.g.
 * thousands of unique spatial barcodes) are coloured by confidence, not by top
 * label — a per-barcode colour would be noise.
 */
export function pickDefaultRankedMode(ds: Dataset, colorKey: string | null): 'label' | 'confidence' {
  const col = colorKey ? ds.columnByKey.get(colorKey) : undefined;
  return col && col.kind === 'ranked' && hasCategoryOverflow(col) ? 'confidence' : 'label';
}

export function pickDefaultColorKey(ds: Dataset): string | null {
  const want = ds.meta.default_color_by;
  if (want && ds.columnByKey.has(want)) return want;
  // Purely by type/order — no name-based preference. First ranked call, else a
  // real category, else a gradient (identifiers are never a colour axis).
  return (
    ds.columns.find((c) => c.kind === 'ranked')?.key ??
    ds.columns.find((c) => c.kind === 'categorical' && !c.isIdentifier)?.key ??
    ds.columns.find((c) => c.kind === 'continuous')?.key ??
    null
  );
}

export function defaultViewState(ds: Dataset): ViewState {
  const colorKey = pickDefaultColorKey(ds);
  return {
    colorKey,
    sizeKey: null,
    sizeDomain: null,
    rankedMode: pickDefaultRankedMode(ds, colorKey),
    colormaps: {},
    domains: {},
    filters: {},
    selection: [],
    primary: null,
    labeledPoints: [],
    tracedPoints: [],
    settings: defaultSettings(ds),
  };
}

// ---- runtime <-> serial filter conversions --------------------------------

export function toSerialFilter(f: Filter): SerialFilter {
  if (f.kind === 'continuous') return { kind: 'continuous', min: f.min, max: f.max, includeMissing: f.includeMissing };
  // Sort the disabled list so equal filters serialize identically (stable undo compare).
  if (f.kind === 'categorical') return { kind: 'categorical', disabled: [...f.disabled].sort(), includeMissing: f.includeMissing };
  return { kind: 'ranked', enabledTop: [...f.enabledTop], minConf: f.minConf, includeMissing: f.includeMissing };
}

export function fromSerialFilter(f: SerialFilter): Filter {
  if (f.kind === 'continuous') return { kind: 'continuous', min: f.min, max: f.max, includeMissing: f.includeMissing };
  if (f.kind === 'categorical') return { kind: 'categorical', disabled: new Set(f.disabled), includeMissing: f.includeMissing };
  return { kind: 'ranked', enabledTop: new Set(f.enabledTop), minConf: f.minConf, includeMissing: f.includeMissing };
}

export function filtersToSerial(filters: Map<string, Filter>): Record<string, SerialFilter> {
  const out: Record<string, SerialFilter> = {};
  for (const [k, f] of filters) out[k] = toSerialFilter(f);
  return out;
}

export function filtersFromSerial(rec: Record<string, SerialFilter>): Map<string, Filter> {
  const out = new Map<string, Filter>();
  for (const k of Object.keys(rec)) out.set(k, fromSerialFilter(rec[k]));
  return out;
}

// ---- no-op detection -------------------------------------------------------

const numArrEq = (a: number[], b: number[]): boolean => a.length === b.length && a.every((v, i) => v === b[i]);
const pairEq = (a: [number, number] | null, b: [number, number] | null): boolean =>
  a === b || (!!a && !!b && a[0] === b[0] && a[1] === b[1]);

// True when two ViewStates are visually identical, so a command that produced no
// real change (deselect when nothing is selected, snap to the current plane, …)
// can be dropped instead of adding a dead step to the edit history / undo stack.
// Large arrays (selection) are compared directly and short-circuit; the small
// record/object fields fall back to JSON.
export function viewStatesEqual(a: ViewState, b: ViewState): boolean {
  if (a === b) return true;
  if (a.colorKey !== b.colorKey || a.sizeKey !== b.sizeKey || a.rankedMode !== b.rankedMode || a.primary !== b.primary)
    return false;
  if (!pairEq(a.sizeDomain, b.sizeDomain)) return false;
  if (!numArrEq(a.selection, b.selection)) return false;
  if (!numArrEq(a.labeledPoints, b.labeledPoints)) return false;
  if (!numArrEq(a.tracedPoints, b.tracedPoints)) return false;
  return (
    JSON.stringify(a.colormaps) === JSON.stringify(b.colormaps) &&
    JSON.stringify(a.domains) === JSON.stringify(b.domains) &&
    JSON.stringify(a.filters) === JSON.stringify(b.filters) &&
    JSON.stringify(a.settings) === JSON.stringify(b.settings) &&
    JSON.stringify(a.layout ?? null) === JSON.stringify(b.layout ?? null)
  );
}
