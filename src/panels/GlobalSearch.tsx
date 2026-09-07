// Edit → Global search: a command-palette-style search over the WHOLE dataset
// (filters ignored). Matches point IDs, any field value, ranked labels, and column
// names. Picking a point selects it and frames the main view on it; picking a
// column colors by it. Read-only — it never changes the filters.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../model/store';
import { columnValueLabel, type Column } from '../format/maplet';

const POINT_LIMIT = 50;

export default function GlobalSearch({ open, onClose }: { open: boolean; onClose: () => void }) {
  const dataset = useStore((s) => s.dataset);
  const visible = useStore((s) => s.visible); // hidden points aren't selectable, so aren't searchable
  const selectOnly = useStore((s) => s.selectOnly);
  const frameSelection = useStore((s) => s.frameSelection);
  const setColorKey = useStore((s) => s.setColorKey);
  const [q, setQ] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setQ('');
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  const results = useMemo(() => {
    const empty = { cols: [] as { key: string; label: string; kind: string }[], pts: [] as { i: number; text: string }[] };
    if (!dataset || q.trim() === '') return empty;
    const s = q.trim().toLowerCase();
    const cols = dataset.columns
      .filter((c) => c.key.toLowerCase().includes(s) || c.label.toLowerCase().includes(s))
      .slice(0, 12)
      .map((c) => ({ key: c.key, label: c.label, kind: c.kind }));
    // Scan the columnar data directly (ids + each column's value at i) rather than
    // reconstructing a full record per point — so search stays cheap on a large,
    // lazily-backed `points` view.
    const ids = dataset.pointIds;
    const valueCols = dataset.columns.filter((c) => c.kind !== 'ranked');
    const rankedCols = dataset.columns.filter((c) => c.kind === 'ranked') as Extract<Column, { kind: 'ranked' }>[];
    const pts: { i: number; text: string }[] = [];
    for (let i = 0; i < dataset.n && pts.length < POINT_LIMIT; i++) {
      if (visible && !visible[i]) continue; // skip hidden points — they can't be selected
      const id = ids[i];
      if (id.toLowerCase().includes(s)) {
        pts.push({ i, text: id });
        continue;
      }
      let hit: string | null = null;
      for (const c of valueCols) {
        const label = columnValueLabel(dataset, c, i);
        if (label !== '—' && label.toLowerCase().includes(s)) {
          hit = `${c.label}: ${label}`;
          break;
        }
      }
      if (!hit) {
        for (const c of rankedCols) {
          const idx = c.top[i];
          if (idx < 0) continue;
          const label = columnValueLabel(dataset, c, i);
          if (label.toLowerCase().includes(s)) {
            hit = `${c.label}: ${label}`;
            break;
          }
        }
      }
      if (hit) pts.push({ i, text: `${id} — ${hit}` });
    }
    return { cols, pts };
  }, [dataset, q, visible]);

  if (!open || !dataset) return null;

  const pickPoint = (i: number) => {
    selectOnly(i);
    frameSelection();
    onClose();
  };
  const pickColumn = (key: string) => {
    setColorKey(key);
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[12vh]"
      style={{ background: 'rgba(0,0,0,0.5)' }}
      onMouseDown={onClose}
    >
      <div className="panel w-[560px] max-w-[92vw] p-3" style={{ background: 'var(--panel-2)' }} onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="field w-full"
          value={q}
          spellCheck={false}
          placeholder="Search entries and columns…  (an id, any value, or a column name)"
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onClose();
            else if (e.key === 'Enter' && results.pts[0]) pickPoint(results.pts[0].i);
          }}
        />
        <div className="mt-2 max-h-[52vh] overflow-y-auto text-[12px]">
          {q.trim() === '' && (
            <div style={{ color: 'var(--faint)' }}>Type to search the shown points and every column by name.</div>
          )}
          {q.trim() !== '' && results.cols.length === 0 && results.pts.length === 0 && (
            <div style={{ color: 'var(--faint)' }}>No matches.</div>
          )}
          {results.cols.length > 0 && (
            <div className="mb-2">
              <div className="section-head mb-1">columns</div>
              {results.cols.map((c) => (
                <button
                  key={c.key}
                  className="block w-full truncate px-2 py-[3px] text-left hover:bg-white hover:text-black"
                  onClick={() => pickColumn(c.key)}
                  title={`Color by ${c.label}`}
                >
                  {c.label} <span style={{ color: 'var(--faint)' }}>· {c.kind}</span>
                </button>
              ))}
            </div>
          )}
          {results.pts.length > 0 && (
            <div>
              <div className="section-head mb-1">points{results.pts.length >= POINT_LIMIT ? ` (first ${POINT_LIMIT})` : ''}</div>
              {results.pts.map((p) => (
                <button
                  key={p.i}
                  className="mono-num block w-full truncate px-2 py-[3px] text-left hover:bg-white hover:text-black"
                  onClick={() => pickPoint(p.i)}
                  title={p.text}
                >
                  {p.text}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
