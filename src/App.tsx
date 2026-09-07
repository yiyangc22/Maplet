import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { useStore, type PanelTarget } from './model/store';
import { columnValueLabel } from './format/maplet';
import MapView from './viewer/Viewer3D';
import { viewports } from './viewer/controls';
import MenuBar from './panels/MenuBar';
import StatusBar from './panels/StatusBar';
import ColorControls from './panels/ColorControls';
import SizeControls from './panels/SizeControls';
import FilterPanel from './panels/FilterPanel';
import DisplayControls, { ImageControls } from './panels/DisplayControls';
import DetailsPanel from './panels/DetailsPanel';
import ExportDialog from './panels/ExportDialog';
import SavePresetDialog from './panels/SavePresetDialog';
import GlobalSearch from './panels/GlobalSearch';
import FrameScrubber from './panels/FrameScrubber';
import AssignmentModal from './panels/AssignmentModal';
import CapChoiceModal from './panels/CapChoiceModal';
import StructureNoticeModal from './panels/StructureNoticeModal';
import { PointDetails } from './panels/PointDetails';
import EditHistory from './console/EditHistory';
import TooltipLayer from './ui/Tooltip';
import { Section } from './ui/widgets';
import { doBrowse, doImagesUrl, doUrl, loadDropped, restorableSessionName, restoreLastSession } from './app/load';
import { startSessionAutosave } from './app/session';

let autoloaded = false;

