// Shown on the right when >1 point is selected: a roll-up of the selection —
// point-type composition pie, average confidences, and average of each numeric
// variable, plus top categories for categorical variables.

import type { Column, Dataset } from '../format/maplet';
import { formatNumber } from '../format/maplet';
import { Swatch } from '../ui/widgets';

interface Slice {
  label: string;
  colorHex: string;
  count: number;
}

export default function SelectionSummary({ dataset, selection }: { dataset: Dataset; selection: Set<number> }) {
  const sel = [...selection];
  const nSel = sel.length;
  const ranked = dataset.columns.filter((c) => c.kind === 'ranked') as Extract<Column, { kind: 'ranked' }>[];
  const categorical = dataset.columns.filter((c) => c.kind === 'categorical') as Extract<Column, { kind: 'categorical' }>[];
  const continuous = dataset.columns.filter((c) => c.kind === 'continuous') as Extract<Column, { kind: 'continuous' }>[];

  const mainType = ranked[0]; // first ranked call gets the composition pie (by order, not name)
  const mainSlices = mainType ? composition(mainType.top, mainType.categories, sel) : [];

  return (
    <div className="px-3 py-3">
      <div className="mb-3 font-[500]" style={{ color: 'var(--text)' }}>
        {nSel.toLocaleString()} points selected
      </div>

      {mainType && mainSlices.length > 0 && (
        <div className="mb-4">
          <div className="section-head mb-1">{mainType.label} composition</div>
          <div className="flex gap-3">
            <Pie slices={mainSlices} total={sel.length} />
            <Legend slices={mainSlices} total={sel.length} />
          </div>
        </div>
      )}

      {ranked.length > 0 && (
        <div className="mb-3">
          <div className="section-head mb-1">avg top confidence</div>
          <div className="space-y-[3px]">
            {ranked.map((c) => (
              <StatRow key={c.key} label={c.label} value={pct(mean(c.conf, sel))} />
            ))}
          </div>
        </div>
      )}

      {continuous.length > 0 && (
        <div className="mb-3">
          <div className="section-head mb-1">averages</div>
          <div className="space-y-[3px]">
            {continuous.map((c) => {
              const m = mean(c.data, sel);
              return <StatRow key={c.key} label={c.label} value={Number.isNaN(m) ? '—' : formatNumber(m) + (c.unit ? ` ${c.unit}` : '')} />;
            })}
          </div>
        </div>
      )}

      {categorical.map((c) => {
        const slices = composition(c.data, c.categories, sel).slice(0, 5);
        if (slices.length === 0) return null;
        return (
          <div className="mb-3" key={c.key}>
            <div className="section-head mb-1">{c.label}</div>
            <Legend slices={slices} total={sel.length} />
          </div>
        );
      })}
    </div>
  );
}

function StatRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-2 text-[12px]">
      <span className="min-w-0 flex-1 truncate" style={{ color: 'var(--muted)' }} title={label}>
        {label}
      </span>
      <span className="mono-num shrink-0" style={{ color: 'var(--text)' }}>
        {value}
      </span>
    </div>
  );
}

function Legend({ slices, total }: { slices: Slice[]; total: number }) {
  return (
    <div className="min-w-0 flex-1 space-y-[2px]">
      {slices.map((s) => (
        <div key={s.label} className="flex items-center gap-2 text-[11px] leading-tight">
          <Swatch color={s.colorHex} />
          <span className="min-w-0 flex-1 truncate" title={s.label}>
            {s.label}
          </span>
          <span className="mono-num shrink-0" style={{ color: 'var(--faint)' }}>
            {((s.count / Math.max(1, total)) * 100).toFixed(0)}% · {s.count.toLocaleString()}
          </span>
        </div>
      ))}
    </div>
  );
}

function Pie({ slices, total }: { slices: Slice[]; total: number }) {
  const R = 34;
  const C = 38;
  let a = -Math.PI / 2;
  const paths: { d: string; fill: string }[] = [];
  for (const s of slices) {
    const frac = s.count / Math.max(1, total);
    const a1 = a + frac * Math.PI * 2;
    paths.push({ d: arcPath(C, C, R, a, a1), fill: s.colorHex });
    a = a1;
  }
  return (
    <svg width={C * 2} height={C * 2} className="shrink-0" style={{ display: 'block' }}>
      {paths.length === 1 ? (
        <circle cx={C} cy={C} r={R} fill={paths[0].fill} />
      ) : (
        paths.map((p, i) => <path key={i} d={p.d} fill={p.fill} stroke="#050505" strokeWidth={0.75} />)
      )}
    </svg>
  );
}

function arcPath(cx: number, cy: number, r: number, a0: number, a1: number): string {
  const x0 = cx + r * Math.cos(a0);
  const y0 = cy + r * Math.sin(a0);
  const x1 = cx + r * Math.cos(a1);
  const y1 = cy + r * Math.sin(a1);
  const large = a1 - a0 > Math.PI ? 1 : 0;
  return `M${cx},${cy} L${x0.toFixed(2)},${y0.toFixed(2)} A${r},${r} 0 ${large} 1 ${x1.toFixed(2)},${y1.toFixed(2)} Z`;
}

// count of each category among the selection, sorted desc, capped with "(other)"
function composition(idxArr: Int32Array, categories: { index: number; label: string; colorHex: string }[], sel: number[]): Slice[] {
  const counts = new Map<number, number>();
  for (const i of sel) {
    const c = idxArr[i];
    if (c >= 0) counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  const arr = [...counts.entries()]
    .map(([ci, count]) => ({ ci, count }))
    .sort((a, b) => b.count - a.count);
  const top = arr.slice(0, 8);
  const rest = arr.slice(8);
  const slices: Slice[] = top.map(({ ci, count }) => ({
    label: categories[ci]?.label ?? String(ci),
    colorHex: categories[ci]?.colorHex ?? '#808080',
    count,
  }));
  if (rest.length) {
    slices.push({ label: `(${rest.length} more)`, colorHex: '#555555', count: rest.reduce((s, r) => s + r.count, 0) });
  }
  return slices;
}

function mean(data: Float32Array, sel: number[]): number {
  let sum = 0;
  let k = 0;
  for (const i of sel) {
    const v = data[i];
    if (!Number.isNaN(v)) {
      sum += v;
      k++;
    }
  }
  return k === 0 ? NaN : sum / k;
}

function pct(v: number): string {
  return Number.isNaN(v) ? '—' : `${(v * 100).toFixed(0)}%`;
}
