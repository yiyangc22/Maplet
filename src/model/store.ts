// Central app state (zustand). Every adjustment goes through dispatch(command):
// the command mutates a ViewState, the store snapshots it into the log, and
// undo / redo / click-to-revert (and the edit-history panel) walk those
// snapshots. A command that changes nothing is dropped, so no dead steps pile up.

import { create } from 'zustand';
import type { Column, Dataset } from '../format/maplet';
import { hasCategoryOverflow, parseRawMaplet, rebuildColumnAs } from '../format/maplet';
import { parseDatasetAsync } from '../format/parseAsync';
import {
  assignmentFromInspect,
  CELL_CAP,
  countDataLines,
  headText,
  inspectTable,
  type Assignment,
  type ColumnInspect,
} from '../../shared/table';
import type { ImageLayer, RawMaplet } from '../../shared/types';
import { computeColors, computeSizes, computeVisible, type Filter } from './derive';
import {
  defaultViewState,
  filtersFromSerial,
  filtersToSerial,
  viewStatesEqual,
  type PanelTarget,
  type ViewerSettings,
  type ViewState,
} from './viewstate';
import { C, HELP_LINES, parseCommand, type CommandCtx } from './commands';
import { viewerControls } from '../viewer/controls';
import type { ExportOptions } from '../viewer/controls';
import type { SavedBundle, SavedCamera, SavedData, SavedView } from './preset';

export interface LogEntry {
  id: number;
  ts: number;
  level: 'info' | 'ok' | 'warn' | 'error' | 'cmd';
  text: string;
  command?: string;
  snapshot?: ViewState;
  // A camera-only command (snap-to-plane) doesn't change the ViewState, so it
  // records the main-viewer camera before/after so undo/redo can restore the pose.
  cameraBefore?: SavedCamera;
  cameraAfter?: SavedCamera;
}

// What a bottom panel shows: either a coordinate map (2D/3D scatter) or a 1-D
// numeric variable (a value histogram). The main viewer is always a map. Defined
// in viewstate (the layout is part of the undoable ViewState); re-exported here
// for the many panels that import it from the store.
export type { PanelTarget };

export type AppStatus = 'empty' | 'loading' | 'ready' | 'error';
const MAX_LOG = 1000;

interface StoreState {
  dataset: Dataset | null;
  source: string | null;
  status: AppStatus;
  error: string | null;

  // ergonomic runtime view fields (panels read these)
  colorKey: string | null;
  rankedMode: 'label' | 'confidence';
  colormaps: Map<string, string>;
  domains: Map<string, [number, number]>;
  filters: Map<string, Filter>;
  selection: Set<number>;
  primary: number | null;
  settings: ViewerSettings;

  // "Size by" a numeric variable (saved in the ViewState, like colorKey). `sizes`
  // is the derived per-point size multiplier the viewer reads; `sizeDomain` is the
  // value range that maps to the min/max dot size (values outside floor/ceil).
  sizeKey: string | null;
  sizeDomain: [number, number] | null;
  sizes: Float32Array | null;
  // Persistent per-point name labels / highlighted traces (saved in the ViewState;
  // independent of the live selection). The global "all visible" toggles live in
  // settings (showTraces / labelAll).
  labeledPoints: Set<number>;
  tracedPoints: Set<number>;
  setSizeKey(key: string | null): void;
  setSizeDomain(range: [number, number]): void;
  toggleLabelSelection(): void; // label ⇄ the current selection (persistent)
  toggleTraceSelection(): void; // trace ⇄ the current selection (persistent)
  showAllLabels(): void; // label every visible point
  hideAllLabels(): void; // clear every label (global + per-point)
  showAllTraces(): void; // trace every visible point
  hideAllTraces(): void; // clear every trace (global + per-point)

  // derived arrays for the viewer
  colors: Float32Array | null;
  visible: Uint8Array | null;
  visibleCount: number;
  selectedMask: Uint8Array | null;

  // What each viewport shows (transient, not undoable). The main viewer shows the
  // coordinate map `mainMap`; up to 3 bottom panels show `panels[…]`, each a map
  // OR a 1-D numeric-variable histogram.
  mainMap: number;
  panels: PanelTarget[];
  setMainMap(index: number): void;
  setPanelView(slot: number, target: PanelTarget): void;
  addPanel(): void;
  removePanel(slot: number): void;

  selectedImages: Set<number>; // transient highlight (not undoable)
  hover: number | null;
  // Multi-frame (4D) playback — transient view state (not undoable). `currentTime`
  // is a REAL value on dataset.frames' scale (a frame value in discrete mode, any
  // real time in continuous mode); the viewer holds each point at its most recent
  // sample ≤ currentTime (no interpolation).
  currentTime: number;
  playing: boolean;
  setTime(t: number): void;
  setPlaying(on: boolean): void;
  pendingCamera: SavedCamera | null; // a camera pose to apply when the viewer next mounts (preset/session restore)
  // Load-time column assignment: when set, the assignment modal is shown so the user
  // maps every column to id / a coordinate axis (up to 4 maps) / numerical /
  // categorical / ignore, then confirms. Shown on every raw-table load. null when no
  // load is awaiting confirmation.
  assignPrompt: { columns: ColumnInspect[]; proposal: Assignment; rowCount: number; sourceName: string } | null;
  confirmAssignment(a: Assignment): void; // build + install the dataset with this assignment
  cancelAssignment(): void; // abort the pending load

