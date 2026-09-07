// The command system: one canonical grammar the GUI builds and dispatches (via
// the C.* builders) for every adjustment. Every state command is a pure
// ViewState -> ViewState function, so it is snapshot-able and undoable and shows
// up in the edit history; action commands (camera / export) run side effects via
// the viewer. `parseCommand` also still parses the same strings from text.

import type { Dataset } from '../format/maplet';
import { hasCategoryOverflow } from '../format/maplet';
import { computeColors, computeVisible, defaultFilter, filterIsActive, sameColorIndices, type Filter } from './derive';
import { fromSerialFilter, toSerialFilter, filtersFromSerial, type LayoutState, type PanelTarget, type ViewState } from './viewstate';
import type { ExportOptions, ViewerControls } from '../viewer/controls';

// Recompute the colors implied by a ViewState (used by color-select, which is a
// pure command and therefore cannot read the store's live color buffer).
function colorsFor(vs: ViewState, ds: Dataset): Float32Array {
  return computeColors(ds, {
    key: vs.colorKey,
    rankedMode: vs.rankedMode,
    colormaps: new Map(Object.entries(vs.colormaps)),
    domains: new Map(Object.entries(vs.domains)) as Map<string, [number, number]>,
  });
}

export type CommandKind = 'state' | 'action' | 'meta';
export interface CommandCtx {
  viewer: ViewerControls;
}
export interface ParsedCommand {
  canonical: string;
  kind: CommandKind;
  apply?: (vs: ViewState, ds: Dataset) => ViewState;
  run?: (ctx: CommandCtx) => void | Promise<void>;
  meta?: 'undo' | 'redo' | 'help' | 'clearlog';
}
export type ParseResult = ParsedCommand | { error: string };

// --- formatting helpers -----------------------------------------------------