export default function App() {
  const dataset = useStore((s) => s.dataset);
  const status = useStore((s) => s.status);
  const error = useStore((s) => s.error);
  const maps = dataset?.maps ?? []; // derive from the stable dataset ref, not a selector
  const hasNumeric = !!dataset?.columns.some((c) => c.kind === 'continuous'); // eligible for a histogram panel
  const hasImages = (dataset?.images.length ?? 0) > 0;
  // While a dataset is parsing, blank every panel and show "loading …" instead of the
  // stale/previous view (or the welcome screen).
  const loading = status === 'loading';
  const showData = !!dataset && !loading;
  const mainMap = useStore((s) => s.mainMap);
  const panels = useStore((s) => s.panels);
  const setMainMap = useStore((s) => s.setMainMap);
  const setPanelView = useStore((s) => s.setPanelView);
  const removePanel = useStore((s) => s.removePanel);
  const addPanel = useStore((s) => s.addPanel);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; viewportId: string } | null>(null);
  const [restoreName, setRestoreName] = useState<string | null>(null); // last dataset offered on the launch screen
  const rightDown = useRef<{ x: number; y: number } | null>(null);

  // A panel can be added when there's a second thing to show (another map, or a
  // numeric variable to histogram) and fewer than 3 panels are open.
  const canAddPanel = panels.length < 3 && (maps.length > 1 || hasNumeric);
  const showMainChooser = maps.length > 1 || hasNumeric;

  // Right-click over a specific viewport opens the context menu FOR THAT viewport
  // (so its camera / projection are adjusted alone). A right-drag past a few pixels
  // was a rotate, not a menu.
  const vpHandlers = (viewportId: string) => ({
    onPointerDown: (e: ReactPointerEvent) => {
      if (e.button === 2) rightDown.current = { x: e.clientX, y: e.clientY };
    },
    onContextMenu: (e: ReactMouseEvent) => {
      e.preventDefault();
      if (!useStore.getState().dataset) return;
      const d = rightDown.current;
      if (d && Math.hypot(e.clientX - d.x, e.clientY - d.y) > 6) return;
      setCtxMenu({ x: e.clientX, y: e.clientY, viewportId });
    },
  });
  const onMainChange = (t: PanelTarget) => {
    if (t.kind === 'map') setMainMap(t.index); // the main viewer only shows coordinate maps
  };

  useEffect(() => {
    if (autoloaded) return;
    autoloaded = true;
    startSessionAutosave();
    const params = new URLSearchParams(window.location.search);
    const points = params.get('points') || params.get('data');
    const images = params.get('images');
    if (points) {
      // An explicit deep-link still auto-loads.
      void (async () => {
        await doUrl(points);
        if (images) await doImagesUrl(images);
      })();
      return;
    }
    // Otherwise DON'T auto-load — show the launch screen so the user chooses. Just
    // find out whether the last dataset can be reopened (desktop), to offer it.
    void restorableSessionName().then(setRestoreName);
  }, []);

  // Reopen the last dataset from the launch screen; surface a clear error if it has
  // moved/been deleted so the user can just load it again.
  const onReopenLast = () => {
    setRestoreName(null);
    void restoreLastSession().then((ok) => {
      if (!ok) useStore.getState().setError('Could not reopen the last dataset — it may have moved. Load it again below.');
    });
  };

  // Global keys: Enter opens the edit history; Esc closes it (or clears selection);
  // Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y undo & redo.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const tag = t?.tagName;
      const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t?.isContentEditable === true;
      const isBtn = tag === 'BUTTON' || tag === 'A';
      const ctrl = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();

      if (ctrl && k === 'z') {
        e.preventDefault();
        if (e.shiftKey) useStore.getState().redo();
        else useStore.getState().undo();
        return;
      }
      if (ctrl && k === 'y') {
        e.preventDefault();
        useStore.getState().redo();
        return;
      }
      if (typing) return;
      if (e.key === 'Enter' && !isBtn) {
        e.preventDefault();
        if (!historyOpen) setHistoryOpen(true);
      } else if (e.key === 'Escape') {
        if (exportOpen) setExportOpen(false);
        else if (historyOpen) setHistoryOpen(false);
        else useStore.getState().clearSelection();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [historyOpen, exportOpen]);

  // Hold Shift to momentarily enable the lasso tool (release to exit). Shift only
  // ever turns lasso ON — it never turns off a lasso the user pinned via the menu.
  // (Ctrl is the add-to-selection modifier for clicks and lassos; see Viewer3D.)
  useEffect(() => {
    let engaged = false;
    const isTyping = (t: EventTarget | null) => {
      const el = t as HTMLElement | null;
      const tag = el?.tagName;
      return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el?.isContentEditable === true;
    };
    const engage = () => {
      const st = useStore.getState();
      if (engaged || !st.dataset || st.lassoMode) return;
      engaged = true;
      st.setLassoMode(true);
    };
    const disengage = () => {
      if (!engaged) return;
      engaged = false;
      useStore.getState().setLassoMode(false);
    };
    const onDown = (e: KeyboardEvent) => {
      if (e.key === 'Shift') {
        if (e.repeat || e.ctrlKey || e.metaKey || e.altKey || isTyping(e.target)) return;
        engage();
      } else if ((e.ctrlKey || e.metaKey) && engaged) {
        disengage(); // a Ctrl combo (e.g. Ctrl+Shift+Z) — drop the momentary lasso
      }
    };
    const onUp = (e: KeyboardEvent) => {
      if (e.key === 'Shift') disengage();
    };
    window.addEventListener('keydown', onDown);
    window.addEventListener('keyup', onUp);
    window.addEventListener('blur', disengage);
    return () => {
      window.removeEventListener('keydown', onDown);
      window.removeEventListener('keyup', onUp);
      window.removeEventListener('blur', disengage);
      disengage();
    };
  }, []);

  const dragDepth = useRef(0);

  return (
    <div
      className="flex h-full flex-col"
      onDragEnter={(e) => {
        e.preventDefault();
        dragDepth.current++;
        setDragOver(true);
      }}
      onDragOver={(e) => e.preventDefault()}
      onDragLeave={(e) => {
        e.preventDefault();
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) setDragOver(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        dragDepth.current = 0;
        setDragOver(false);
        const f = e.dataTransfer.files?.[0];
        if (f) loadDropped(f);
      }}
    >
      <MenuBar
        onToggleHistory={() => setHistoryOpen((o) => !o)}
        onOpenExport={() => setExportOpen(true)}
        onOpenSave={() => setSaveOpen(true)}
        onOpenSearch={() => setSearchOpen(true)}
      />

      <div className="relative flex min-h-0 flex-1">
        {showData && (
          <div className="w-[300px] shrink-0 overflow-y-auto border-r" style={{ borderColor: 'var(--border)', background: 'var(--panel)' }}>
            <Section title="Color by" tip="Pick the variable that colors the points, and its colormap or legend.">
              <ColorControls />
            </Section>
            <Section title="Size by" tip="Base dot size, and optionally scale each dot by a numeric variable.">
              <SizeControls />
            </Section>
            <FilterPanel />
            <Section title="Display" tip="Point opacity and how filtered-out points are shown.">
              <DisplayControls />
            </Section>
            {hasImages && (
              <Section title="Images" tip="Microscopy overlay layers loaded alongside the points.">
                <ImageControls />
              </Section>
            )}
          </div>
        )}

        <div className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
          <div className="relative min-h-0 flex-1" {...vpHandlers('main')}>
            {showData && <MapView key={`main-${mainMap}`} target={{ kind: 'map', index: mainMap }} isMain viewportId="main" />}
            {showData && showMainChooser && (
              <MapChooser target={{ kind: 'map', index: mainMap }} onChange={onMainChange} onAdd={addPanel} canAdd={canAddPanel} />
            )}
            <HoverTooltip />
            {!dataset && !loading && <Welcome error={status === 'error' ? error : null} restoreName={restoreName} onReopen={onReopenLast} />}
            {loading && <LoadingState />}
            {dragOver && <DropOverlay />}
            <ExportDialog open={exportOpen} onClose={() => setExportOpen(false)} />
          </div>
          {showData && panels.length > 0 && (
            <div className="flex shrink-0 border-t" style={{ height: 240, borderColor: 'var(--border)' }}>
              {panels.map((t, slot) => (
                <div
                  key={slot}
                  className="relative min-w-0 flex-1 border-r"
                  style={{ borderColor: 'var(--border)' }}
                  {...vpHandlers(`panel-${slot}`)}
                >
                  <MapView
                    key={`panel-${slot}-${t.kind}-${t.kind === 'map' ? t.index : t.key}`}
                    target={t}
                    viewportId={`panel-${slot}`}
                  />
                  <MapChooser target={t} onChange={(nt) => setPanelView(slot, nt)} allowVars onClose={() => removePanel(slot)} />
                </div>
              ))}
            </div>
          )}
          {showData && <FrameScrubber />}
        </div>

        {showData && (
          <div className="w-[320px] shrink-0 border-l" style={{ borderColor: 'var(--border)', background: 'var(--panel)' }}>
            <DetailsPanel />
          </div>
        )}
      </div>

      <StatusBar />
      <SavePresetDialog open={saveOpen} onClose={() => setSaveOpen(false)} />
      <GlobalSearch open={searchOpen} onClose={() => setSearchOpen(false)} />
      <EditHistory open={historyOpen} onClose={() => setHistoryOpen(false)} />
      <AssignmentModal />
      <CapChoiceModal />
      <StructureNoticeModal />
      <TooltipLayer />
      {ctxMenu && <ContextMenu x={ctxMenu.x} y={ctxMenu.y} viewportId={ctxMenu.viewportId} onClose={() => setCtxMenu(null)} />}
    </div>
  );
}

