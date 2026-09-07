// "Size by" panel: the baseline dot size, and optionally scaling each dot by a
// numeric variable (with a min/max that floors/ceils the value range mapped to
// the smallest / largest dot). Independent of "Color by".

import { useMemo } from 'react';
import { useStore } from '../model/store';
import { Select, Slider } from '../ui/widgets';

export default function SizeControls() {
  const s = useStore((st) => st.settings);
  const st = useStore();
  const dataset = useStore((x) => x.dataset);
  const sizeDomain = st.sizeDomain;
  const numericCols = useMemo(() => dataset?.columns.filter((c) => c.kind === 'continuous') ?? [], [dataset]);

  return (
    <div className="space-y-3">
      <div>
        <Select
          value={st.sizeKey ?? '__uniform__'}
          onChange={(v) => st.setSizeKey(v === '__uniform__' ? null : v)}
          tip="Scale each dot by a numeric variable (independent of Color by). Uniform keeps one size."
        >
          <option value="__uniform__">Uniform</option>
          {numericCols.map((c) => (
            <option key={c.key} value={c.key}>
              {c.label}
              {'  ⟨grad⟩'}
            </option>
          ))}
        </Select>
        {st.sizeKey && sizeDomain && (
          <div className="mt-2 flex items-center gap-3 text-[11px]" style={{ color: 'var(--muted)' }}>
            <label className="flex flex-1 items-center gap-1" data-tip="Values at or below this floor to the smallest dot.">
              min
              <input
                className="field mono-num w-full"
                type="number"
                value={sizeDomain[0]}
                step="any"
                onChange={(e) => st.setSizeDomain([Number(e.target.value), sizeDomain[1]])}
              />
            </label>
            <label className="flex flex-1 items-center gap-1" data-tip="Values at or above this ceil to the largest dot.">
              max
              <input
                className="field mono-num w-full"
                type="number"
                value={sizeDomain[1]}
                step="any"
                onChange={(e) => st.setSizeDomain([sizeDomain[0], Number(e.target.value)])}
              />
            </label>
          </div>
        )}
      </div>
      <Row label="base point size" value={s.pointSize.toFixed(1)} tip="Baseline size of every dot; 'size by' scales the range around this.">
        <Slider min={0.2} max={6} step={0.1} value={s.pointSize} onChange={st.setPointSize} />
      </Row>
    </div>
  );
}

function Row({ label, value, tip, children }: { label: string; value: string; tip?: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="section-head mb-1 flex justify-between" data-tip={tip}>
        <span>{label}</span>
        <span className="mono-num" style={{ color: 'var(--muted)' }}>
          {value}
        </span>
      </div>
      {children}
    </div>
  );
}
