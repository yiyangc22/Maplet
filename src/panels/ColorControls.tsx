// "Color" panel: pick the variable that colors the cloud, choose a colormap for
// continuous/confidence coloring, and show the matching legend or colorbar.

import { useRef } from 'react';
import { useStore } from '../model/store';
import { COLORMAP_NAMES, colormapGradient } from '../format/colormaps';
import { type Column, displayCategories, formatNumber, hasCategoryOverflow, type ResolvedCategory } from '../format/maplet';
import type { Filter } from '../model/derive';
import { Labeled, Select, Swatch } from '../ui/widgets';

export default function ColorControls() {
  const dataset = useStore((s) => s.dataset);
  const colorKey = useStore((s) => s.colorKey);
  const rankedMode = useStore((s) => s.rankedMode);
  const setColorKey = useStore((s) => s.setColorKey);
  const setRankedMode = useStore((s) => s.setRankedMode);
  const setColormap = useStore((s) => s.setColormap);
  const colormaps = useStore((s) => s.colormaps);
  const domains = useStore((s) => s.domains);
  const filters = useStore((s) => s.filters);
  if (!dataset) return null;

  const col = colorKey ? dataset.columnByKey.get(colorKey) : undefined;
  // The colour variable's live filter, so the legend can dim hidden values and
  // toggle them through the shared (undoable) filter.
  const colFilter = col ? filters.get(col.key) : undefined;
  // A categorical with thousands of distinct values can't be told apart by colour,
  // so it isn't offered as a colour axis — unless it's already selected, to keep the
  // dropdown consistent.
  const colorables = dataset.columns.filter(
    (c) => !(c.kind === 'categorical' && hasCategoryOverflow(c)) || c.key === colorKey,
  );
  const rankedOverflow = col?.kind === 'ranked' && hasCategoryOverflow(col);
  const effectiveColormap =
    col && (col.kind === 'continuous' || col.kind === 'ranked') ? colormaps.get(col.key) ?? col.colormap : 'viridis';
  const effectiveDomain: [number, number] =
    col && col.kind === 'continuous' ? domains.get(col.key) ?? col.domain : [0, 1];

  return (
    <div>
      <div className="mb-2">
        <Select
          value={colorKey ?? '__uniform__'}
          onChange={(v) => setColorKey(v === '__uniform__' ? null : v)}
          tip="Which variable colors the points. Every variable in the file is available."
        >
          <option value="__uniform__">Uniform</option>
          {colorables.map((c) => (
            <option key={c.key} value={c.key}>
              {c.label}
              {c.kind === 'continuous' ? '  ⟨num⟩' : '  ⟨cat⟩'}
            </option>
          ))}
        </Select>
      </div>

      {col?.kind === 'ranked' && !rankedOverflow && (
        <div className="mb-2 flex gap-1">
          <button
            className={`btn flex-1 ${rankedMode === 'label' ? 'btn-active' : ''}`}
            onClick={() => setRankedMode('label')}
            data-tip="Color each point by its top-ranked label (e.g. its most likely point type)."
          >
            top label
          </button>
          <button
            className={`btn flex-1 ${rankedMode === 'confidence' ? 'btn-active' : ''}`}
            onClick={() => setRankedMode('confidence')}
            data-tip="Color each point by the confidence of its top call, using a colormap."
          >
            confidence
          </button>
        </div>
      )}
      {rankedOverflow && (
        <div className="mb-2 text-[11px] leading-snug" style={{ color: 'var(--muted)' }}>
          <span className="mono-num" style={{ color: 'var(--text)' }}>
            {col?.kind === 'ranked' ? col.nDistinct.toLocaleString() : ''}
          </span>{' '}
          distinct barcodes — coloured by confidence (a per-barcode colour would be noise).
        </div>
      )}

      {(col?.kind === 'continuous' || (col?.kind === 'ranked' && rankedMode === 'confidence')) && (
        <>
          <Labeled label="Colormap" tip="Perceptual colormap for the continuous scale.">
            <Select value={effectiveColormap} onChange={(v) => setColormap(col.key, v)} tip="Perceptual colormap for the continuous scale.">
              {COLORMAP_NAMES.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </Select>
          </Labeled>
          <Colorbar
            name={effectiveColormap}
            lo={effectiveDomain[0]}
            hi={effectiveDomain[1]}
            unit={col.kind === 'continuous' ? col.unit : undefined}
          />
        </>
      )}

      {(col?.kind === 'categorical' || (col?.kind === 'ranked' && rankedMode === 'label')) && (
        <Legend col={col} categories={displayCategories(col.categories)} filter={colFilter} />
      )}
    </div>
  );
}

function Colorbar({ name, lo, hi, unit }: { name: string; lo: number; hi: number; unit?: string }) {
  return (
    <div className="mb-1">
      <div className="h-3 w-full border" style={{ background: colormapGradient(name), borderColor: '#000' }} />
      <div className="mono-num mt-1 flex justify-between text-[11px]" style={{ color: 'var(--muted)' }}>
        <span>{formatNumber(lo)}</span>
        <span>
          {formatNumber(hi)}
          {unit ? ` ${unit}` : ''}
        </span>
      </div>
    </div>
  );
}

// Interactive legend: click a category to show/hide it (dims when hidden),
// double-click to show ONLY it (double-click the isolated one again to restore
// all). Both route through the shared per-variable filter (by value), so they're
// undoable and reflected everywhere.
function Legend({ col, categories, filter }: { col: Column; categories: ResolvedCategory[]; filter?: Filter }) {
  const toggleCategory = useStore((s) => s.toggleCategory);
  const isolateCategory = useStore((s) => s.isolateCategory);
  const setAllCategories = useStore((s) => s.setAllCategories);
  const timer = useRef<number | null>(null);
  // Which values are hidden. Categorical: the disabled value set. Ranked (dormant):
  // an enabled top-label index set.
  const disabled = filter?.kind === 'categorical' ? filter.disabled : null;
  const enabledTop = filter?.kind === 'ranked' ? filter.enabledTop : null;
  const total = col.kind === 'categorical' ? col.distinct.length : col.kind === 'ranked' ? col.categories.length : 0;
  const visible = (c: ResolvedCategory) => (disabled ? !disabled.has(c.value) : enabledTop ? enabledTop.has(c.index) : true);
  const isOnlyShown = (c: ResolvedCategory) =>
    disabled ? total - disabled.size === 1 && !disabled.has(c.value) : !!enabledTop && enabledTop.size === 1 && enabledTop.has(c.index);
  // A short delay tells a single click (toggle) from a double click (isolate).
  const onClick = (c: ResolvedCategory) => {
    if (timer.current != null) {
      clearTimeout(timer.current);
      timer.current = null;
      if (isOnlyShown(c)) setAllCategories(col.key, true);
      else isolateCategory(col.key, c.value);
    } else {
      timer.current = window.setTimeout(() => {
        timer.current = null;
        toggleCategory(col.key, c.value);
      }, 220);
    }
  };
  return (
    <div className="mt-1 max-h-56 overflow-y-auto pr-1">
      {categories.map((c) => {
        const vis = visible(c);
        return (
          <button
            key={c.index}
            onClick={() => onClick(c)}
            className="flex w-full items-center gap-2 py-[2px] text-left leading-tight hover:text-white"
            style={{ opacity: vis ? 1 : 0.45 }}
            data-tip="Click to show/hide · double-click to show only this category"
          >
            <Swatch color={c.colorHex} />
            <span className={`min-w-0 flex-1 truncate ${vis ? '' : 'line-through'}`} title={c.label}>
              {c.label}
            </span>
            <span className="mono-num shrink-0 text-[11px]" style={{ color: 'var(--faint)' }}>
              {c.count.toLocaleString()}
            </span>
          </button>
        );
      })}
    </div>
  );
}
