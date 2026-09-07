// Right sidebar. Nothing selected → hint. One point → full detail. Multiple →
// a selection summary (composition pie, averages). Plus selection actions.

import { useMemo } from 'react';
import { useStore } from '../model/store';
import type { Dataset } from '../format/maplet';
import { PointDetails } from './PointDetails';
import SelectionSummary from './SelectionSummary';

const posKey = (c: readonly number[]) => `${c[0]}|${c[1]}|${c[2] ?? 0}`;

/** Index of every point grouped by exact position in the primary map — many
 * points can share a submask. */
function useCoLocated(dataset: Dataset | null) {
  return useMemo(() => {
    const m = new Map<string, number[]>();
    if (!dataset) return m;
    const pm = dataset.primaryMap;
    for (let i = 0; i < dataset.n; i++) {
      const p = dataset.points[i].coords[pm];
      if (!p) continue;
      const k = posKey(p);
      const at = m.get(k);
      if (at) at.push(i);
      else m.set(k, [i]);
    }
    return m;
  }, [dataset]);
}

export default function DetailsPanel() {
  const dataset = useStore((s) => s.dataset);
  const primary = useStore((s) => s.primary);
  const selection = useStore((s) => s.selection);
  const visible = useStore((s) => s.visible);
  const frameSelection = useStore((s) => s.frameSelection);
  const colorSelect = useStore((s) => s.colorSelect);
  const labeledPoints = useStore((s) => s.labeledPoints);
  const tracedPoints = useStore((s) => s.tracedPoints);
  const toggleLabelSelection = useStore((s) => s.toggleLabelSelection);
  const toggleTraceSelection = useStore((s) => s.toggleTraceSelection);
  const hasFrames = useStore((s) => (s.dataset?.frameCount ?? 1) > 1);
  const coLocated = useCoLocated(dataset);
  if (!dataset) return null;

  const multi = selection.size > 1;
  // A toggle reads "on" when the whole current selection is already labelled / traced.
  const selArr = [...selection];
  const labelOn = selArr.length > 0 && selArr.every((i) => labeledPoints.has(i));
  const traceOn = selArr.length > 0 && selArr.every((i) => tracedPoints.has(i));
  const primaryPos = primary != null ? dataset.points[primary].coords[dataset.primaryMap] : undefined;
  const hereAll = primaryPos ? coLocated.get(posKey(primaryPos)) ?? [] : [];
  // The filters (min confidence, etc.) apply here too — don't offer to pick a point
  // the current filters have hidden. Keep the selected point itself regardless.
  const here = visible ? hereAll.filter((i) => visible[i] === 1 || i === primary) : hereAll;

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 overflow-y-auto">
        {multi ? (
          <SelectionSummary dataset={dataset} selection={selection} />
        ) : primary != null ? (
          <div className="px-3 py-3">
            {here.length > 1 && <CoLocatedPicker dataset={dataset} here={here} primary={primary} />}
            <PointDetails dataset={dataset} index={primary} />
          </div>
        ) : (
          <div className="px-3 py-4 text-[12px] leading-relaxed" style={{ color: 'var(--muted)' }}>
            Click a point to inspect it; shift-click adds. Use <b>same color</b> below to grab a cluster, or <b>lasso</b>{' '}
            to select a region.
          </div>
        )}
      </div>
      <div className="border-t px-3 py-2" style={{ borderColor: 'var(--border)' }}>
        <div className="mb-2 flex items-center justify-between text-[11px]" style={{ color: 'var(--muted)' }}>
          <span>selected</span>
          <span className="mono-num" style={{ color: 'var(--text)' }}>
            {selection.size.toLocaleString()}
          </span>
        </div>
        <div className="flex flex-wrap gap-1">
          <button
            className="btn flex-1 text-[11px]"
            disabled={primary == null}
            onClick={() => primary != null && colorSelect(primary, false)}
            data-tip="Select all points the same color as the current point (e.g. its cluster)."
          >
            same color
          </button>
          <button
            className={`btn flex-1 text-[11px] ${labelOn ? 'btn-active' : ''}`}
            disabled={selection.size === 0}
            onClick={toggleLabelSelection}
            data-tip="Show/hide a grey name label above the selected points. Persists after you deselect."
          >
            {labelOn ? '☑' : '☐'} label
          </button>
          {hasFrames && (
            <button
              className={`btn flex-1 text-[11px] ${traceOn ? 'btn-active' : ''}`}
              disabled={selection.size === 0}
              onClick={toggleTraceSelection}
              data-tip="Show/hide the highlighted trace (path across frames) for the selected points. Persists after you deselect."
            >
              {traceOn ? '☑' : '☐'} trace
            </button>
          )}
          <button className="btn flex-1 text-[11px]" onClick={frameSelection} data-tip="Zoom the 3D camera to the selected points.">
            frame
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Several points can decode to the same submask, so a click there is ambiguous —
 * list them and let the user say which one they meant.
 */
function CoLocatedPicker({ dataset, here, primary }: { dataset: Dataset; here: number[]; primary: number }) {
  const selectOnly = useStore((s) => s.selectOnly);
  return (
    <div className="mb-3 border p-2" style={{ borderColor: 'var(--accent)' }}>
      <div className="section-head mb-1" style={{ color: 'var(--accent)' }}>
        {here.length} points at this location
      </div>
      <div className="mb-1 text-[11px] leading-snug" style={{ color: 'var(--muted)' }}>
        They share one submask. Pick the one you meant.
      </div>
      <div className="max-h-40 space-y-[2px] overflow-y-auto pr-1">
        {here.map((i) => (
          <button
            key={i}
            className={`btn w-full truncate text-left text-[11px] ${i === primary ? 'btn-active' : ''}`}
            onClick={() => selectOnly(i)}
            title={dataset.points[i].id}
          >
            {dataset.points[i].id}
          </button>
        ))}
      </div>
    </div>
  );
}