  // When a load has more rows than the cap, holds the (true) row count while the loader
  // waits for the user to choose. null = no prompt pending. resolveCapPrompt is the
  // modal's callback: 'head' = first N, 'all' = full dataset, null = cancel. `oversize`
  // means the file was read as a prefix (too big to hold whole), so 'all' isn't offered.
  capPrompt: { rows: number; cap: number; oversize?: boolean } | null;
  resolveCapPrompt(method: 'head' | 'all' | null): void;

  // Set when a file couldn't be recognized as a table (empty, not delimited, or too few
  // columns). A friendly modal asks the user to check the file. null = no notice.
  structureNotice: { name: string } | null;
  dismissStructureNotice(): void;

  // activity log (drives the edit-history panel + undo/redo)
  log: LogEntry[];
  currentEntryId: number;

  // --- generic ---
  dispatch(command: string): void;
  snapView(plane: 'xy' | 'xz' | 'yz'): void; // snap the MAIN camera to a plane — logged + undoable
  undo(): void;
  redo(): void;
  jumpTo(entryId: number): void;
  canUndo(): boolean;
  canRedo(): boolean;

  loadRaw(raw: RawMaplet, origin?: string): void; // `origin` = the re-typable command shown in the log (e.g. "open")
  // Two-phase load: inspect the table, (prompt the cap), then the assignment modal; on
  // confirm, worker-parses large tables (else inline) and applies. `opts.prompt: false`
  // skips the modal and auto-detects the structure (bundle reload / session restore).
  loadRawAsync(raw: RawMaplet, origin?: string, opts?: { prompt?: boolean; assignment?: Assignment }): Promise<void>;
  buildSavedView(): SavedView; // full serialisable snapshot (view + layout + camera) for a preset / session
  buildBundle(): SavedBundle | null; // like buildSavedView, but embeds the whole dataset (standalone); null if unbundlable
  applySavedView(v: SavedView): void; // restore a preset onto the current dataset

  // The file the current visualization is bound to (drives smart "Save"), and a
  // snapshot of the view at the last save/load (drives "Reset to last save").
  currentFile: { name: string; kind: 'perspective' | 'bundle' } | null;
  lastSavedView: SavedView | null;
  bindFile(file: { name: string; kind: 'perspective' | 'bundle' } | null): void; // record the current view as the saved baseline + which file it's bound to
  resetToLastSave(): void; // discard unsaved edits, back to the last saved/loaded state
  addImages(images: ImageLayer[], source?: string): void; // merge overlay layers from a separate images sheet
  setLoading(): void;
  setError(msg: string): void;
  logMsg(level: LogEntry['level'], msg: string): void;
  clearLog(): void;

  // --- named wrappers used by the GUI (each builds + dispatches a command) ---
  setColorKey(key: string | null): void;
  setVariableType(key: string, type: 'grad' | 'cat'): void; // re-type a variable at runtime (numerical <-> categorical; rebuilds that column)
  setRankedMode(m: 'label' | 'confidence'): void;
  setColormap(key: string, name: string): void;
  setColorDomain(key: string, d: [number, number]): void;
  setContinuousRange(key: string, min: number, max: number): void;
  toggleCategory(key: string, value: string): void; // toggle one value in/out of the filter
  isolateCategory(key: string, value: string): void; // show ONLY this value (legend double-click)
  setAllCategories(key: string, enabled: boolean): void;
  setRankedMinConf(key: string, v: number): void;
  setIncludeMissing(key: string, include: boolean): void;
  resetFilter(key: string): void;
  resetAllFilters(): void;
  selectOnly(i: number): void;
  toggleSelect(i: number): void;
  clearSelection(): void;
  selectVisible(): void;
  selectAll(): void;
  // When on, only the current selection stays visible (the rest ghost/hide like a
  // filtered-out point); no-op with an empty selection so it never blanks the view.
  hideUnselected: boolean;
  setHideUnselected(on: boolean): void;

  setPointSize(v: number): void;
  setPointOpacity(v: number): void;
  setGhost(on: boolean): void;
  setGhostOpacity(v: number): void;
  setAxes(on: boolean): void;
  setGrid(on: boolean): void;
  setBlips(on: boolean): void;
  setImages(on: boolean): void;
  setImageOpacity(v: number): void;
  hideImages(idxs: number[]): void;
  showImages(idxs: number[]): void;
  toggleImage(i: number): void;
  imagesOnly(idxs: number[]): void;

  resetView(): void;
  frameSelection(): void;
  fitView(scope: 'all' | 'visible'): void;
  setOrthographic(on: boolean): void;
  exportImage(opts: ExportOptions): void;

  // transient (not commands)
  toggleImageSelect(i: number, additive: boolean): void;
  clearImageSelect(): void;
  setHover(i: number | null): void;

  lassoMode: boolean; // draw a boundary to select points within
  setLassoMode(on: boolean): void;
  toggleLassoMode(): void;
  colorSelect(i: number, additive: boolean): void;
  commitSelection(indices: number[], additive: boolean): void; // undoable raw selection (used by lasso)
}

let idCounter = 1;
const nextId = () => idCounter++;

function maskFrom(n: number, sel: Set<number>): Uint8Array {
  const m = new Uint8Array(n);
  for (const i of sel) if (i >= 0 && i < n) m[i] = 1;
  return m;
}

