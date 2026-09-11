// Pure derivation: dataset + view state -> the typed arrays the viewer uploads
// to the GPU. Kept separate from the store so it stays easy to reason about and
// test. All functions are O(n) over points.

import type { Column, Dataset } from '../format/maplet';
import { numericDomain, numericValue } from '../format/maplet';
import { categoricalColor, MISSING_COLOR, sampleColormap } from '../format/colormaps';

export type RankedColorMode = 'label' | 'confidence';

export interface ColorState {
  key: string | null; // null = uniform color
  rankedMode: RankedColorMode;
  colormaps: Map<string, string>; // per-variable colormap override
  domains: Map<string, [number, number]>; // per-variable color-range override
}

const UNIFORM: [number, number, number] = [0.55, 0.72, 0.98];

export function resolvedColormap(col: Column, cs: ColorState): string {
  if (col.kind === 'continuous' || col.kind === 'ranked') return cs.colormaps.get(col.key) ?? col.colormap;
  return col.kind;
}

export function resolvedDomain(col: Column, cs: ColorState): [number, number] {
  return col.kind === 'continuous' ? cs.domains.get(col.key) ?? col.domain : [0, 1];
}

export function normalizeContinuous(
  v: number,
  domain: [number, number],
  scale: 'linear' | 'log',
): number {
  if (Number.isNaN(v)) return NaN;
  const [d0, d1] = domain;
  if (scale === 'log') {
    if (v <= 0 || d0 <= 0 || d1 <= 0) return 0;
    const l0 = Math.log(d0);
    const l1 = Math.log(d1);
    return l1 === l0 ? 0 : (Math.log(v) - l0) / (l1 - l0);
  }
  return d1 === d0 ? 0 : (v - d0) / (d1 - d0);
}

// Per-point SIZE multipliers for "size by" a numeric variable (analogous to
// computeColors): the variable's value, normalised over its color/filter domain,
// mapped into [SIZE_MIN, SIZE_MAX]. A null key (or non-continuous column) → all 1
// (uniform). Missing values render at the neutral 1.0 so they stay visible.
export const SIZE_MIN = 0.45;
export const SIZE_MAX = 3.2;
export function computeSizes(ds: Dataset, key: string | null, sizeDomain?: [number, number] | null): Float32Array | null {
  const col = key ? ds.columnByKey.get(key) : undefined;
  if (!col) return null;
  // Any variable type sizes by its numeric reading (categorical → palette index,
  // ranked → confidence). Values below/above the domain floor/ceil to the min/max
  // dot size (clamp of t).
  const domain: [number, number] = sizeDomain ?? numericDomain(col);
  const scale = col.kind === 'continuous' ? col.scale : 'linear';
  const out = new Float32Array(ds.n);
  for (let i = 0; i < ds.n; i++) {
    const t = normalizeContinuous(numericValue(col, i), domain, scale);
    out[i] = Number.isNaN(t) ? 1 : SIZE_MIN + Math.max(0, Math.min(1, t)) * (SIZE_MAX - SIZE_MIN);
  }
  return out;
}

export function computeColors(ds: Dataset, cs: ColorState): Float32Array {
  const n = ds.n;
  const out = new Float32Array(n * 3);
  const col = cs.key ? ds.columnByKey.get(cs.key) : undefined;
  if (!col) {
    for (let i = 0; i < n; i++) {
      out[i * 3] = UNIFORM[0];
      out[i * 3 + 1] = UNIFORM[1];
      out[i * 3 + 2] = UNIFORM[2];
    }
    return out;
  }
  fillColumnColors(out, col, cs);
  return out;
}

function fillColumnColors(out: Float32Array, col: Column, cs: ColorState): void {
  const n = out.length / 3;
  const colormap = resolvedColormap(col, cs);
  if (col.kind === 'continuous') {
    const domain = resolvedDomain(col, cs);
    for (let i = 0; i < n; i++) {
      const t = normalizeContinuous(col.data[i], domain, col.scale);
      const rgb = Number.isNaN(t) ? MISSING_COLOR : sampleColormap(colormap, t);
      out[i * 3] = rgb[0];
      out[i * 3 + 1] = rgb[1];
      out[i * 3 + 2] = rgb[2];
    }
  } else if (col.kind === 'categorical') {
    for (let i = 0; i < n; i++) {
      const idx = col.data[i];
      const rgb = idx < 0 ? MISSING_COLOR : col.categories[idx].color;
      out[i * 3] = rgb[0];
      out[i * 3 + 1] = rgb[1];
      out[i * 3 + 2] = rgb[2];
    }
  } else {
    // ranked
    for (let i = 0; i < n; i++) {
      let rgb: readonly [number, number, number];
      if (cs.rankedMode === 'confidence') {
        const c = col.conf[i];
        rgb = Number.isNaN(c) ? MISSING_COLOR : sampleColormap(colormap, c);
      } else {
        const idx = col.top[i];
        rgb = idx < 0 ? MISSING_COLOR : col.categories[idx].color;
      }
      out[i * 3] = rgb[0];
      out[i * 3 + 1] = rgb[1];
      out[i * 3 + 2] = rgb[2];
    }
  }
}

