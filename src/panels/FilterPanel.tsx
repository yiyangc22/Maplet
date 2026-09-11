// "Filter" panel: one collapsible block per variable, built entirely from the
// dataset's resolved columns — so custom variables get filter controls with no
// app-side special-casing.
//
// cat_prototype_10: there are two variable types — numerical (a value range) and
// categorical (a searchable value list). A categorical is filtered by ticking
// values in a scrollable, searchable list, at ANY cardinality (the former
// "identifier" text box and the ">36 distinct" summary are gone).

import { useMemo, useState } from 'react';
import { useStore } from '../model/store';
import type { Column } from '../format/maplet';
import { formatNumber } from '../format/maplet';
import { defaultFilter, filterIsActive, type Filter } from '../model/derive';
import { DualRange, Section, Slider, Swatch, Toggle } from '../ui/widgets';

type ScalarType = 'grad' | 'cat';

export default function FilterPanel() {
  const dataset = useStore((s) => s.dataset);
  const filters = useStore((s) => s.filters);
  const resetAllFilters = useStore((s) => s.resetAllFilters);
  const [open, setOpen] = useState(true);
  if (!dataset) return null;

  const anyActive = filters.size > 0;

  // A collapsible section like Color/Size/Display, but its body is full-width
  // (no side padding) so each per-variable filter row spans the panel.
  return (
    <div className="border-b" style={{ borderColor: 'var(--border)' }}>
      <div className="flex items-center gap-2 px-3 py-2">
        <button
          className="section-head flex items-center gap-2 hover:text-white"
          data-tip="Narrow which points are shown. Each variable gets a control; hidden points ghost or disappear."
          onClick={() => setOpen((o) => !o)}
        >
          <span className="inline-block w-3 text-center" style={{ color: 'var(--faint)' }}>
            {open ? '▾' : '▸'}
          </span>
          Filter
          {anyActive && <span className="inline-block h-[6px] w-[6px] rounded-full" style={{ background: 'var(--accent)' }} title="active" />}
        </button>
        <button
          className="btn ml-auto py-[1px] text-[10px]"
          disabled={!anyActive}
          onClick={resetAllFilters}
          data-tip="Clear every filter and show all points."
        >
          reset all
        </button>
      </div>
      {open && (
        <div style={{ background: 'var(--panel-2)' }}>
          {dataset.columns.map((col) => (
            <VariableFilter key={col.key} col={col} filter={filters.get(col.key)} />
          ))}
        </div>
      )}
    </div>
  );
}

function VariableFilter({ col, filter }: { col: Column; filter: Filter | undefined }) {
  const f = filter ?? defaultFilter(col);
  const active = filterIsActive(col, f);
  const resetFilter = useStore((s) => s.resetFilter);

  return (
    <Section
      title={col.label}
      active={active}
      defaultOpen={false}
      right={
        active ? (
          <button className="btn py-[1px] text-[10px]" onClick={() => resetFilter(col.key)}>
            reset
          </button>
        ) : undefined
      }
    >
      <VariableTypeSelect col={col} />
      {col.kind === 'continuous' && f.kind === 'continuous' && <ContinuousFilter col={col} f={f} />}
      {col.kind === 'categorical' && f.kind === 'categorical' && (
        <CategoryFilter col={col} disabled={f.disabled} includeMissing={f.includeMissing} nMissing={col.nMissing} />
      )}
      {col.kind === 'ranked' && f.kind === 'ranked' && <RankedFilter col={col} f={f} />}
    </Section>
  );
}

