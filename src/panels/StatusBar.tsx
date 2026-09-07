// Bottom status strip: dataset counts + current color + hovered point.

import { useStore } from '../model/store';

export default function StatusBar() {
  const dataset = useStore((s) => s.dataset);
  const visibleCount = useStore((s) => s.visibleCount);
  const selection = useStore((s) => s.selection);
  const colorKey = useStore((s) => s.colorKey);
  const hover = useStore((s) => s.hover);

  if (!dataset) {
    return (
      <div className="flex h-6 shrink-0 items-center gap-4 border-t px-3 text-[11px]" style={barStyle}>
        <span style={{ color: 'var(--faint)' }}>no dataset — open a .csv / .tsv, or drag one onto the window</span>
      </div>
    );
  }

  const colorLabel = colorKey ? dataset.columnByKey.get(colorKey)?.label ?? colorKey : 'uniform';
  const hoverCell = hover != null ? dataset.points[hover] : null;

  return (
    <div className="flex h-6 shrink-0 items-center gap-4 border-t px-3 text-[11px]" style={barStyle}>
      <Stat label="points" value={dataset.n.toLocaleString()} />
      <Stat label="shown" value={visibleCount.toLocaleString()} />
      <Stat label="selected" value={selection.size.toLocaleString()} />
      <Stat label="color" value={colorLabel} />
      <div className="ml-auto truncate" style={{ color: 'var(--muted)' }}>
        {hoverCell ? `▸ ${hoverCell.id}` : ''}
      </div>
    </div>
  );
}

const barStyle: React.CSSProperties = { borderColor: 'var(--border)', background: 'var(--panel)' };

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <span className="flex items-baseline gap-1">
      <span style={{ color: 'var(--faint)' }}>{label}</span>
      <span className="mono-num" style={{ color: 'var(--text)' }}>
        {value}
      </span>
    </span>
  );
}