// Legend swatch color for a category or the "missing" bucket (for the UI).
export { categoricalColor };

// Indices of points whose color matches point `i` within a tight tolerance
// (exact for categorical/cluster colors; near-identical for continuous), among
// visible points only. Powers "color select".
export function sameColorIndices(
  colors: Float32Array,
  visible: Uint8Array | null,
  i: number,
  eps = 1e-4,
): number[] {
  const out: number[] = [];
  const n = colors.length / 3;
  if (i < 0 || i >= n) return out;
  const r = colors[i * 3];
  const g = colors[i * 3 + 1];
  const b = colors[i * 3 + 2];
  for (let j = 0; j < n; j++) {
    if (visible && !visible[j]) continue;
    const dr = colors[j * 3] - r;
    const dg = colors[j * 3 + 1] - g;
    const db = colors[j * 3 + 2] - b;
    if (dr * dr + dg * dg + db * db <= eps) out.push(j);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

export interface ContinuousFilter {
  kind: 'continuous';
  min: number;
  max: number;
  includeMissing: boolean;
}
// Categorical filter (also covers former identifiers): a set of DISABLED values
// (ticked off). Empty = all pass. Filtering is by the real per-point string, so it
// works at any cardinality — thousands of values need no per-index palette.
export interface CategoricalFilter {
  kind: 'categorical';
  disabled: Set<string>;
  includeMissing: boolean;
}
// (dormant) ranked filter — the loader no longer produces ranked columns, but the
// type/handling stays so old saved views don't break.
export interface RankedFilter {
  kind: 'ranked';
  enabledTop: Set<number>;
  minConf: number;
  includeMissing: boolean;
}
export type Filter = ContinuousFilter | CategoricalFilter | RankedFilter;

export function defaultFilter(col: Column): Filter {
  if (col.kind === 'continuous') {
    return { kind: 'continuous', min: col.dataMin, max: col.dataMax, includeMissing: true };
  }
  if (col.kind === 'categorical') {
    return { kind: 'categorical', disabled: new Set(), includeMissing: true };
  }
  return {
    kind: 'ranked',
    enabledTop: new Set(col.categories.map((c) => c.index)),
    minConf: 0,
    includeMissing: true,
  };
}

// Whether a filter is currently narrowing anything (drives the "active" dot and
// lets us skip pass-all filters in the hot loop).
export function filterIsActive(col: Column, f: Filter): boolean {
  if (f.kind === 'continuous' && col.kind === 'continuous') {
    return f.min > col.dataMin || f.max < col.dataMax || !f.includeMissing;
  }
  if (f.kind === 'categorical' && col.kind === 'categorical') {
    return f.disabled.size > 0 || !f.includeMissing;
  }
  if (f.kind === 'ranked' && col.kind === 'ranked') {
    return f.enabledTop.size < col.categories.length || f.minConf > 0 || !f.includeMissing;
  }
  return false;
}

function cellPassesFilter(col: Column, f: Filter, i: number): boolean {
  if (f.kind === 'continuous' && col.kind === 'continuous') {
    const v = col.data[i];
    if (Number.isNaN(v)) return f.includeMissing;
    return v >= f.min && v <= f.max;
  }
  if (f.kind === 'categorical' && col.kind === 'categorical') {
    const v = col.rawValues[i];
    if (v == null || v === '') return f.includeMissing;
    return !f.disabled.has(v);
  }
  if (f.kind === 'ranked' && col.kind === 'ranked') {
    const idx = col.top[i];
    if (idx < 0) return f.includeMissing;
    if (!f.enabledTop.has(idx)) return false;
    if (f.minConf > 0) {
      const c = col.conf[i];
      if (Number.isNaN(c) || c < f.minConf) return false;
    }
    return true;
  }
  return true;
}

export interface VisibilityResult {
  visible: Uint8Array;
  count: number;
}

export function computeVisible(ds: Dataset, filters: Map<string, Filter>): VisibilityResult {
  const n = ds.n;
  const visible = new Uint8Array(n).fill(1);

  const active: { col: Column; f: Filter }[] = [];
  for (const [key, f] of filters) {
    const col = ds.columnByKey.get(key);
    if (col && filterIsActive(col, f)) active.push({ col, f });
  }
  if (active.length === 0) return { visible, count: n };

  let count = 0;
  for (let i = 0; i < n; i++) {
    let ok = true;
    for (const { col, f } of active) {
      if (!cellPassesFilter(col, f, i)) {
        ok = false;
        break;
      }
    }
    visible[i] = ok ? 1 : 0;
    if (ok) count++;
  }
  return { visible, count };
}