// Per-variable type override: numerical <-> categorical. (Ranked is dormant — the
// loader never produces it — so it shows a static note.) Re-typing is a cheap,
// reversible runtime rebuild, so it applies immediately with no confirm.
function VariableTypeSelect({ col }: { col: Column }) {
  const setVariableType = useStore((s) => s.setVariableType);

  if (col.kind === 'ranked') {
    return (
      <div className="mb-2 text-[10px]" style={{ color: 'var(--faint)' }}>
        type: ranked · multi-column, set in the file
      </div>
    );
  }

  const cur: ScalarType = col.kind === 'continuous' ? 'grad' : 'cat';

  return (
    <div className="mb-2 flex items-center gap-2 text-[11px]">
      <span style={{ color: 'var(--muted)' }}>type</span>
      <select
        value={cur}
        onChange={(e) => setVariableType(col.key, e.target.value as ScalarType)}
        className="field text-[11px]"
        data-tip="How this variable is displayed and filtered. Set it when you loaded the file; change it here to override."
      >
        <option value="grad">numerical</option>
        <option value="cat">categorical</option>
      </select>
    </div>
  );
}

function ContinuousFilter({
  col,
  f,
}: {
  col: Extract<Column, { kind: 'continuous' }>;
  f: Extract<Filter, { kind: 'continuous' }>;
}) {
  const setContinuousRange = useStore((s) => s.setContinuousRange);
  const setIncludeMissing = useStore((s) => s.setIncludeMissing);
  return (
    <div>
      <DualRange
        min={col.dataMin}
        max={col.dataMax}
        low={f.min}
        high={f.max}
        scale={col.scale}
        onChange={(lo, hi) => setContinuousRange(col.key, lo, hi)}
      />
      {/* Type exact bounds — a companion to the sliders for precise cut-offs. Each box
          commits on Enter or blur; values are clamped to the data range and kept
          ordered (min ≤ max). */}
      <div className="mt-1 flex items-center gap-2">
        <NumBox
          value={f.min}
          tip="Lowest value shown. Enter to apply."
          onCommit={(v) => setContinuousRange(col.key, Math.min(Math.max(v, col.dataMin), f.max), f.max)}
        />
        <span className="text-[10px]" style={{ color: 'var(--faint)' }}>
          to
        </span>
        <NumBox
          value={f.max}
          tip="Highest value shown. Enter to apply."
          onCommit={(v) => setContinuousRange(col.key, f.min, Math.max(Math.min(v, col.dataMax), f.min))}
        />
      </div>
      {col.nMissing > 0 && (
        <Toggle
          label={<span style={{ color: 'var(--muted)' }}>include missing ({col.nMissing.toLocaleString()})</span>}
          checked={f.includeMissing}
          onChange={(v) => setIncludeMissing(col.key, v)}
        />
      )}
    </div>
  );
}

// (dormant) Ranked min-confidence slider — kept so an old saved view with a ranked
// filter still renders. The loader no longer produces ranked columns.
function RankedFilter({
  col,
  f,
}: {
  col: Extract<Column, { kind: 'ranked' }>;
  f: Extract<Filter, { kind: 'ranked' }>;
}) {
  const setRankedMinConf = useStore((s) => s.setRankedMinConf);
  return (
    <div className="mb-2">
      <div className="section-head mb-1 flex justify-between">
        <span>min confidence</span>
        <span className="mono-num" style={{ color: 'var(--muted)' }}>
          {(f.minConf * 100).toFixed(0)}%
        </span>
      </div>
      <Slider min={0} max={1} step={0.01} value={f.minConf} onChange={(v) => setRankedMinConf(col.key, v)} />
    </div>
  );
}

// A compact numeric text box for typing an exact filter bound. It holds its own
// draft text while focused (so mid-edit keystrokes aren't clobbered by the store
// echoing back a rounded value), and commits a parsed number on Enter or blur;
// Escape / an unparseable value reverts to the current bound.
function NumBox({ value, onCommit, tip }: { value: number; onCommit: (v: number) => void; tip?: string }) {
  // While focused, `draft` holds the raw text so store echoes (rounded values) don't
  // clobber mid-edit keystrokes; when not editing it's null and the live value shows.
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? formatNumber(value);
  const commit = (text: string) => {
    const v = Number(text);
    if (text.trim() !== '' && Number.isFinite(v)) onCommit(v);
    setDraft(null);
  };
  return (
    <input
      type="text"
      inputMode="decimal"
      value={shown}
      data-tip={tip}
      onFocus={(e) => {
        setDraft(String(value));
        e.currentTarget.select();
      }}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={(e) => commit(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        else if (e.key === 'Escape') {
          setDraft(null);
          e.currentTarget.blur();
        }
      }}
      className="mono-num w-0 min-w-0 flex-1 border bg-transparent px-1 py-[2px] text-[11px] outline-none"
      style={{ borderColor: 'var(--border)', color: 'var(--text)' }}
    />
  );
}

