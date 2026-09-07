// Timeline for a multi-frame (4D) dataset. Two modes, picked by the header token:
// DISCRETE (`frame`/`step`) steps through equal frames at an fps; CONTINUOUS
// (`time`/`t`) scrubs a real-valued cursor over the actual value range at a speed
// in units/sec. Either way positions HOLD between samples (no interpolation) — the
// viewer shows each point's most recent sample at or before `currentTime`. Renders
// nothing for a single-frame dataset.

import { useEffect, useState } from 'react';
import { useStore } from '../model/store';
import { formatNumber } from '../format/maplet';

export default function FrameScrubber() {
  const frameCount = useStore((s) => s.dataset?.frameCount ?? 1);
  const frames = useStore((s) => s.dataset?.frames);
  const continuous = useStore((s) => s.dataset?.continuousTime ?? false);
  const currentTime = useStore((s) => s.currentTime);
  const playing = useStore((s) => s.playing);
  const setTime = useStore((s) => s.setTime);
  const setPlaying = useStore((s) => s.setPlaying);
  const [fps, setFps] = useState(12);
  const [speed, setSpeed] = useState(0); // continuous units/sec; 0 = auto (~8 s per play)
  const [dir, setDir] = useState<1 | -1>(1);

  const tmin = frames?.[0] ?? 0;
  const tmax = frames?.[(frames?.length ?? 1) - 1] ?? 0;
  const range = Math.max(1e-9, tmax - tmin);
  const effSpeed = speed > 0 ? speed : range / 8;

  // Largest sample index with frames[k] <= t — the currently-shown frame.
  const indexAt = (t: number): number => {
    if (!frames) return 0;
    for (let j = frames.length - 1; j >= 0; j--) if (frames[j] <= t) return j;
    return 0;
  };

  // Playback clock. Continuous advances real time via rAF (smooth); discrete steps
  // the frame index at fps. Reads the store imperatively so it doesn't churn.
  useEffect(() => {
    if (!playing || frameCount <= 1 || !frames) return;
    if (continuous) {
      let raf = 0;
      let last = performance.now();
      const loop = () => {
        const now = performance.now();
        const dt = Math.min(0.05, (now - last) / 1000);
        last = now;
        const s = useStore.getState();
        let t = s.currentTime + dir * effSpeed * dt;
        if (t > tmax) t = tmin + ((t - tmin) % range);
        else if (t < tmin) t = tmax - ((tmax - t) % range);
        s.setTime(t);
        raf = requestAnimationFrame(loop);
      };
      raf = requestAnimationFrame(loop);
      return () => cancelAnimationFrame(raf);
    }
    const ms = 1000 / Math.max(1, Math.min(60, fps || 1));
    const id = setInterval(() => {
      const s = useStore.getState();
      const nk = (indexAt(s.currentTime) + dir + frameCount) % frameCount;
      s.setTime(frames[nk]);
    }, ms);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, frameCount, continuous, fps, effSpeed, dir, frames, tmin, tmax, range]);

  if (frameCount <= 1 || !frames) return null;

  // Each button plays its direction; clicking the one already playing pauses it.
  const press = (d: 1 | -1) => {
    if (playing && dir === d) setPlaying(false);
    else {
      setDir(d);
      setPlaying(true);
    }
  };
  const idx = indexAt(currentTime);

  return (
    <div className="flex shrink-0 items-center gap-2 border-t px-2 py-1" style={{ borderColor: 'var(--border)', background: 'var(--panel)' }}>
      <button
        className={`btn flex h-[22px] w-[22px] items-center justify-center p-0 text-[10px] leading-none ${playing && dir === -1 ? 'btn-active' : ''}`}
        onClick={() => press(-1)}
        title={playing && dir === -1 ? 'Pause' : 'Play backward'}
        data-tip="Play backward (click again to pause)"
      >
        ◀
      </button>
      <button
        className={`btn flex h-[22px] w-[22px] items-center justify-center p-0 text-[10px] leading-none ${playing && dir === 1 ? 'btn-active' : ''}`}
        onClick={() => press(1)}
        title={playing && dir === 1 ? 'Pause' : 'Play forward'}
        data-tip="Play forward (click again to pause)"
      >
        ▶
      </button>
      {continuous ? (
        <input
          type="range"
          min={tmin}
          max={tmax}
          step={range / 1000}
          value={currentTime}
          onChange={(e) => {
            setPlaying(false);
            setTime(+e.target.value);
          }}
          className="min-w-0 flex-1 accent-[var(--accent)]"
          aria-label="time"
        />
      ) : (
        <input
          type="range"
          min={0}
          max={frameCount - 1}
          step={1}
          value={idx}
          onChange={(e) => {
            setPlaying(false);
            setTime(frames[+e.target.value]);
          }}
          className="min-w-0 flex-1 accent-[var(--accent)]"
          aria-label="frame"
        />
      )}
      {/* rate + readout: a fixed-width block so it never grows with the slider. */}
      <div className="flex shrink-0 items-center justify-end gap-2" style={{ width: 176, color: 'var(--muted)' }}>
        {continuous ? (
          <label className="flex items-center gap-1 text-[10px]" title="Playback speed (time units per second)">
            <input
              type="number"
              min={0}
              step="any"
              value={Number(effSpeed.toPrecision(3))}
              onChange={(e) => setSpeed(Math.max(0, +e.target.value || 0))}
              className="field mono-num px-1 py-0 text-[10px]"
              style={{ width: 60 }}
              aria-label="time units per second"
            />
            /s
          </label>
        ) : (
          <label className="flex items-center gap-1 text-[10px]" title="Playback speed (frames per second)">
            <input
              type="number"
              min={1}
              max={60}
              value={fps}
              onChange={(e) => setFps(Math.max(1, Math.min(60, Math.round(+e.target.value) || 1)))}
              className="field mono-num px-1 py-0 text-[10px]"
              style={{ width: 48 }}
              aria-label="frames per second"
            />
            fps
          </label>
        )}
        <span className="mono-num tabular-nums text-[10px]" style={{ width: 96, textAlign: 'right' }}>
          {continuous ? `t=${formatNumber(currentTime)}` : `${formatNumber(frames[idx])} · ${idx + 1}/${frameCount}`}
        </span>
      </div>
    </div>
  );
}