// Right-click menu for ONE viewport (the panel it opened over): selection + that
// panel's own camera / projection. A right-drag (rotate) is filtered out by the
// caller, so this opens only on a plain right-click. Plane-snaps and orthographic
// only apply to 3D panels, so they're hidden for the flat (2D / dot-plot) ones.
function ContextMenu({
  x,
  y,
  viewportId,
  onClose,
}: {
  x: number;
  y: number;
  viewportId: string;
  onClose: () => void;
}) {
  const st = useStore();
  const lassoMode = useStore((s) => s.lassoMode);
  const selCount = useStore((s) => s.selection.size);
  const log = useStore((s) => s.log);
  const cur = useStore((s) => s.currentEntryId);
  const ref = useRef<HTMLDivElement>(null);

  // The camera controls of the viewport this menu belongs to. (Scene overlays and
  // orthographic now live in the left panel's Display section, not this menu.)
  const vc = viewports.get(viewportId);
  const is3D = vc?.is3D() ?? false;

  const [openSub, setOpenSub] = useState<string | null>(null);

  const li = log.findIndex((e) => e.id === cur);
  const canUndo = li > 0 && log.slice(0, li).some((e) => e.snapshot);
  const canRedo = li >= 0 && log.slice(li + 1).some((e) => e.snapshot);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('mousedown', onDoc);
    window.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [onClose]);

  const W = 150;
  const SUBW = 184;
  const pos = { left: Math.min(x, window.innerWidth - W - 6), top: Math.min(y, window.innerHeight - 300) };
  const openRight = pos.left + W + SUBW <= window.innerWidth; // flyout side

  // A leaf action: runs and closes the whole menu. `active` shows a ☑/☐ box.
  const item = (label: string, onClick: () => void, opts?: { active?: boolean; disabled?: boolean }) => (
    <button
      className="flex w-full items-center gap-2 whitespace-nowrap px-3 py-[6px] text-left text-[12px] hover:bg-white hover:text-black disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-inherit"
      disabled={opts?.disabled}
      onClick={() => {
        onClick();
        onClose();
      }}
    >
      <span className="w-4 shrink-0 text-center" style={{ color: opts?.active ? 'var(--accent)' : 'var(--muted)' }}>
        {opts?.active === undefined ? '' : opts.active ? '☑' : '☐'}
      </span>
      <span className="flex-1">{label}</span>
    </button>
  );
  // A parent row that opens a flyout submenu on hover / click.
  const parent = (name: string, label: string, children: React.ReactNode) => (
    <div className="relative" onMouseEnter={() => setOpenSub(name)}>
      <button
        className="flex w-full items-center gap-2 whitespace-nowrap px-3 py-[6px] text-left text-[12px] hover:bg-white hover:text-black"
        onClick={() => setOpenSub((s) => (s === name ? null : name))}
      >
        <span className="w-4 shrink-0" />
        <span className="flex-1">{label}</span>
        <span style={{ color: 'var(--muted)' }}>▸</span>
      </button>
      {openSub === name && (
        <div className="panel absolute top-0 py-1" style={{ [openRight ? 'left' : 'right']: '100%', minWidth: SUBW, width: 'max-content', background: 'var(--panel-2)' }}>
          {children}
        </div>
      )}
    </div>
  );
  // A top-level leaf (undo/redo): closes any open flyout on hover.
  const topLeaf = (label: string, onClick: () => void, opts?: { active?: boolean; disabled?: boolean }) => (
    <div onMouseEnter={() => setOpenSub(null)}>{item(label, onClick, opts)}</div>
  );
  const sep = <div className="my-1 border-t" style={{ borderColor: 'var(--border)' }} />;
  // Snap: the MAIN viewer goes through the command system (logged + undoable); a
  // panel snaps its own transient camera directly.
  const snap = (p: 'xy' | 'xz' | 'yz') => (viewportId === 'main' ? st.snapView(p) : vc?.snapToPlane(p));

  return (
    <div ref={ref} className="panel fixed z-[60] py-1" style={{ ...pos, minWidth: W, width: 'max-content', background: 'var(--panel-2)' }}>
      {parent(
        'select',
        'Select',
        <>
          {item('Select all', () => st.selectAll())}
          {item('Lasso select', () => st.toggleLassoMode(), { active: lassoMode })}
          {item('Deselect all', () => st.clearSelection(), { disabled: selCount === 0 })}
        </>,
      )}
      {parent(
        'view',
        'View',
        <>
          {is3D && item('Snap to XY plane', () => snap('xy'))}
          {is3D && item('Snap to XZ plane', () => snap('xz'))}
          {is3D && item('Snap to YZ plane', () => snap('yz'))}
          {item('Fit all points', () => vc?.fit('all'))}
          {item('Fit shown points', () => vc?.fit('visible'))}
          {item('Reset view', () => vc?.resetView())}
        </>,
      )}
      {topLeaf('Hide non-selected points', () => st.setHideUnselected(!st.hideUnselected), {
        active: st.hideUnselected,
        disabled: selCount === 0 && !st.hideUnselected,
      })}
      {topLeaf('Hide all labels', () => st.hideAllLabels(), { disabled: !(st.settings.labelAll || st.labeledPoints.size > 0) })}
      {sep}
      {topLeaf('Undo', () => st.undo(), { disabled: !canUndo })}
      {topLeaf('Redo', () => st.redo(), { disabled: !canRedo })}
    </div>
  );
}