// The unified categorical control: a search box + a scrollable list of every
// distinct value with a checkbox and count. Ticking a value includes it; unticking
// excludes it. Works at any cardinality — the search narrows the list and only the
// first CATEGORY_ROWS matches are rendered, so tens of thousands of values stay
// responsive. Colour swatches come from the capped palette (values past it show a
// neutral swatch — they still filter, they just aren't a distinct colour).
const CATEGORY_ROWS = 500;

function CategoryFilter({
  col,
  disabled,
  includeMissing,
  nMissing,
}: {
  col: Extract<Column, { kind: 'categorical' }>;
  disabled: Set<string>;
  includeMissing: boolean;
  nMissing: number;
}) {
  const toggleCategory = useStore((s) => s.toggleCategory);
  const setAllCategories = useStore((s) => s.setAllCategories);
  const setIncludeMissing = useStore((s) => s.setIncludeMissing);
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();

  const colorOf = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of col.categories) if (!c.isOther) m.set(c.value, c.colorHex);
    return m;
  }, [col]);
  const matched = useMemo(
    () => (q === '' ? col.distinct : col.distinct.filter((d) => d.value.toLowerCase().includes(q))),
    [col, q],
  );
  const shown = matched.slice(0, CATEGORY_ROWS);

  return (
    <div>
      <input
        type="text"
        value={query}
        placeholder={`search ${col.nDistinct.toLocaleString()} value${col.nDistinct === 1 ? '' : 's'}…`}
        onChange={(e) => setQuery(e.target.value)}
        className="mb-2 w-full border bg-transparent px-2 py-[3px] text-[12px] outline-none"
        style={{ borderColor: q ? 'var(--accent)' : 'var(--border)', color: 'var(--text)' }}
        data-tip="Type to find values (case-insensitive). Tick a value to include it, untick to exclude."
      />
      <div className="mb-1 flex gap-1">
        <button className="btn flex-1 py-[1px] text-[10px]" onClick={() => setAllCategories(col.key, true)}>
          all
        </button>
        <button className="btn flex-1 py-[1px] text-[10px]" onClick={() => setAllCategories(col.key, false)}>
          none
        </button>
      </div>
      <div className="max-h-52 overflow-y-auto pr-1">
        {shown.map((d) => (
          <label key={d.value} className="flex cursor-pointer items-center gap-2 py-[2px] leading-tight">
            <input type="checkbox" checked={!disabled.has(d.value)} onChange={() => toggleCategory(col.key, d.value)} />
            <Swatch color={colorOf.get(d.value) ?? '#808080'} />
            <span className="min-w-0 flex-1 truncate" title={d.value}>
              {d.value}
            </span>
            <span className="mono-num shrink-0 text-[11px]" style={{ color: 'var(--faint)' }}>
              {d.count.toLocaleString()}
            </span>
          </label>
        ))}
        {matched.length > CATEGORY_ROWS && (
          <div className="px-1 py-1 text-[10px]" style={{ color: 'var(--faint)' }}>
            {(matched.length - CATEGORY_ROWS).toLocaleString()} more — refine the search to narrow the list.
          </div>
        )}
        {matched.length === 0 && (
          <div className="px-1 py-1 text-[10px]" style={{ color: 'var(--faint)' }}>
            no values match &ldquo;{query}&rdquo;.
          </div>
        )}
      </div>
      {nMissing > 0 && (
        <Toggle
          label={<span style={{ color: 'var(--muted)' }}>include missing ({nMissing.toLocaleString()})</span>}
          checked={includeMissing}
          onChange={(v) => setIncludeMissing(col.key, v)}
        />
      )}
    </div>
  );
}
