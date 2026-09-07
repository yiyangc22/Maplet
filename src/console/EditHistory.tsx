// The Edit History panel: a read-only, plain-language list of every action that
// CHANGED the visualization — loading data, snapping a view, sizing points,
// adding a panel, and so on. Actions that don't change what's on screen (a
// redundant deselect, re-snapping to the same plane, saving, exporting) never
// reach it. Click any row to revert the whole view to that point.
//
// Opens from Edit ▸ View edit history (or Enter); closes on Esc.

import { useEffect, useRef } from 'react';
import { useStore } from '../model/store';
import type { LogEntry } from '../model/store';
import type { Dataset } from '../format/maplet';

// Turn a canonical command into a short human phrase. Falls back to the raw
// command (already terse) for anything not special-cased.
function describe(e: LogEntry, ds: Dataset | null): string {
  const cmd = e.command ?? '';
  if (!cmd || cmd.includes(' — ')) return e.text; // load origin / lasso region: keep its text
  const t = cmd.split(/\s+/);
  const name = (key?: string) => (key && ds?.columnByKey.get(key)?.label) || key || '';
  switch (t[0]) {
    case 'open':
    case 'folder':
      return 'Loaded a data file';
    case 'sample':
      return 'Loaded sample data';
    case 'color':
      return t[1] === 'off' ? 'Color: uniform' : `Color by ${name(t[1])}`;
    case 'colormode':
      return `Color mode: ${t[1]}`;
    case 'colormap':
      return `Colormap · ${name(t[1])} → ${t[2]}`;
    case 'colorrange':
      return `Color range · ${name(t[1])}`;
    case 'size':
      return t[1] === 'off' ? 'Size: uniform' : `Size by ${name(t[1])}`;
    case 'sizerange':
      return `Size range · ${t[1]}–${t[2]}`;
    case 'filter':
      return t[1] === 'reset' ? 'Reset all filters' : `Filter · ${name(t[1])}`;
    case 'select':
      return t[1] === 'all' ? 'Selected all shown points' : t[1] === 'visible' ? 'Selected shown points' : 'Selected points';
    case 'deselect':
      return 'Cleared selection';
    case 'points':
      return t[1] === 'size' ? `Base point size · ${t[2]}` : `Point opacity · ${t[2]}`;
    case 'ghost':
      return t[1] === 'opacity' ? `Ghost opacity · ${t[2]}` : `Ghost points · ${t[1]}`;
    case 'axes':
      return `Axes · ${t[1]}`;
    case 'grid':
      return `Grid · ${t[1]}`;
    case 'blips':
      return `Update blips · ${t[1]}`;
    case 'images':
      return t[1] === 'opacity' ? `Overlay opacity · ${t[2]}` : `Image overlays · ${t[1]}`;
    case 'image':
      return `Image layers · ${t[1]}`;
    case 'labels':
      return t[1] === 'reset' ? 'Hid all labels' : 'Showed all labels';
    case 'traces':
      return t[1] === 'reset' ? 'Hid all traces' : 'Showed all traces';
    case 'label':
      return t[1] === 'sel' ? 'Labelled selection' : 'Cleared labels';
    case 'trace':
      return t[1] === 'sel' ? 'Traced selection' : 'Cleared traces';
    case 'view':
      if (t[1] === 'xy' || t[1] === 'xz' || t[1] === 'yz') return `Snapped to ${t[1].toUpperCase()} plane`;
      if (t[1] === 'ortho') return `Orthographic · ${t[2]}`;
      return `View · ${t.slice(1).join(' ')}`;
    case 'panel':
      if (t[1] === 'add') return 'Added a panel';
      if (t[1] === 'remove') return 'Removed a panel';
      if (t[1] === 'main') return 'Changed the main map';
      if (t[1] === 'view') return "Changed a panel's view";
      return 'Panel change';
    default:
      return cmd;
  }
}

export default function EditHistory({ open, onClose }: { open: boolean; onClose: () => void }) {
  const log = useStore((s) => s.log);
  const currentEntryId = useStore((s) => s.currentEntryId);
  const dataset = useStore((s) => s.dataset);
  const st = useStore();
  const listRef = useRef<HTMLDivElement>(null);

  // Only entries that actually changed the visualization carry a ViewState snapshot;
  // that's exactly the edit history (load + every revertible change).
  const entries = log.filter((e) => e.snapshot);

  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [entries.length, open]);

  if (!open) return null;

  return (
    <div
      className="absolute inset-x-0 bottom-0 z-40 flex flex-col border-t"
      style={{ height: '40%', background: 'rgba(6,6,6,0.97)', borderColor: 'var(--border-2)' }}
    >
      <div className="flex items-center gap-2 border-b px-3 py-1" style={{ borderColor: 'var(--border)' }}>
        <span className="section-head">edit history</span>
        <span className="text-[10px]" style={{ color: 'var(--faint)' }}>
          every change to the plot · click a row to revert · Esc closes
        </span>
        <div className="ml-auto flex items-center gap-1">
          <button className="btn py-[1px] text-[11px]" onClick={st.undo} data-tip="Undo (Ctrl+Z).">
            ↶ undo
          </button>
          <button className="btn py-[1px] text-[11px]" onClick={st.redo} data-tip="Redo (Ctrl+Shift+Z).">
            ↷ redo
          </button>
          <button className="btn py-[1px] text-[11px]" onClick={onClose}>
            close
          </button>
        </div>
      </div>

      <div ref={listRef} className="flex-1 overflow-y-auto px-2 py-2 text-[12px] leading-relaxed">
        {entries.length === 0 && <div style={{ color: 'var(--faint)' }}>No changes yet — adjust anything and it shows up here.</div>}
        {entries.map((e, i) => (
          <HistoryRow
            key={e.id}
            n={i + 1}
            text={describe(e, dataset)}
            current={e.id === currentEntryId}
            onClick={() => st.jumpTo(e.id)}
          />
        ))}
      </div>
    </div>
  );
}

function HistoryRow({ n, text, current, onClick }: { n: number; text: string; current: boolean; onClick: () => void }) {
  return (
    <button
      className="flex w-full items-baseline gap-2 rounded px-1 py-[2px] text-left hover:brightness-125"
      onClick={onClick}
      style={{
        color: current ? 'var(--text)' : 'var(--muted)',
        borderLeft: current ? '2px solid var(--accent)' : '2px solid transparent',
        paddingLeft: 6,
        background: current ? 'rgba(255,176,0,0.06)' : undefined,
      }}
      data-tip="Revert the whole view to this point."
    >
      <span className="mono-num shrink-0 text-[10px]" style={{ color: 'var(--faint)' }}>
        {n}
      </span>
      <span className="flex-1">{text}</span>
      {current && (
        <span className="shrink-0 text-[10px]" style={{ color: 'var(--accent)' }}>
          current
        </span>
      )}
    </button>
  );
}