// "Hide non-selected": intersect the filter visibility with the selection. Mutates
// the (freshly built) visible array in place. A no-op when off or nothing is
// selected — so clearing the selection restores the full view instead of blanking it.
function maskUnselected(
  n: number,
  visible: Uint8Array,
  count: number,
  selection: Set<number>,
  on: boolean,
): { visible: Uint8Array; count: number } {
  if (!on || selection.size === 0) return { visible, count };
  let c = 0;
  for (let i = 0; i < n; i++) {
    if (!visible[i]) continue;
    if (selection.has(i)) c++;
    else visible[i] = 0;
  }
  return { visible, count: c };
}

// Two camera poses count as "the same" when position, target and up all match
// within a small relative epsilon — used to tell a real snap from a no-op re-snap
// (snapping to the plane you're already on). Any non-finite value is treated as
// "changed" so a degenerate pose is never silently swallowed.
function sameCamera(a: SavedCamera, b: SavedCamera): boolean {
  const all = [...a.position, ...a.target, ...a.up, ...b.position, ...b.target, ...b.up];
  if (all.some((v) => !Number.isFinite(v))) return false;
  const scale = Math.max(1, Math.hypot(...a.position), Math.hypot(...b.position));
  const near = (u: number[], v: number[]) => u.every((x, i) => Math.abs(x - v[i]) <= scale * 1e-4);
  return near(a.position, b.position) && near(a.target, b.target) && near(a.up, b.up);
}