function HoverTooltip() {
  const hover = useStore((s) => s.hover);
  const dataset = useStore((s) => s.dataset);
  const colorKey = useStore((s) => s.colorKey);
  // When several points are selected, the right panel shows the summary, so the
  // hover card upgrades to FULL info; otherwise it shows a basic one-liner.
  const full = useStore((s) => s.selection.size > 1);
  const ref = useRef<HTMLDivElement>(null);
  const lastPos = useRef({ x: -2000, y: -2000 });

  const place = (x: number, y: number) => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth || 240;
    const h = el.offsetHeight || 40;
    el.style.left = `${Math.min(x + 14, window.innerWidth - w - 8)}px`;
    el.style.top = `${Math.min(y + 14, window.innerHeight - h - 8)}px`;
  };

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      lastPos.current = { x: e.clientX, y: e.clientY };
      place(e.clientX, e.clientY);
    };
    window.addEventListener('mousemove', onMove);
    return () => window.removeEventListener('mousemove', onMove);
  }, []);

  // Place the card at the last known cursor spot BEFORE the browser paints it, so
  // a newly-shown card never flashes at the top-left corner first.
  useLayoutEffect(() => {
    if (hover != null) place(lastPos.current.x, lastPos.current.y);
  });

  if (hover == null || !dataset) return null;
  const point = dataset.points[hover];
  const col = colorKey ? dataset.columnByKey.get(colorKey) : undefined;
  // The first ranked call (e.g. point type / barcode) — shown on the basic hover
  // card. Chosen by type + column order, not by variable name.
  const typeCol = dataset.columns.find((c) => c.kind === 'ranked');

  return (
    <div
      ref={ref}
      className={`panel pointer-events-none fixed z-30 overflow-hidden text-[11px] ${full ? 'w-[248px] p-2' : 'px-2 py-1'}`}
      style={{ background: 'var(--panel-2)', maxHeight: '62vh' }}
    >
      {full ? (
        <PointDetails dataset={dataset} index={hover} compact />
      ) : (
        <>
          <div style={{ color: 'var(--text)' }}>{point.id}</div>
          {typeCol && (
            <div className="mono-num" style={{ color: 'var(--muted)' }}>
              {typeCol.label}: {columnValueLabel(dataset, typeCol, hover)}
            </div>
          )}
          {col && col.key !== typeCol?.key && (
            <div className="mono-num" style={{ color: 'var(--muted)' }}>
              {col.label}: {columnValueLabel(dataset, col, hover)}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// Shown across the viewer area while a dataset parses: an empty dark panel with a
// small "loading …" label, so the user never sees the stale/previous view mid-load.
function LoadingState() {
  return (
    <div className="absolute inset-0 flex items-center justify-center" style={{ background: 'var(--bg)' }}>
      <span className="text-[12px] tracking-wide" style={{ color: 'var(--faint)' }}>
        loading …
      </span>
    </div>
  );
}

function Welcome({
  error,
  restoreName,
  onReopen,
}: {
  error: string | null;
  restoreName: string | null;
  onReopen: () => void;
}) {
  return (
    <div className="absolute inset-0 flex items-center justify-center p-6">
      <div className="panel max-w-lg p-6" style={{ background: 'var(--panel)' }}>
        <div className="mb-1 font-[700] tracking-wide">MAPLET VIEWER</div>
        <p className="mb-4 text-[12px] leading-relaxed" style={{ color: 'var(--muted)' }}>
          Interactive 3D viewer for spatial single-cell data. Load a <code>.csv</code> / <code>.tsv</code> (one row per
          point); the app asks you to map its columns to coordinates and variables. Color, filter, and select by any
          variable.
        </p>
        {error && (
          <div className="mb-4 border px-3 py-2 text-[12px]" style={{ borderColor: 'var(--bad)', color: 'var(--bad)' }}>
            {error}
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          {restoreName && (
            <button className="btn btn-active" onClick={onReopen} title={`Reopen ${restoreName} where you left off`}>
              Load last dataset
            </button>
          )}
          <button className="btn" onClick={() => void doBrowse(false)}>
            Load a dataset…
          </button>
        </div>
        {restoreName && (
          <p className="mt-2 truncate text-[11px]" style={{ color: 'var(--faint)' }} title={restoreName}>
            last: {restoreName}
          </p>
        )}
        <p className="mt-4 text-[11px]" style={{ color: 'var(--faint)' }}>
          or drag a .csv / .tsv onto the window · press Enter for the edit history
        </p>
      </div>
    </div>
  );
}

// The picker overlaying a viewport's top-left: a dropdown to choose what the panel
// shows — a coordinate map, or (bottom panels only, `allowVars`) a 1-D numeric
// variable as a histogram. The main viewer also gets a "+" to add a panel; the
// bottom panels get a "×" to close.
function MapChooser({
  target,
  onChange,
  allowVars = false,
  onAdd,
  canAdd = false,
  onClose,
}: {
  target: PanelTarget;
  onChange: (t: PanelTarget) => void;
  allowVars?: boolean;
  onAdd?: () => void;
  canAdd?: boolean;
  onClose?: () => void;
}) {
  const dataset = useStore((s) => s.dataset); // stable ref; derive lists outside the selector
  const maps = dataset?.maps ?? [];
  const vars = allowVars ? (dataset?.columns.filter((c) => c.kind === 'continuous') ?? []) : [];
  if (maps.length === 0) return null;
  const value = target.kind === 'map' ? `map:${target.index}` : `hist:${target.key}`;
  const onSelect = (v: string) => {
    if (v.startsWith('map:')) onChange({ kind: 'map', index: Number(v.slice(4)) });
    else if (v.startsWith('hist:')) onChange({ kind: 'hist', key: v.slice(5) });
  };
  return (
    <div className="absolute left-2 top-1 z-20 flex items-center gap-1">
      <select
        className="panel h-[22px] px-1 text-[10px] leading-none"
        style={{ background: 'var(--panel-2)', color: 'var(--text)', borderColor: 'var(--border)' }}
        value={value}
        onChange={(e) => onSelect(e.target.value)}
        title="What this panel shows"
      >
        {vars.length > 0 ? (
          <>
            <optgroup label="coordinate maps">
              {maps.map((m) => (
                <option key={`map:${m.index}`} value={`map:${m.index}`}>
                  {m.label}
                </option>
              ))}
            </optgroup>
            <optgroup label="variables (dot plot)">
              {vars.map((c) => (
                <option key={`hist:${c.key}`} value={`hist:${c.key}`}>
                  {c.label}
                </option>
              ))}
            </optgroup>
          </>
        ) : (
          maps.map((m) => (
            <option key={`map:${m.index}`} value={`map:${m.index}`}>
              {m.label}
            </option>
          ))
        )}
      </select>
      {onAdd && (
        <button
          className="btn flex h-[22px] w-[22px] items-center justify-center p-0 text-[15px] leading-none"
          onClick={onAdd}
          disabled={!canAdd}
          title="Add a panel below (up to 3)"
        >
          +
        </button>
      )}
      {onClose && (
        <button
          className="btn flex h-[22px] w-[22px] items-center justify-center p-0 text-[13px] leading-none"
          onClick={onClose}
          title="Close this panel"
        >
          ×
        </button>
      )}
    </div>
  );
}

function DropOverlay() {
  return (
    <div className="absolute inset-0 z-30 m-3 flex items-center justify-center border-2 border-dashed" style={{ borderColor: 'var(--accent)', background: 'rgba(255,176,0,0.05)' }}>
      <span style={{ color: 'var(--accent)' }}>drop a .csv / .tsv points or images sheet</span>
    </div>
  );
}
