// A value histogram: one bar per distinct value, in the order the values first
// appear in the file (a Map preserves insertion order), bar height = how many
// points carry that value. Shared by the identifier filter (left panel) and by a
// map panel showing a 1-D numeric variable. Hovering a bar shows its value +
// count. Drawn on a canvas so thousands of bars stay cheap, and the x axis is
// intentionally unlabelled (there can be thousands of values).

import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';

export interface HistogramData {
  arr: [string, number][]; // [value label, count], in first-appearance order
  max: number;
}

// Tally distinct values in first-appearance order. `valueAt(i)` returns the
// display string for point i, or null when the point has no value.
export function firstAppearanceHistogram(n: number, valueAt: (i: number) => string | null): HistogramData {
  const m = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    const v = valueAt(i);
    if (v == null || v === '') continue;
    m.set(v, (m.get(v) ?? 0) + 1);
  }
  const arr = [...m.entries()];
  return { arr, max: Math.max(1, ...arr.map((e) => e[1])) };
}

// A one-line readout (hovered value + count, else distinct-count + "frequency")
// above a canvas of thin bars that fills the remaining height. Fills its parent
// box, so the caller controls the size (a fixed strip in the filter panel, the
// whole viewport in a map panel).
export function HistogramView({ data }: { data: HistogramData }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [hover, setHover] = useState<{ i: number; x: number } | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const accent = getComputedStyle(canvas).getPropertyValue('--accent').trim() || '#ffb000';
    const draw = () => {
      const W = wrap.clientWidth || 260;
      const H = wrap.clientHeight || 66;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
      canvas.style.width = `${W}px`;
      canvas.style.height = `${H}px`;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      const n = data.arr.length;
      if (n === 0) return;
      const barW = W / n;
      ctx.fillStyle = accent;
      for (let i = 0; i < n; i++) {
        const h = Math.max(1, (data.arr[i][1] / data.max) * (H - 3));
        ctx.fillRect(i * barW, H - h, Math.max(0.75, barW * 0.9), h);
      }
    };
    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [data]);

  const onMove = (e: ReactMouseEvent<HTMLDivElement>) => {
    const wrap = wrapRef.current;
    if (!wrap || data.arr.length === 0) return;
    const rect = wrap.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const i = Math.max(0, Math.min(data.arr.length - 1, Math.floor((x / rect.width) * data.arr.length)));
    setHover({ i, x });
  };

  const hv = hover ? data.arr[hover.i] : null;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="mb-1 flex items-baseline justify-between gap-2 text-[11px]">
        <span className="min-w-0 truncate" style={{ color: 'var(--muted)' }}>
          {hv ? (
            <span className="mono-num" style={{ color: 'var(--text)' }} title={hv[0]}>
              {hv[0]}
            </span>
          ) : (
            <>
              <span className="mono-num" style={{ color: 'var(--text)' }}>
                {data.arr.length.toLocaleString()}
              </span>{' '}
              distinct values
            </>
          )}
        </span>
        <span className="mono-num shrink-0" style={{ color: 'var(--faint)' }}>
          {hv ? hv[1].toLocaleString() : 'frequency'}
        </span>
      </div>
      <div ref={wrapRef} className="relative min-h-0 flex-1" onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
        <canvas ref={canvasRef} className="block" />
        {hover && (
          <div className="pointer-events-none absolute bottom-0 top-0 w-px" style={{ left: hover.x, background: 'var(--text)', opacity: 0.55 }} />
        )}
      </div>
    </div>
  );
}