export const useStore = create<StoreState>((set, get) => {
  const ctx: CommandCtx = { viewer: viewerControls };
  // The raw bytes of the currently-loaded dataset, kept so "Save standalone" can
  // embed the whole thing (works even after the original file is deleted).
  let sourceRaw: SavedData | null = null;
  // Resolver for the pending row-cap prompt (see loadRawAsync + resolveCapPrompt).
  let capResolver: ((m: 'head' | 'all' | null) => void) | null = null;
  // Resolver for the pending column-assignment modal (see loadRawAsync + confirm/cancelAssignment).
  let assignResolver: ((a: Assignment | null) => void) | null = null;

  const pushLog = (level: LogEntry['level'], text: string) =>
    set((s) => ({ log: [...s.log, { id: nextId(), ts: Date.now(), level, text }].slice(-MAX_LOG) }));

  const snapshot = (): ViewState => {
    const s = get();
    return {
      colorKey: s.colorKey,
      sizeKey: s.sizeKey,
      sizeDomain: s.sizeDomain,
      rankedMode: s.rankedMode,
      colormaps: Object.fromEntries(s.colormaps),
      domains: Object.fromEntries(s.domains) as Record<string, [number, number]>,
      filters: filtersToSerial(s.filters),
      selection: [...s.selection],
      primary: s.primary,
      labeledPoints: [...s.labeledPoints],
      tracedPoints: [...s.tracedPoints],
      settings: { ...s.settings, hiddenImages: [...s.settings.hiddenImages] },
      layout: { mainMap: s.mainMap, panels: s.panels.map((t) => ({ ...t })) },
    };
  };

  const applyViewState = (vs: ViewState) => {
    const ds = get().dataset;
    if (!ds) return;
    const colormaps = new Map(Object.entries(vs.colormaps));
    const domains = new Map(Object.entries(vs.domains)) as Map<string, [number, number]>;
    const filters = filtersFromSerial(vs.filters);
    const selection = new Set(vs.selection);
    // Default the multi-frame fields so older presets (without them) still load.
    const settings: ViewerSettings = {
      ...vs.settings,
      hiddenImages: [...vs.settings.hiddenImages],
      showTraces: vs.settings.showTraces ?? false,
      labelAll: vs.settings.labelAll ?? false,
      showBlips: vs.settings.showBlips ?? false,
    };
    const sizeKey = vs.sizeKey ?? null;
    const sizeDomain = vs.sizeDomain ?? null;
    const colors = computeColors(ds, { key: vs.colorKey, rankedMode: vs.rankedMode, colormaps, domains });
    const base = computeVisible(ds, filters);
    const { visible, count } = maskUnselected(ds.n, base.visible, base.count, selection, get().hideUnselected);
    // Restore the panel layout too, but only when the snapshot carries one (older
    // presets / the initial default don't — they leave the live layout untouched).
    const layout = vs.layout
      ? {
          mainMap: ds.maps.some((m) => m.index === vs.layout!.mainMap) ? vs.layout!.mainMap : ds.primaryMap,
          panels: vs.layout!.panels
            .filter((t) => (t.kind === 'map' ? ds.maps.some((m) => m.index === t.index) : ds.columnByKey.get(t.key)?.kind === 'continuous'))
            .slice(0, 3),
        }
      : null;
    set({
      colorKey: vs.colorKey,
      sizeKey,
      sizeDomain,
      sizes: computeSizes(ds, sizeKey, sizeDomain),
      rankedMode: vs.rankedMode,
      colormaps,
      domains,
      filters,
      selection,
      primary: vs.primary,
      labeledPoints: new Set(vs.labeledPoints ?? []),
      tracedPoints: new Set(vs.tracedPoints ?? []),
      settings,
      colors,
      visible,
      visibleCount: count,
      selectedMask: maskFrom(ds.n, selection),
      ...(layout ? { mainMap: layout.mainMap, panels: layout.panels } : {}),
    });
  };

  // Install a freshly-built (or worker-built) Dataset as the live one: reset the
  // view, auto-open panels, and log the origin command. Shared by the sync loadRaw
  // and the async (worker) loadRawAsync.
  const applyDataset = (ds: Dataset, raw: RawMaplet, origin: string) => {
    // Keep the raw bytes so a standalone bundle can embed them later — but NOT for a
    // very large table (that would pin ~gigabytes just in case; bundling one instead
    // prompts the user to reopen the file).
    const tableBytes = raw.pointsTable?.length ?? 0;
    sourceRaw = {
      pointsTable: tableBytes > 50_000_000 ? null : (raw.pointsTable ?? null),
      pointsJsonl: raw.pointsJsonl ?? null,
      manifestJson: raw.manifestJson,
    };
    const vs = defaultViewState(ds);
    set({
      dataset: ds,
      source: ds.source,
      status: 'ready',
      error: null,
      hover: null,
      currentTime: ds.frames[0] ?? 0, // start a fresh dataset at the first sample time
      playing: false,
      selectedImages: new Set(),
      pendingCamera: null, // default framing unless a preset/session restore sets one
      assignPrompt: null, // the assignment modal (if any) is resolved before we get here
      lassoMode: false, // don't carry an active lasso into a freshly opened dataset
      hideUnselected: false, // and don't carry a "show selected only" isolate either
      // Main viewer shows the primary map; auto-open a bottom panel for each
      // additional coordinate map (up to 3), e.g. a UMAP alongside the tissue.
      mainMap: ds.primaryMap,
      panels: ds.maps
        .filter((m) => m.index !== ds.primaryMap)
        .slice(0, 3)
        .map((m) => ({ kind: 'map' as const, index: m.index })),
      log: [],
      currentEntryId: -1,
    });
    applyViewState(vs);
    const id = nextId();
    // Snapshot the LIVE state (includes the auto-opened panel layout) so reverting
    // all the way back restores the initial view exactly.
    set({
      log: [{ id, ts: Date.now(), level: 'cmd', text: origin, command: origin, snapshot: snapshot() }],
      currentEntryId: id,
    });
    pushLog(
      'ok',
      `Loaded "${ds.meta.name}" — ${ds.n.toLocaleString()} points, ${ds.columns.length} variables${ds.images.length ? `, ${ds.images.length} image layers` : ''}.`,
    );
    for (const w of ds.warnings) pushLog('warn', w);
  };

  const pushCmd = (command: string, snap?: ViewState) => {
    const id = nextId();
    const entry: LogEntry = { id, ts: Date.now(), level: 'cmd', text: command, command, snapshot: snap };
    set((s) => ({ log: [...s.log, entry].slice(-MAX_LOG) }));
    if (snap) set({ currentEntryId: id });
    return id;
  };

  const currentIdx = () => {
    const s = get();
    return s.log.findIndex((e) => e.id === s.currentEntryId);
  };

  // Continuous adjustments (slider drags) fire many commands; collapse a run of
  // them into a single history entry so one drag = one undo step.
  const coalesceKey = (command: string): string | null => {
    const t = command.split(/\s+/);
    if (t[0] === 'points' && (t[1] === 'size' || t[1] === 'opacity')) return `points ${t[1]}`;
    if (t[0] === 'ghost' && t[1] === 'opacity') return 'ghost opacity';
    if (t[0] === 'images' && t[1] === 'opacity') return 'images opacity';
    if (t[0] === 'colorrange') return `colorrange ${t[1]}`;
    if (t[0] === 'sizerange') return 'sizerange';
    if (t[0] === 'filter' && (t[2] === 'range' || t[2] === 'conf' || t[2] === 'match')) return `filter ${t[1]} ${t[2]}`;
    return null;
  };

  const dispatch = (command: string) => {
    const ds = get().dataset;
    if (!ds) {
      pushLog('error', 'no dataset loaded');
      return;
    }
    const parsed = parseCommand(command, ds);
    if ('error' in parsed) {
      pushLog('error', parsed.error);
      return;
    }
    if (parsed.kind === 'meta') {
      if (parsed.meta === 'undo') return get().undo();
      if (parsed.meta === 'redo') return get().redo();
      if (parsed.meta === 'help') {
        for (const l of HELP_LINES) pushLog('info', l);
        return;
      }
      if (parsed.meta === 'clearlog') return set({ log: [] });
    }
    if (parsed.kind === 'action') {
      pushCmd(parsed.canonical);
      Promise.resolve(parsed.run?.(ctx)).catch((e) => pushLog('error', String(e?.message ?? e)));
      return;
    }
    // state command
    const cur = snapshot();
    const next = parsed.apply!(cur, ds);
    // A command that changed nothing (deselect with nothing selected, select-all
    // when all are already selected, toggling a value back, …) is dropped so it
    // never adds a dead step to the edit history or the undo stack.
    if (viewStatesEqual(cur, next)) return;
    const idx = currentIdx();
    const log = get().log;

    // coalesce a continuous drag into the current head entry
    const ck = coalesceKey(parsed.canonical);
    if (
      ck &&
      idx >= 0 &&
      idx === log.length - 1 &&
      log[idx].snapshot &&
      coalesceKey(log[idx].command ?? '') === ck
    ) {
      applyViewState(next);
      const entry: LogEntry = { ...log[idx], text: parsed.canonical, command: parsed.canonical, snapshot: next, ts: Date.now() };
      set({ log: [...log.slice(0, idx), entry] });
      return;
    }

    // discard the redo tail if we're branching off an earlier state
    if (idx >= 0 && log.slice(idx + 1).some((e) => e.snapshot)) {
      set({ log: log.slice(0, idx + 1) });
    }
    applyViewState(next);
    pushCmd(parsed.canonical, next);
  };

  return {
    dataset: null,
    source: null,
    status: 'empty',
    error: null,
    colorKey: null,
    rankedMode: 'label',
    colormaps: new Map(),
    domains: new Map(),
    filters: new Map(),
    selection: new Set(),
    primary: null,
    sizeKey: null,
    sizeDomain: null,
    sizes: null,
    labeledPoints: new Set(),
    tracedPoints: new Set(),
    settings: {
      pointSize: 1,
      pointOpacity: 0.95,
      ghostMode: true,
      ghostOpacity: 0.05,
      showAxes: true,
      showGrid: true,
      showImages: true,
      imageOpacity: 0.5,
      hiddenImages: [],
      orthographic: false,
      showTraces: false,
      labelAll: false,
      showBlips: false,
    },
    colors: null,
    visible: null,
    visibleCount: 0,
    selectedMask: null,
    hideUnselected: false,
    mainMap: 0,
    panels: [],
    currentFile: null,
    lastSavedView: null,
    selectedImages: new Set(),
    hover: null,
    currentTime: 0,
    playing: false,
    pendingCamera: null,
    assignPrompt: null,
    capPrompt: null,
    structureNotice: null,
    lassoMode: false,
    log: [],
    currentEntryId: -1,

    dispatch,
    canUndo: () => {
      const s = get();
      const idx = s.log.findIndex((e) => e.id === s.currentEntryId);
      for (let j = idx - 1; j >= 0; j--) if (s.log[j].snapshot) return true;
      return false;
    },
    canRedo: () => {
      const s = get();
      const idx = s.log.findIndex((e) => e.id === s.currentEntryId);
      for (let j = idx + 1; j < s.log.length; j++) if (s.log[j].snapshot) return true;
      return false;
    },
    snapView: (plane) => {
      const before = viewerControls.getCamera?.() ?? undefined;
      viewerControls.snapToPlane?.(plane);
      const after = viewerControls.getCamera?.() ?? undefined;
      // Snapping to the plane the camera already sits on moves nothing — skip it so
      // it doesn't pile up dead "view xy" steps in the edit history.
      if (!before || !after || sameCamera(before, after)) return;
      const s = get();
      const idx = s.log.findIndex((e) => e.id === s.currentEntryId);
      // Branch off any redo tail, then append an undoable camera-only entry (its
      // ViewState snapshot is unchanged; the pose lives in cameraBefore/After).
      const base = idx >= 0 && s.log.slice(idx + 1).some((e) => e.snapshot) ? s.log.slice(0, idx + 1) : s.log;
      const id = nextId();
      const entry: LogEntry = { id, ts: Date.now(), level: 'cmd', text: `view ${plane}`, command: `view ${plane}`, snapshot: snapshot(), cameraBefore: before, cameraAfter: after };
      set({ log: [...base, entry].slice(-MAX_LOG), currentEntryId: id });
    },
    undo: () => {
      const s = get();
      const idx = s.log.findIndex((e) => e.id === s.currentEntryId);
      const leaving = idx >= 0 ? s.log[idx] : undefined;
      let j = idx - 1;
      while (j >= 0 && !s.log[j].snapshot) j--;
      if (j < 0) {
        pushLog('info', 'nothing to undo');
        return;
      }
      const entry = s.log[j];
      applyViewState(entry.snapshot!);
      // Undoing a snap reverts its camera move; other commands leave the camera.
      if (leaving?.cameraBefore) viewerControls.setCamera?.(leaving.cameraBefore);
      set({ currentEntryId: entry.id });
      pushLog('info', `undo → ${entry.command ?? ''}`);
    },
    redo: () => {
      const s = get();
      const idx = s.log.findIndex((e) => e.id === s.currentEntryId);
      let j = idx + 1;
      while (j < s.log.length && !s.log[j].snapshot) j++;
      if (j >= s.log.length) {
        pushLog('info', 'nothing to redo');
        return;
      }
      const entry = s.log[j];
      applyViewState(entry.snapshot!);
      if (entry.cameraAfter) viewerControls.setCamera?.(entry.cameraAfter); // re-snap
      set({ currentEntryId: entry.id });
      pushLog('info', `redo → ${entry.command ?? ''}`);
    },
    jumpTo: (entryId) => {
      const s = get();
      const entry = s.log.find((e) => e.id === entryId);
      if (!entry?.snapshot) return;
      applyViewState(entry.snapshot);
      if (entry.cameraAfter) viewerControls.setCamera?.(entry.cameraAfter);
      set({ currentEntryId: entryId });
      pushLog('info', `revert → ${entry.command ?? ''}`);
    },

    loadRaw: (raw, origin = 'open') => {
      try {
        applyDataset(parseRawMaplet(raw), raw, origin);
      } catch (e) {
        set({ status: 'error', error: (e as Error).message });
        pushLog('error', `Load failed: ${(e as Error).message}`);
      }
    },
    loadRawAsync: async (raw, origin = 'open', opts) => {
      const isTable = typeof raw.pointsTable === 'string' && (raw.pointsTable as string).trim() !== '';
      // True row count: the loader supplies it for an oversized (prefix-only) file, else
      // count the in-memory text (cheap — just newlines, no parse).
      const totalRows = raw.oversize ? raw.oversize.rows : isTable ? countDataLines(raw.pointsTable as string) : 0;
      const fresh = !opts?.assignment && opts?.prompt !== false; // a user-initiated raw load (not a bundle/restore)
      const abort = () => set({ status: get().dataset ? 'ready' : 'empty' });
      const structureFail = () => set({ status: get().dataset ? 'ready' : 'empty', structureNotice: { name: raw.sourceName ?? (raw.source || '') } });
      try {
        if (fresh) {
          // Nothing table-shaped to read → ask the user to check the file.
          if (!isTable) return structureFail();
          // Too many rows: prompt BEFORE any full parse. 'head' = the first N (a cheap
          // prefix), 'all' = the whole dataset (may be less snappy), null = cancel.
          let text = raw.pointsTable as string;
          if (totalRows > CELL_CAP) {
            const choice = await new Promise<'head' | 'all' | null>((resolve) => {
              capResolver = resolve;
              set({ capPrompt: { rows: totalRows, cap: CELL_CAP, oversize: !!raw.oversize } });
            });
            set({ capPrompt: null });
            if (!choice) return abort();
            if (choice === 'head') text = raw.oversize ? text : headText(text, CELL_CAP); // oversized files are already a prefix
            // 'all' keeps the full text (only offered for in-memory files, so not oversized)
          }
          // Recognize the structure from a small HEAD slice — column + type detection only
          // needs the first rows, so a "load anyway" table is never fully parsed on the main
          // thread here. The build below still uses the full `text` (in a worker if large).
          const inspect = (() => {
            try {
              return inspectTable(headText(text, 5000), raw.source);
            } catch {
              return null;
            }
          })();
          if (!inspect || inspect.columns.length < 2) return structureFail();
          const sourceName = raw.sourceName ?? (raw.source.split(/[\\/]/).filter(Boolean).pop() || raw.source);
          const loadRows = countDataLines(text); // how many will actually load (after any cap)
          const chosen = await new Promise<Assignment | null>((resolve) => {
            assignResolver = resolve;
            set({ assignPrompt: { columns: inspect.columns, proposal: assignmentFromInspect(inspect), rowCount: loadRows, sourceName } });
          });
          set({ assignPrompt: null });
          if (!chosen) return abort();
          set({ status: 'loading' });
          const capped: RawMaplet = { ...raw, pointsTable: text, oversize: undefined };
          applyDataset(await parseDatasetAsync(capped, undefined, chosen), capped, origin);
          return;
        }
        // Direct path (bundle / session restore / explicit assignment): reduce an over-cap
        // table to its first N silently, then build (worker for large tables).
        let text = isTable ? (raw.pointsTable as string) : '';
        if (isTable && totalRows > CELL_CAP) text = raw.oversize ? text : headText(text, CELL_CAP);
        const direct: RawMaplet = isTable ? { ...raw, pointsTable: text, oversize: undefined } : raw;
        applyDataset(await parseDatasetAsync(direct, undefined, opts?.assignment), direct, origin);
      } catch (e) {
        set({ status: 'error', error: (e as Error).message });
        pushLog('error', `Load failed: ${(e as Error).message}`);
      }
    },
    buildSavedView: (): SavedView => {
      const s = get();
      return {
        kind: 'maplet-view',
        version: 1,
        savedAt: new Date().toISOString(),
        source: s.dataset?.source ?? s.source ?? '',
        sourceName: s.dataset?.sourceName,
        points: s.dataset?.n,
        view: snapshot(),
        layout: { mainMap: s.mainMap, panels: s.panels },
        camera: viewerControls.getCamera?.() ?? null,
      };
    },
    buildBundle: (): SavedBundle | null => {
      const s = get();
      const ds = s.dataset;
      // Can only bundle a dataset we still hold the raw bytes for.
      if (!ds || !sourceRaw || (sourceRaw.pointsTable == null && sourceRaw.pointsJsonl == null)) return null;
      // Fold any runtime-loaded image overlays into the embedded manifest so the
      // bundle is fully self-contained.
      let manifestObj: Record<string, unknown> = {};
      try {
        manifestObj = JSON.parse(sourceRaw.manifestJson || '{}') || {};
      } catch {
        manifestObj = {};
      }
      if (ds.images.length) manifestObj.images = ds.images;
      return {
        kind: 'maplet-bundle',
        version: 1,
        savedAt: new Date().toISOString(),
        sourceName: ds.sourceName,
        points: ds.n,
        data: {
          pointsTable: sourceRaw.pointsTable ?? null,
          pointsJsonl: sourceRaw.pointsJsonl ?? null,
          manifestJson: JSON.stringify(manifestObj),
        },
        view: snapshot(),
        layout: { mainMap: s.mainMap, panels: s.panels },
        camera: viewerControls.getCamera?.() ?? null,
      };
    },
    applySavedView: (v) => {
      const ds = get().dataset;
      if (!ds) return;
      // A preset may have been saved against a different-sized dataset; clamp
      // selection/primary so stale indices can't point out of bounds.
      const view = {
        ...v.view,
        selection: (v.view.selection ?? []).filter((i) => i >= 0 && i < ds.n),
        primary: v.view.primary != null && v.view.primary >= 0 && v.view.primary < ds.n ? v.view.primary : null,
      };
      applyViewState(view);
      // The viewer applies this on (re)mount; a preset load onto the already-open
      // dataset applies it directly (see the browser branch in app/session.ts).
      set({ pendingCamera: v.camera ?? null });
      // Restore the panel layout, dropping any target that no longer exists.
      if (v.layout) {
        const mapIdx = new Set(ds.maps.map((m) => m.index));
        const varKeys = new Set(ds.columns.filter((c) => c.kind === 'continuous').map((c) => c.key));
        const mainMap = mapIdx.has(v.layout.mainMap) ? v.layout.mainMap : ds.primaryMap;
        const panels = v.layout.panels
          .filter((t) => (t.kind === 'map' ? mapIdx.has(t.index) : varKeys.has(t.key)))
          .slice(0, 3);
        set({ mainMap, panels });
      }
    },
    bindFile: (file) => set({ currentFile: file, lastSavedView: get().buildSavedView() }),
    resetToLastSave: () => {
      const v = get().lastSavedView;
      if (!v) return;
      get().applySavedView(v);
      // Dataset stays mounted, so restore the saved camera directly.
      if (v.camera && viewerControls.setCamera) {
        viewerControls.setCamera(v.camera);
        set({ pendingCamera: null });
      }
      pushLog('info', 'Reverted to the last saved state.');
    },
    addImages: (images, source) => {
      const s = get();
      if (!s.dataset) {
        pushLog('warn', 'Load points first, then add images.');
        return;
      }
      if (!images.length) {
        pushLog('warn', 'No image layers found in that sheet.');
        return;
      }
      // Replace the dataset reference (new images array) so the viewers rebuild
      // their overlay planes; points / colors / selection are untouched.
      const merged = { ...s.dataset, images: [...s.dataset.images, ...images] };
      set({ dataset: merged, selectedImages: new Set() });
      const total = images.reduce((n, l) => n + (l.channels?.length ?? 0), 0);
      pushLog('ok', `Added ${images.length} image layer(s), ${total} channel(s)${source ? ` from ${source}` : ''}.`);
    },
    setLoading: () => set({ status: 'loading', error: null }),
    setError: (msg) => {
      set({ status: 'error', error: msg });
      pushLog('error', msg);
    },
    logMsg: (level, msg) => pushLog(level, msg),
    clearLog: () => set({ log: [] }),

    setColorKey: (key) => dispatch(C.color(key)),
    // Re-type a variable at runtime: rebuild just that column from the SAME raw
    // per-point values under the new type (grad/cat/id). Ranked is multi-column and
    // stays fixed. This is a dataset-structural change (not an undoable ViewState
    // command); it drops the now-mismatched filter and, if the variable can no
    // longer be a colour axis, falls colour back to uniform. The current camera is
    // preserved across the viewer's remount.
    setVariableType: (key, type) => {
      const ds = get().dataset;
      if (!ds) return;
      const old = ds.columnByKey.get(key);
      if (!old) return;
      if (old.kind === 'ranked') {
        pushLog('warn', `"${old.label}" is a ranked (multi-column) variable — its type is fixed by the file.`);
        return;
      }
      const cur: 'grad' | 'cat' = old.kind === 'continuous' ? 'grad' : 'cat';
      if (cur === type) return;
      let newCol: Column;
      try {
        newCol = rebuildColumnAs(ds, key, type);
      } catch (e) {
        pushLog('error', `Couldn't set "${old.label}" to ${type}: ${(e as Error).message}`);
        return;
      }
      const columns = ds.columns.map((c) => (c.key === key ? newCol : c));
      const columnByKey = new Map(columns.map((c) => [c.key, c] as const));
      const nextDs: Dataset = { ...ds, columns, columnByKey };

      const filters = new Map(get().filters);
      filters.delete(key); // the old filter is the wrong kind now

      let colorKey = get().colorKey;
      const colorable = !(newCol.kind === 'categorical' && hasCategoryOverflow(newCol));
      if (colorKey === key && !colorable) colorKey = null;

      const colors = computeColors(nextDs, { key: colorKey, rankedMode: get().rankedMode, colormaps: get().colormaps, domains: get().domains });
      const base = computeVisible(nextDs, filters);
      const { visible, count } = maskUnselected(nextDs.n, base.visible, base.count, get().selection, get().hideUnselected);
      set({
        dataset: nextDs,
        filters,
        colorKey,
        colors,
        visible,
        visibleCount: count,
        // The viewer remounts on a new dataset; keep the user's current camera.
        pendingCamera: viewerControls.getCamera?.() ?? get().pendingCamera,
      });
      pushLog('ok', `Set "${old.label}" type → ${type}.`);
    },
    confirmAssignment: (a) => {
      const r = assignResolver;
      assignResolver = null;
      set({ assignPrompt: null });
      r?.(a);
    },
    cancelAssignment: () => {
      const r = assignResolver;
      assignResolver = null;
      set({ assignPrompt: null });
      r?.(null);
    },
    resolveCapPrompt: (method) => {
      const r = capResolver;
      capResolver = null;
      set({ capPrompt: null });
      r?.(method);
    },
    dismissStructureNotice: () => set({ structureNotice: null }),
    setRankedMode: (m) => dispatch(C.colormode(m)),
    setColormap: (key, name) => dispatch(C.colormap(key, name)),
    setColorDomain: (key, d) => dispatch(C.colorrange(key, d[0], d[1])),
    setContinuousRange: (key, min, max) => dispatch(C.filterRange(key, min, max)),
    toggleCategory: (key, value) => dispatch(C.filterToggle(key, value)),
    isolateCategory: (key, value) => dispatch(C.filterOnly(key, value)),
    setAllCategories: (key, enabled) => dispatch(enabled ? C.filterAll(key) : C.filterNone(key)),
    setRankedMinConf: (key, v) => dispatch(C.filterConf(key, v)),
    setIncludeMissing: (key, include) => dispatch(C.filterMissing(key, include)),
    resetFilter: (key) => dispatch(C.filterReset(key)),
    resetAllFilters: () => dispatch(C.filterResetAll()),
    selectOnly: (i) => dispatch(C.selectOnly(i)),
    toggleSelect: (i) => dispatch(C.selectToggle(i)),
    clearSelection: () => dispatch(C.deselect()),
    selectVisible: () => dispatch(C.selectVisible()),
    selectAll: () => dispatch(C.selectAll()),
    setHideUnselected: (on) => {
      const ds = get().dataset;
      if (!ds) return;
      const base = computeVisible(ds, get().filters);
      const { visible, count } = maskUnselected(ds.n, base.visible, base.count, get().selection, on);
      set({ hideUnselected: on, visible, visibleCount: count });
    },

    setPointSize: (v) => dispatch(C.pointSize(v)),
    setPointOpacity: (v) => dispatch(C.pointOpacity(v)),
    setGhost: (on) => dispatch(C.ghost(on)),
    setGhostOpacity: (v) => dispatch(C.ghostOpacity(v)),
    setAxes: (on) => dispatch(C.axes(on)),
    setGrid: (on) => dispatch(C.grid(on)),
    setBlips: (on) => dispatch(C.blips(on)),
    setImages: (on) => dispatch(C.images(on)),
    setImageOpacity: (v) => dispatch(C.imagesOpacity(v)),
    hideImages: (idxs) => idxs.length && dispatch(C.imageHide(idxs)),
    showImages: (idxs) => idxs.length && dispatch(C.imageShow(idxs)),
    toggleImage: (i) => dispatch(C.imageToggle(i)),
    imagesOnly: (idxs) => dispatch(C.imageOnly(idxs)),

    resetView: () => dispatch(C.viewReset()),
    frameSelection: () => dispatch(C.viewFrame()),
    fitView: (scope) => dispatch(C.viewFit(scope)),
    setOrthographic: (on) => dispatch(C.viewOrtho(on)),
    exportImage: (opts) => dispatch(C.exportImg(opts)),

    toggleImageSelect: (i, additive) =>
      set((s) => {
        // additive (ctrl/shift): toggle membership. plain: toggle between {i} and {} —
        // so clicking an already-selected layer again de-selects it.
        if (additive) {
          const sel = new Set(s.selectedImages);
          sel.has(i) ? sel.delete(i) : sel.add(i);
          return { selectedImages: sel };
        }
        const isOnlyThis = s.selectedImages.has(i) && s.selectedImages.size === 1;
        return { selectedImages: isOnlyThis ? new Set<number>() : new Set<number>([i]) };
      }),
    clearImageSelect: () => set({ selectedImages: new Set() }),
    setHover: (i) => set({ hover: i }),

    setTime: (t) => {
      const ds = get().dataset;
      if (!ds || ds.frameCount <= 1) return set({ currentTime: 0 });
      const lo = ds.frames[0];
      const hi = ds.frames[ds.frames.length - 1];
      set({ currentTime: Number.isFinite(t) ? Math.max(lo, Math.min(hi, t)) : lo });
    },
    setPlaying: (on) => set({ playing: on && (get().dataset?.frameCount ?? 1) > 1 }),

    setSizeKey: (key) => dispatch(C.size(key)),
    setSizeDomain: (range) => dispatch(C.sizeRange(range[0], range[1])),
    toggleLabelSelection: () => dispatch(C.labelSel()),
    toggleTraceSelection: () => dispatch(C.traceSel()),
    showAllLabels: () => dispatch(C.labels(true)),
    hideAllLabels: () => dispatch(C.labelsReset()),
    showAllTraces: () => dispatch(C.traces(true)),
    hideAllTraces: () => dispatch(C.tracesReset()),

    // Panel layout is part of the undoable ViewState, so every change goes through
    // a command (logged in the edit history, revertible with undo).
    setMainMap: (index) => dispatch(C.panelMain(index)),
    setPanelView: (slot, target) => dispatch(C.panelView(slot, target)),
    addPanel: () => {
      const s = get();
      const ds = s.dataset;
      if (!ds || s.panels.length >= 3) return;
      // Prefer the next coordinate map not already on screen; then the first
      // numeric variable not shown; else just repeat the primary map.
      const shownMaps = new Set<number>([s.mainMap]);
      const shownVars = new Set<string>();
      for (const t of s.panels) {
        if (t.kind === 'map') shownMaps.add(t.index);
        else shownVars.add(t.key);
      }
      const nextMap = ds.maps.find((m) => !shownMaps.has(m.index));
      if (nextMap) return dispatch(C.panelAdd({ kind: 'map', index: nextMap.index }));
      const nextVar = ds.columns.find((c) => c.kind === 'continuous' && !shownVars.has(c.key));
      dispatch(C.panelAdd(nextVar ? { kind: 'hist', key: nextVar.key } : { kind: 'map', index: ds.primaryMap }));
    },
    removePanel: (slot) => dispatch(C.panelRemove(slot)),

    setLassoMode: (on) => set({ lassoMode: on }),
    toggleLassoMode: () => set((s) => ({ lassoMode: !s.lassoMode })),
    colorSelect: (i, additive) => dispatch(additive ? C.selectColorAdd(i) : C.selectColor(i)),
    commitSelection: (indices, additive) => {
      const cur = snapshot();
      const set2 = new Set<number>(additive ? cur.selection : []);
      for (const i of indices) set2.add(i);
      const list = [...set2];
      const next: ViewState = { ...cur, selection: list, primary: list.length ? list[list.length - 1] : cur.primary };
      const idx = currentIdx();
      if (idx >= 0 && get().log.slice(idx + 1).some((e) => e.snapshot)) set({ log: get().log.slice(0, idx + 1) });
      applyViewState(next);
      pushCmd(`select region — ${list.length.toLocaleString()} points`, next);
    },
  };
});
