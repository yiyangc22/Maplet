// Full detail for one point — position, every ranked candidate list (point types,
// barcodes, ...) with confidence bars, and every scalar/categorical value.
// Shared by the right panel (single selection) and the hover card.

import type { Column, Dataset } from '../format/maplet';
import { columnValueLabel, formatNumber } from '../format/maplet';
import { rgbToHex } from '../format/colormaps';

export function PointDetails({ dataset, index, compact = false }: { dataset: Dataset; index: number; compact?: boolean }) {
  const point = dataset.points[index];
  if (!point) return null;
  const unit = dataset.meta.unit ? ` ${dataset.meta.unit}` : '';
  const rankedCols = dataset.columns.filter((c) => c.kind === 'ranked');
  const valueCols = dataset.columns.filter((c) => c.kind !== 'ranked');
  const maxCalls = compact ? 3 : 12;

  return (
    <div className={compact ? '' : 'px-3 py-3'}>
      <div className="mb-1 break-all font-[500]" style={{ color: 'var(--text)' }}>
        {point.id}
      </div>
      <div className="mono-num mb-3 text-[11px]" style={{ color: 'var(--muted)' }}>
        {dataset.maps.map((m) => {
          const c = point.coords[m.index];
          if (!c) return null;
          return (
            <div key={m.index}>
              {m.axes.map((ax, a) => `${ax} ${formatNumber(c[a] as number)}`).join(' · ')}
              {unit}
            </div>
          );
        })}
        {point.outline ? <div>outline {point.outline.length} pts</div> : null}
      </div>

      {rankedCols.map((col) => (
        <RankedDetail key={col.key} dataset={dataset} col={col as Extract<Column, { kind: 'ranked' }>} index={index} maxCalls={maxCalls} />
      ))}

      {valueCols.length > 0 && (
        <div className="mt-3">
          <div className="section-head mb-1">values</div>
          <div className="space-y-[3px]">
            {valueCols.map((col) => (
              <div key={col.key} className="flex items-baseline gap-2 text-[12px]">
                <span className="min-w-0 flex-1 truncate" style={{ color: 'var(--muted)' }} title={col.label}>
                  {col.label}
                </span>
                <span className="mono-num shrink-0" style={{ color: 'var(--text)' }}>
                  {columnValueLabel(dataset, col, index)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function RankedDetail({
  dataset,
  col,
  index,
  maxCalls,
}: {
  dataset: Dataset;
  col: Extract<Column, { kind: 'ranked' }>;
  index: number;
  maxCalls: number;
}) {
  const minConf = 0.05; // show candidates ≥5% probable (plus always the top call)
  const all = [...(dataset.points[index].classes?.[col.key] ?? [])].sort(
    (a, b) => (typeof b.confidence === 'number' ? b.confidence : -1) - (typeof a.confidence === 'number' ? a.confidence : -1),
  );
  if (all.length === 0) return null;
  // Every candidate at least `minConf` probable — but never hide the top call.
  const calls = all.filter((c, i) => i === 0 || typeof c.confidence !== 'number' || c.confidence >= minConf);
  const catColor = new Map(col.categories.map((c) => [c.value, c.colorHex] as const));

  return (
    <div className="mb-3">
      <div className="section-head mb-1 flex justify-between">
        <span>{col.label}</span>
        {calls.length > 1 && (
          <span style={{ color: 'var(--faint)' }}>{calls.length} candidates ≥{(minConf * 100).toFixed(0)}%</span>
        )}
      </div>
      <div className="space-y-1">
        {calls.slice(0, maxCalls).map((call, i) => {
          const conf = typeof call.confidence === 'number' ? call.confidence : null;
          const extras = Object.entries(call).filter(([k]) => k !== 'label' && k !== 'confidence');
          const color = catColor.get(String(call.label)) ?? rgbToHex([0.5, 0.5, 0.5]);
          return (
            <div key={i}>
              <div className="flex items-baseline gap-2 text-[12px]">
                <span className="inline-block h-[9px] w-[9px] shrink-0 border" style={{ background: color, borderColor: '#000' }} />
                <span className="min-w-0 flex-1 truncate" title={String(call.label)}>
                  {String(call.label)}
                </span>
                {conf != null && (
                  <span className="mono-num shrink-0" style={{ color: 'var(--muted)' }}>
                    {(conf * 100).toFixed(0)}%
                  </span>
                )}
              </div>
              {conf != null && (
                <div className="mt-[2px] ml-[17px] h-[3px]" style={{ background: 'var(--border-2)' }}>
                  <div className="h-full" style={{ width: `${Math.max(0, Math.min(1, conf)) * 100}%`, background: color }} />
                </div>
              )}
              {extras.length > 0 && (
                <div className="mono-num ml-[17px] text-[10px]" style={{ color: 'var(--faint)' }}>
                  {extras.map(([k, v]) => `${k}: ${typeof v === 'number' ? formatNumber(v) : String(v)}`).join(' · ')}
                </div>
              )}
            </div>
          );
        })}
        {calls.length > maxCalls && (
          <div className="text-[10px]" style={{ color: 'var(--faint)' }}>
            +{calls.length - maxCalls} more
          </div>
        )}
      </div>
    </div>
  );
}
