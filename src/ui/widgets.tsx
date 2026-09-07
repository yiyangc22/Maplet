// Small brutalist UI primitives shared across panels. Several accept a `tip`
// (hover description) which becomes a data-tip attribute the TooltipLayer reads.

import { useState, type ReactNode } from 'react';

export function Section({
  title,
  active,
  right,
  tip,
  defaultOpen = true,
  children,
}: {
  title: string;
  active?: boolean;
  right?: ReactNode;
  tip?: string;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border-b" style={{ borderColor: 'var(--border)' }}>
      <div className="flex items-center gap-2 px-3 py-2">
        <button
          className="section-head flex items-center gap-2 hover:text-white"
          data-tip={tip}
          onClick={() => setOpen((o) => !o)}
        >
          <span className="inline-block w-3 text-center" style={{ color: 'var(--faint)' }}>
            {open ? '▾' : '▸'}
          </span>
          {title}
          {active && (
            <span
              className="inline-block h-[6px] w-[6px] rounded-full"
              style={{ background: 'var(--accent)' }}
              title="active"
            />
          )}
        </button>
        <div className="ml-auto">{right}</div>
      </div>
      {/* The open body sits on a slightly lighter panel so you can tell where one
          section's controls end and the next begins. */}
      {open && (
        <div className="px-3 pb-3 pt-1" style={{ background: 'var(--panel-2)' }}>
          {children}
        </div>
      )}
    </div>
  );
}

export function Toggle({
  label,
  checked,
  onChange,
  tip,
}: {
  label: ReactNode;
  checked: boolean;
  onChange: (v: boolean) => void;
  tip?: string;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-2 py-[3px] leading-tight" data-tip={tip}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </label>
  );
}

export function Select({
  value,
  onChange,
  children,
  className = '',
  tip,
}: {
  value: string;
  onChange: (v: string) => void;
  children: ReactNode;
  className?: string;
  tip?: string;
}) {
  return (
    <select
      className={`field w-full ${className}`}
      data-tip={tip}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      {children}
    </select>
  );
}

export function Labeled({ label, tip, children }: { label: string; tip?: string; children: ReactNode }) {
  return (
    <div className="mb-2">
      <div className="section-head mb-1" data-tip={tip}>
        {label}
      </div>
      {children}
    </div>
  );
}

// Two stacked sliders (min / max). Robust and clear; log-aware for skewed data.
export function DualRange({
  min,
  max,
  low,
  high,
  scale = 'linear',
  format,
  onChange,
}: {
  min: number;
  max: number;
  low: number;
  high: number;
  scale?: 'linear' | 'log';
  format: (v: number) => string;
  onChange: (low: number, high: number) => void;
}) {
  const STEPS = 1000;
  const logOk = scale === 'log' && min > 0 && max > 0;
  const toPos = (v: number) => {
    const t = logOk
      ? (Math.log(Math.max(min, v)) - Math.log(min)) / (Math.log(max) - Math.log(min))
      : (v - min) / (max - min || 1);
    return Math.round(Math.min(1, Math.max(0, t)) * STEPS);
  };
  const toVal = (p: number) => {
    const t = p / STEPS;
    return logOk ? Math.exp(Math.log(min) + t * (Math.log(max) - Math.log(min))) : min + t * (max - min);
  };
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        <span className="w-7 shrink-0 text-[10px]" style={{ color: 'var(--faint)' }}>
          min
        </span>
        <input
          type="range"
          className="flex-1"
          min={0}
          max={STEPS}
          value={toPos(low)}
          onChange={(e) => {
            const v = toVal(+e.target.value);
            onChange(Math.min(v, high), high);
          }}
        />
      </div>
      <div className="flex items-center gap-2">
        <span className="w-7 shrink-0 text-[10px]" style={{ color: 'var(--faint)' }}>
          max
        </span>
        <input
          type="range"
          className="flex-1"
          min={0}
          max={STEPS}
          value={toPos(high)}
          onChange={(e) => {
            const v = toVal(+e.target.value);
            onChange(low, Math.max(v, low));
          }}
        />
      </div>
      <div className="mono-num flex justify-between text-[11px]" style={{ color: 'var(--muted)' }}>
        <span>{format(low)}</span>
        <span>{format(high)}</span>
      </div>
    </div>
  );
}

export function Slider({
  min,
  max,
  step,
  value,
  onChange,
  tip,
}: {
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (v: number) => void;
  tip?: string;
}) {
  return (
    <input
      type="range"
      className="w-full"
      data-tip={tip}
      min={min}
      max={max}
      step={step}
      value={value}
      onChange={(e) => onChange(+e.target.value)}
    />
  );
}

export function Swatch({ color }: { color: string }) {
  return (
    <span
      className="inline-block h-[10px] w-[10px] shrink-0 border"
      style={{ background: color, borderColor: '#000' }}
    />
  );
}