export function fmt(v: number): string {
  if (!Number.isFinite(v)) return '0';
  return String(Number(v.toPrecision(6)));
}
function q(v: string): string {
  return /[\s"]/.test(v) || v === '' ? `"${v.replace(/"/g, '\\"')}"` : v;
}
const onOff = (b: boolean) => (b ? 'on' : 'off');

// --- canonical command builders (used by the GUI) --------------------------

export const C = {
  color: (key: string | null) => `color ${key ?? 'off'}`,
  size: (key: string | null) => `size ${key ?? 'off'}`,
  sizeRange: (lo: number, hi: number) => `sizerange ${fmt(lo)} ${fmt(hi)}`,
  traces: (on: boolean) => `traces ${onOff(on)}`, // all visible points' paths
  labels: (on: boolean) => `labels ${onOff(on)}`, // all visible points' names
  labelsReset: () => `labels reset`, // labels off + clear the per-point set
  tracesReset: () => `traces reset`, // traces off + clear the per-point set
  labelSel: () => `label sel`, // toggle name labels on the current selection
  labelNone: () => `label none`,
  traceSel: () => `trace sel`, // toggle highlighted traces on the current selection
  traceNone: () => `trace none`,
  colormode: (m: 'label' | 'confidence') => `colormode ${m}`,
  colormap: (key: string, name: string) => `colormap ${key} ${name}`,
  colorrange: (key: string, lo: number, hi: number) => `colorrange ${key} ${fmt(lo)} ${fmt(hi)}`,
  filterRange: (key: string, lo: number, hi: number) => `filter ${key} range ${fmt(lo)} ${fmt(hi)}`,
  filterToggle: (key: string, value: string) => `filter ${key} toggle ${q(value)}`,
  filterAll: (key: string) => `filter ${key} all`,
  filterNone: (key: string) => `filter ${key} none`,
  filterOnly: (key: string, value: string) => `filter ${key} only ${q(value)}`,
  filterConf: (key: string, v: number) => `filter ${key} conf ${fmt(v)}`,
  filterMatch: (key: string, text: string) => `filter ${key} match ${q(text)}`,
  filterMissing: (key: string, on: boolean) => `filter ${key} missing ${onOff(on)}`,
  filterReset: (key: string) => `filter ${key} reset`,
  filterResetAll: () => `filter reset`,
  selectOnly: (i: number) => `select #${i}`,
  selectToggle: (i: number) => `select toggle #${i}`,
  selectColor: (i: number) => `select color #${i}`,
  selectColorAdd: (i: number) => `select color add #${i}`,
  selectVisible: () => `select visible`,
  selectAll: () => `select all`,
  deselect: () => `deselect`,
  pointSize: (v: number) => `points size ${fmt(v)}`,
  pointOpacity: (v: number) => `points opacity ${fmt(v)}`,
  ghost: (on: boolean) => `ghost ${onOff(on)}`,
  ghostOpacity: (v: number) => `ghost opacity ${fmt(v)}`,
  axes: (on: boolean) => `axes ${onOff(on)}`,
  grid: (on: boolean) => `grid ${onOff(on)}`,
  blips: (on: boolean) => `blips ${onOff(on)}`,
  images: (on: boolean) => `images ${onOff(on)}`,
  imagesOpacity: (v: number) => `images opacity ${fmt(v)}`,
  imageHide: (idxs: number[]) => `image hide ${idxs.map((i) => '#' + i).join(' ')}`,
  imageShow: (idxs: number[]) => `image show ${idxs.map((i) => '#' + i).join(' ')}`,
  imageToggle: (i: number) => `image toggle #${i}`,
  imageOnly: (idxs: number[]) => `image only ${idxs.map((i) => '#' + i).join(' ')}`,
  viewPlane: (p: 'xy' | 'yz' | 'xz') => `view ${p}`,
  viewReset: () => `view reset`,
  viewFrame: () => `view frame`,
  viewFit: (scope: 'all' | 'visible') => `view fit ${scope}`,
  viewOrtho: (on: boolean) => `view ortho ${onOff(on)}`,
  exportImg: (o: ExportOptions) => `export ${o.format} ${o.width} ${o.height} ${o.background}`,
  panelMain: (index: number) => `panel main ${index}`,
  panelAdd: (t: PanelTarget) => `panel add ${t.kind === 'map' ? `map ${t.index}` : `hist ${t.key}`}`,
  panelRemove: (slot: number) => `panel remove ${slot}`,
  panelView: (slot: number, t: PanelTarget) => `panel view ${slot} ${t.kind === 'map' ? `map ${t.index}` : `hist ${t.key}`}`,
};

// --- tokenizer + resolvers --------------------------------------------------

function tokenize(s: string): string[] {
  const out: string[] = [];
  const re = /"((?:[^"\\]|\\.)*)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) out.push(m[1] !== undefined ? m[1].replace(/\\"/g, '"') : m[2]);
  return out;
}

function findColumn(ds: Dataset, key: string) {
  const c = ds.columnByKey.get(key);
  if (c) return c;
  const lk = key.toLowerCase();
  return ds.columns.find((x) => x.key.toLowerCase() === lk || x.label.toLowerCase() === lk) ?? null;
}

function categoriesOf(col: NonNullable<ReturnType<typeof findColumn>>) {
  return col.kind === 'continuous' ? [] : col.categories;
}

function resolveCategory(col: NonNullable<ReturnType<typeof findColumn>>, token: string): number {
  const cats = categoriesOf(col);
  if (token.startsWith('#')) {
    const i = parseInt(token.slice(1), 10);
    return Number.isInteger(i) && i >= 0 && i < cats.length ? i : -1;
  }
  const lk = token.toLowerCase();
  const hit = cats.find((c) => c.value === token) ?? cats.find((c) => c.label.toLowerCase() === lk);
  return hit ? hit.index : -1;
}

function resolveCell(ds: Dataset, token: string): number {
  if (token.startsWith('#')) {
    const i = parseInt(token.slice(1), 10);
    return Number.isInteger(i) && i >= 0 && i < ds.n ? i : -1;
  }
  return ds.pointIds.indexOf(token); // flat id list (never reconstructs point records)
}

function parseOnOff(token: string): boolean | null {
  const t = token?.toLowerCase();
  if (t === 'on' || t === 'true' || t === '1') return true;
  if (t === 'off' || t === 'false' || t === '0') return false;
  return null;
}

// --- filter mutation helpers (operate on runtime Filter, return ViewState) --

function setFilter(vs: ViewState, ds: Dataset, key: string, mutate: (f: Filter) => Filter): ViewState | string {
  const col = findColumn(ds, key);
  if (!col) return `unknown variable: ${key}`;
  const cur = vs.filters[col.key] ? fromSerialFilter(vs.filters[col.key]) : defaultFilter(col);
  const next = mutate(cur);
  const filters = { ...vs.filters };
  if (filterIsActive(col, next)) filters[col.key] = toSerialFilter(next);
  else delete filters[col.key];
  return { ...vs, filters };
}

// --- the parser -------------------------------------------------------------

export function parseCommand(input: string, ds: Dataset): ParseResult {
  const tokens = tokenize(input.trim().replace(/^\//, ''));
  if (tokens.length === 0) return { error: 'empty command' };
  const cmd = tokens[0].toLowerCase();
  const a = tokens.slice(1);
  const ok = (canonical: string, apply: ParsedCommand['apply']): ParsedCommand => ({ canonical, kind: 'state', apply });
  const err = (m: string): ParseResult => ({ error: m });

  switch (cmd) {
    case 'undo':
      return { canonical: 'undo', kind: 'meta', meta: 'undo' };
    case 'redo':
      return { canonical: 'redo', kind: 'meta', meta: 'redo' };
    case 'help':
      return { canonical: 'help', kind: 'meta', meta: 'help' };
    case 'clearlog':
      return { canonical: 'clearlog', kind: 'meta', meta: 'clearlog' };

    case 'color': {
      const key = a[0] ?? 'off';
      if (key === 'off' || key === 'uniform' || key === 'none') return ok('color off', (vs) => ({ ...vs, colorKey: null }));
      const col = findColumn(ds, key);
      if (!col) return err(`unknown variable: ${key}`);
      // Thousands of distinct labels (e.g. spatial barcodes) cannot be told apart
      // by colour — switch such a ranked variable to confidence colouring.
      const byConf = col.kind === 'ranked' && hasCategoryOverflow(col);
      return ok(C.color(col.key), (vs) => ({ ...vs, colorKey: col.key, ...(byConf ? { rankedMode: 'confidence' as const } : {}) }));
    }
    case 'size': {
      const key = a[0] ?? 'off';
      if (key === 'off' || key === 'uniform' || key === 'none') return ok('size off', (vs) => ({ ...vs, sizeKey: null, sizeDomain: null }));
      const col = findColumn(ds, key);
      if (!col) return err(`unknown variable: ${key}`);
      if (col.kind !== 'continuous') return err(`size by: "${col.key}" is not a numeric variable`);
      return ok(C.size(col.key), (vs) => ({ ...vs, sizeKey: col.key, sizeDomain: [col.dataMin, col.dataMax] }));
    }
    case 'sizerange': {
      const lo = parseFloat(a[0]);
      const hi = parseFloat(a[1]);
      if (!Number.isFinite(lo) || !Number.isFinite(hi)) return err('sizerange: expected <lo> <hi>');
      return ok(C.sizeRange(lo, hi), (vs) => ({ ...vs, sizeDomain: [lo, hi] }));
    }
    case 'traces': {
      if (a[0] === 'reset') return ok('traces reset', (vs) => ({ ...vs, tracedPoints: [], settings: { ...vs.settings, showTraces: false } }));
      const on = parseOnOff(a[0]);
      if (on === null) return err('traces: expected on|off|reset');
      return ok(C.traces(on), (vs) => ({ ...vs, settings: { ...vs.settings, showTraces: on } }));
    }
    case 'labels': {
      if (a[0] === 'reset') return ok('labels reset', (vs) => ({ ...vs, labeledPoints: [], settings: { ...vs.settings, labelAll: false } }));
      const on = parseOnOff(a[0]);
      if (on === null) return err('labels: expected on|off|reset');
      return ok(C.labels(on), (vs) => ({ ...vs, settings: { ...vs.settings, labelAll: on } }));
    }
    case 'label':
      return parsePointSet(a, 'label', err);
    case 'trace':
      return parsePointSet(a, 'trace', err);
    case 'colormode': {
      const m = a[0];
      if (m !== 'label' && m !== 'confidence') return err('colormode: expected label|confidence');
      return ok(`colormode ${m}`, (vs) => ({ ...vs, rankedMode: m }));
    }
    case 'colormap': {
      const col = findColumn(ds, a[0] ?? '');
      if (!col) return err(`unknown variable: ${a[0]}`);
      const name = a[1];
      if (!name) return err('colormap: expected a colormap name');
      return ok(C.colormap(col.key, name), (vs) => ({ ...vs, colormaps: { ...vs.colormaps, [col.key]: name } }));
    }
    case 'colorrange': {
      const col = findColumn(ds, a[0] ?? '');
      if (!col) return err(`unknown variable: ${a[0]}`);
      const lo = parseFloat(a[1]);
      const hi = parseFloat(a[2]);
      if (!Number.isFinite(lo) || !Number.isFinite(hi)) return err('colorrange: expected <lo> <hi>');
      return ok(C.colorrange(col.key, lo, hi), (vs) => ({ ...vs, domains: { ...vs.domains, [col.key]: [lo, hi] } }));
    }

    case 'filter':
      return parseFilter(a, ds, err);

    case 'select': {
      if (a[0] === 'visible')
        return ok('select visible', (vs, d) => {
          const { visible } = computeVisible(d, filtersFromSerial(vs.filters));
          const sel: number[] = [];
          for (let i = 0; i < d.n; i++) if (visible[i]) sel.push(i);
          return { ...vs, selection: sel, primary: sel[0] ?? null };
        });
      if (a[0] === 'all')
        // "All" now means every SHOWN point — hidden points can't be selected by any
        // means (a hidden point isn't interactive; unhide it via its filter first).
        return ok('select all', (vs, d) => {
          const { visible } = computeVisible(d, filtersFromSerial(vs.filters));
          const sel: number[] = [];
          for (let i = 0; i < d.n; i++) if (visible[i]) sel.push(i);
          return { ...vs, selection: sel, primary: sel[0] ?? null };
        });
      if (a[0] === 'color') {
        const additive = a[1] === 'add';
        const i = resolveCell(ds, (additive ? a[2] : a[1]) ?? '');
        if (i < 0) return err(`select color: unknown point ${(additive ? a[2] : a[1]) ?? ''}`);
        return ok(additive ? C.selectColorAdd(i) : C.selectColor(i), (vs, d) => {
          const colors = colorsFor(vs, d);
          const { visible } = computeVisible(d, filtersFromSerial(vs.filters));
          const group = sameColorIndices(colors, visible, i);
          const set = new Set(additive ? vs.selection : []);
          for (const j of group) set.add(j);
          return { ...vs, selection: [...set], primary: i };
        });
      }
      if (a[0] === 'toggle' || a[0] === 'add') {
        const i = resolveCell(ds, a[1] ?? '');
        if (i < 0) return err(`unknown point: ${a[1]}`);
        return ok(`select ${a[0]} #${i}`, (vs) => {
          const set = new Set(vs.selection);
          if (a[0] === 'toggle' && set.has(i)) set.delete(i);
          else set.add(i);
          const selection = [...set];
          return { ...vs, selection, primary: set.has(i) ? i : selection[selection.length - 1] ?? null };
        });
      }
      const i = resolveCell(ds, a[0] ?? '');
      if (i < 0) return err(`select: unknown point ${a[0] ?? ''}`);
      return ok(`select #${i}`, (vs) => ({ ...vs, selection: [i], primary: i }));
    }
    case 'deselect':
      return ok('deselect', (vs) => ({ ...vs, selection: [], primary: null }));

    case 'points': {
      const v = parseFloat(a[1]);
      if (a[0] === 'size' && Number.isFinite(v))
        return ok(C.pointSize(v), (vs) => ({ ...vs, settings: { ...vs.settings, pointSize: v } }));
      if (a[0] === 'opacity' && Number.isFinite(v))
        return ok(C.pointOpacity(v), (vs) => ({ ...vs, settings: { ...vs.settings, pointOpacity: v } }));
      return err('points: expected "size <v>" or "opacity <v>"');
    }
    case 'ghost': {
      if (a[0] === 'opacity') {
        const v = parseFloat(a[1]);
        if (!Number.isFinite(v)) return err('ghost opacity: expected a number');
        return ok(C.ghostOpacity(v), (vs) => ({ ...vs, settings: { ...vs.settings, ghostOpacity: v } }));
      }
      const on = parseOnOff(a[0]);
      if (on === null) return err('ghost: expected on|off');
      return ok(C.ghost(on), (vs) => ({ ...vs, settings: { ...vs.settings, ghostMode: on } }));
    }
    case 'axes': {
      const on = parseOnOff(a[0]);
      if (on === null) return err('axes: expected on|off');
      return ok(C.axes(on), (vs) => ({ ...vs, settings: { ...vs.settings, showAxes: on } }));
    }
    case 'grid': {
      const on = parseOnOff(a[0]);
      if (on === null) return err('grid: expected on|off');
      return ok(C.grid(on), (vs) => ({ ...vs, settings: { ...vs.settings, showGrid: on } }));
    }
    case 'blips': {
      const on = parseOnOff(a[0]);
      if (on === null) return err('blips: expected on|off');
      return ok(C.blips(on), (vs) => ({ ...vs, settings: { ...vs.settings, showBlips: on } }));
    }
    case 'images': {
      if (a[0] === 'opacity') {
        const v = parseFloat(a[1]);
        if (!Number.isFinite(v)) return err('images opacity: expected a number');
        return ok(C.imagesOpacity(v), (vs) => ({ ...vs, settings: { ...vs.settings, imageOpacity: v } }));
      }
      const on = parseOnOff(a[0]);
      if (on === null) return err('images: expected on|off or "opacity <v>"');
      return ok(C.images(on), (vs) => ({ ...vs, settings: { ...vs.settings, showImages: on } }));
    }
    case 'image':
      return parseImage(a, ds, err);

    case 'view':
      return parseView(a, err);

    case 'panel':
      return parsePanel(a, ds, err);

    case 'export':
      return parseExport(a, err);

    default:
      return err(`unknown command: ${cmd} — try help`);
  }
}

function parseFilter(a: string[], ds: Dataset, err: (m: string) => ParseResult): ParseResult {
  if (a[0] === 'reset' && a.length === 1) return { canonical: 'filter reset', kind: 'state', apply: (vs) => ({ ...vs, filters: {} }) };
  const key = a[0];
  const sub = a[1];
  const col = findColumn(ds, key ?? '');
  if (!col) return err(`unknown variable: ${key}`);
  const K = col.key;
  const state = (canonical: string, apply: ParsedCommand['apply']): ParsedCommand => ({ canonical, kind: 'state', apply });

  switch (sub) {
    case 'reset':
      return state(`filter ${K} reset`, (vs) => {
        const f = { ...vs.filters };
        delete f[K];
        return { ...vs, filters: f };
      });
    case 'range': {
      const lo = parseFloat(a[2]);
      const hi = parseFloat(a[3]);
      if (!Number.isFinite(lo) || !Number.isFinite(hi)) return err('filter range: expected <lo> <hi>');
      return state(C.filterRange(K, lo, hi), (vs, d) => {
        const r = setFilter(vs, d, K, (f) => (f.kind === 'continuous' ? { ...f, min: lo, max: hi } : f));
        return typeof r === 'string' ? vs : r;
      });
    }
    case 'conf': {
      const v = parseFloat(a[2]);
      if (!Number.isFinite(v)) return err('filter conf: expected a number');
      return state(C.filterConf(K, v), (vs, d) => {
        const r = setFilter(vs, d, K, (f) => (f.kind === 'ranked' ? { ...f, minConf: v } : f));
        return typeof r === 'string' ? vs : r;
      });
    }
    case 'missing': {
      const on = parseOnOff(a[2]);
      if (on === null) return err('filter missing: expected on|off');
      return state(C.filterMissing(K, on), (vs, d) => {
        const r = setFilter(vs, d, K, (f) => ({ ...f, includeMissing: on }));
        return typeof r === 'string' ? vs : r;
      });
    }
    case 'all':
    case 'none': {
      const enable = sub === 'all';
      return state(`filter ${K} ${sub}`, (vs, d) => {
        const r = setFilter(vs, d, K, (f) => {
          if (f.kind === 'categorical' && col.kind === 'categorical') {
            return { ...f, disabled: enable ? new Set<string>() : new Set(col.distinct.map((x) => x.value)) };
          }
          if (f.kind === 'ranked') {
            const ids = new Set(categoriesOf(col).map((c) => c.index));
            return { ...f, enabledTop: enable ? ids : new Set() };
          }
          return f;
        });
        return typeof r === 'string' ? vs : r;
      });
    }
    case 'only': {
      // Show ONLY this one value/category (used by double-clicking a legend swatch).
      if (col.kind === 'categorical') {
        const value = a[2] ?? '';
        return state(C.filterOnly(K, value), (vs, d) => {
          const r = setFilter(vs, d, K, (f) =>
            f.kind === 'categorical' ? { ...f, disabled: new Set(col.distinct.map((x) => x.value).filter((v) => v !== value)) } : f,
          );
          return typeof r === 'string' ? vs : r;
        });
      }
      const idx = resolveCategory(col, a[2] ?? '');
      if (idx < 0) return err(`filter only: unknown category ${a[2] ?? ''}`);
      return state(C.filterOnly(K, categoriesOf(col)[idx].value), (vs, d) => {
        const r = setFilter(vs, d, K, (f) => (f.kind === 'ranked' ? { ...f, enabledTop: new Set([idx]) } : f));
        return typeof r === 'string' ? vs : r;
      });
    }
    case 'toggle': {
      // Categorical toggles a VALUE in/out of the disabled set; ranked toggles a
      // top-label index. A value not in the colour palette still toggles fine.
      if (col.kind === 'categorical') {
        const value = a[2] ?? '';
        return state(C.filterToggle(K, value), (vs, d) => {
          const r = setFilter(vs, d, K, (f) => {
            if (f.kind !== 'categorical') return f;
            const s = new Set(f.disabled);
            if (s.has(value)) s.delete(value);
            else s.add(value);
            return { ...f, disabled: s };
          });
          return typeof r === 'string' ? vs : r;
        });
      }
      const idx = resolveCategory(col, a[2] ?? '');
      if (idx < 0) return err(`filter toggle: unknown category ${a[2] ?? ''}`);
      return state(C.filterToggle(K, categoriesOf(col)[idx].value), (vs, d) => {
        const r = setFilter(vs, d, K, (f) => {
          if (f.kind === 'ranked') {
            const s = new Set(f.enabledTop);
            if (s.has(idx)) s.delete(idx);
            else s.add(idx);
            return { ...f, enabledTop: s };
          }
          return f;
        });
        return typeof r === 'string' ? vs : r;
      });
    }
    default:
      return err('filter: expected range|toggle|all|none|only|conf|missing|reset');
  }
}

// Per-point name labels / highlighted traces: toggle the CURRENT selection's
// membership in a persistent set (independent of the live selection), or clear it.
function parsePointSet(a: string[], kind: 'label' | 'trace', err: (m: string) => ParseResult): ParseResult {
  const state = (canonical: string, apply: ParsedCommand['apply']): ParsedCommand => ({ canonical, kind: 'state', apply });
  const sub = a[0];
  const toggle = (vs: ViewState): ViewState => {
    const cur = new Set(kind === 'label' ? vs.labeledPoints : vs.tracedPoints);
    const sel = vs.selection;
    // If every selected point is already in the set, the toggle removes them all;
    // otherwise it adds them all (so one click labels/traces a fresh selection).
    const allIn = sel.length > 0 && sel.every((i) => cur.has(i));
    for (const i of sel) allIn ? cur.delete(i) : cur.add(i);
    const arr = [...cur].sort((x, y) => x - y);
    return kind === 'label' ? { ...vs, labeledPoints: arr } : { ...vs, tracedPoints: arr };
  };
  const clear = (vs: ViewState): ViewState => (kind === 'label' ? { ...vs, labeledPoints: [] } : { ...vs, tracedPoints: [] });
  if (sub === 'sel' || sub === 'selection') return state(`${kind} sel`, toggle);
  if (sub === 'none' || sub === 'clear') return state(`${kind} none`, clear);
  return err(`${kind}: expected sel|none`);
}

function clampImageIdxs(a: string[], ds: Dataset): number[] {
  const out: number[] = [];
  for (const t of a) {
    const i = t.startsWith('#') ? parseInt(t.slice(1), 10) : parseInt(t, 10);
    if (Number.isInteger(i) && i >= 0 && i < ds.images.length) out.push(i);
  }
  return out;
}

function parseImage(a: string[], ds: Dataset, err: (m: string) => ParseResult): ParseResult {
  const sub = a[0];
  const idxs = clampImageIdxs(a.slice(1), ds);
  const state = (canonical: string, apply: ParsedCommand['apply']): ParsedCommand => ({ canonical, kind: 'state', apply });
  const setHidden = (vs: ViewState, hidden: number[]): ViewState => ({
    ...vs,
    settings: { ...vs.settings, hiddenImages: [...new Set(hidden)].sort((x, y) => x - y) },
  });
  switch (sub) {
    case 'hide':
      return state(C.imageHide(idxs), (vs) => setHidden(vs, [...vs.settings.hiddenImages, ...idxs]));
    case 'show':
      return state(C.imageShow(idxs), (vs) => setHidden(vs, vs.settings.hiddenImages.filter((i) => !idxs.includes(i))));
    case 'toggle': {
      const i = idxs[0];
      if (i === undefined) return err('image toggle: expected #index');
      return state(C.imageToggle(i), (vs) =>
        setHidden(vs, vs.settings.hiddenImages.includes(i) ? vs.settings.hiddenImages.filter((x) => x !== i) : [...vs.settings.hiddenImages, i]),
      );
    }
    case 'only':
      return state(C.imageOnly(idxs), (vs) => setHidden(vs, ds.images.map((_, i) => i).filter((i) => !idxs.includes(i))));
    default:
      return err('image: expected hide|show|toggle|only <#index...>');
  }
}

function parseView(a: string[], err: (m: string) => ParseResult): ParseResult {
  const p = a[0];
  if (p === 'xy' || p === 'yz' || p === 'xz') return { canonical: `view ${p}`, kind: 'action', run: (c) => c.viewer.snapToPlane?.(p) };
  if (p === 'reset') return { canonical: 'view reset', kind: 'action', run: (c) => c.viewer.resetView?.() };
  if (p === 'frame') return { canonical: 'view frame', kind: 'action', run: (c) => c.viewer.frameSelection?.() };
  if (p === 'fit') {
    const scope = a[1] === 'all' ? 'all' : a[1] === 'visible' ? 'visible' : null;
    if (!scope) return err('view fit: expected all|visible');
    return { canonical: `view fit ${scope}`, kind: 'action', run: (c) => c.viewer.fit?.(scope) };
  }
  if (p === 'ortho') {
    // Orthographic (parallel) projection is a persisted, undoable SETTING — the
    // viewer switches its render camera when settings.orthographic changes.
    const on = parseOnOff(a[1]);
    if (on === null) return err('view ortho: expected on|off');
    return {
      canonical: `view ortho ${on ? 'on' : 'off'}`,
      kind: 'state',
      apply: (vs) => ({ ...vs, settings: { ...vs.settings, orthographic: on } }),
    };
  }
  return err('view: expected xy|yz|xz|reset|fit|ortho');
}

// Panel layout (which map / variable each viewport shows) lives in the ViewState,
// so add / remove / switch panels are undoable and appear in the edit history.
function parsePanel(a: string[], ds: Dataset, err: (m: string) => ParseResult): ParseResult {
  const sub = a[0];
  const state = (canonical: string, apply: ParsedCommand['apply']): ParsedCommand => ({ canonical, kind: 'state', apply });
  const layoutOf = (vs: ViewState): LayoutState => vs.layout ?? { mainMap: ds.primaryMap, panels: [] };
  const target = (kindTok?: string, valTok?: string): PanelTarget | null => {
    if (kindTok === 'map') {
      const i = parseInt(valTok ?? '', 10);
      return ds.maps.some((m) => m.index === i) ? { kind: 'map', index: i } : null;
    }
    if (kindTok === 'hist') {
      const col = valTok ? findColumn(ds, valTok) : null;
      return col && col.kind === 'continuous' ? { kind: 'hist', key: col.key } : null;
    }
    return null;
  };
  switch (sub) {
    case 'main': {
      const i = parseInt(a[1] ?? '', 10);
      if (!ds.maps.some((m) => m.index === i)) return err(`panel main: unknown map ${a[1] ?? ''}`);
      return state(C.panelMain(i), (vs) => ({ ...vs, layout: { ...layoutOf(vs), mainMap: i } }));
    }
    case 'add': {
      const t = target(a[1], a[2]);
      if (!t) return err('panel add: expected "map <index>" or "hist <var>"');
      return state(C.panelAdd(t), (vs) => {
        const L = layoutOf(vs);
        return L.panels.length >= 3 ? vs : { ...vs, layout: { ...L, panels: [...L.panels, t] } };
      });
    }
    case 'remove': {
      const slot = parseInt(a[1] ?? '', 10);
      if (!Number.isInteger(slot) || slot < 0) return err('panel remove: expected a slot index');
      return state(C.panelRemove(slot), (vs) => {
        const L = layoutOf(vs);
        return slot >= L.panels.length ? vs : { ...vs, layout: { ...L, panels: L.panels.filter((_, i) => i !== slot) } };
      });
    }
    case 'view': {
      const slot = parseInt(a[1] ?? '', 10);
      const t = target(a[2], a[3]);
      if (!Number.isInteger(slot) || slot < 0 || !t) return err('panel view: expected "<slot> map <index>" or "<slot> hist <var>"');
      return state(C.panelView(slot, t), (vs) => {
        const L = layoutOf(vs);
        return slot >= L.panels.length ? vs : { ...vs, layout: { ...L, panels: L.panels.map((p, i) => (i === slot ? t : p)) } };
      });
    }
    default:
      return err('panel: expected main|add|remove|view');
  }
}

function parseExport(a: string[], err: (m: string) => ParseResult): ParseResult {
  const format = a[0] === 'png' || a[0] === 'svg' ? a[0] : null;
  if (!format) return err('export: expected png|svg [w] [h] [dark|white|transparent]');
  const width = parseInt(a[1] ?? '1600', 10) || 1600;
  const height = parseInt(a[2] ?? '1200', 10) || 1200;
  const bgTok = a[3];
  const background = bgTok === 'white' || bgTok === 'transparent' || bgTok === 'dark' ? bgTok : 'dark';
  const opts: ExportOptions = { format, width, height, background };
  return {
    canonical: C.exportImg(opts),
    kind: 'action',
    run: (c) => {
      void c.viewer.exportImage?.(opts);
    },
  };
}

export const HELP_LINES = [
  'open  folder  sample                 load data',
  'color <var|off>   size <var|off>   colormode label|confidence',
  'traces on|off   labels on|off   label sel|none   trace sel|none',
  'colormap <var> <name>   colorrange <var> <lo> <hi>',
  'filter <var> range <lo> <hi> | toggle <cat> | all | none',
  'filter <var> conf <v> | missing on|off | reset    filter reset',
  'select <#i|id> | select toggle <#i> | select color <#i> | select visible | select all | deselect',
  'points size|opacity <v>   ghost on|off   ghost opacity <v>',
  'axes on|off   grid on|off   blips on|off',
  'images on|off   images opacity <v>   image hide|show|only|toggle <#i...>',
  'view xy|yz|xz|reset   view fit visible|all   view ortho on|off',
  'panel main <map>   panel add|view map <index>|hist <var>   panel remove <slot>',
  'export png|svg <w> <h> <dark|white|transparent>',
  'undo   redo   clearlog   help',
];
