// Thin wrappers that run a platform loader and push the result into the store,
// handling cancellation and errors uniformly. Shared by the menu, console, and
// welcome screen.

import type { ImagesResult, RawMaplet } from '../../shared/types';
import { looksLikeImagesTable } from '../../shared/table';
import { useStore } from '../model/store';
import * as loader from '../platform/loader';
import { isElectron } from '../platform/loader';
import { viewerControls } from '../viewer/controls';
import {
  bundleFilename,
  parseBundle,
  parsePerspective,
  perspectiveFilename,
  stringifyBundle,
  stringifyPerspective,
  type SavedBundle,
  type SavedView,
} from '../model/preset';
import { loadPresetFile, savePreset } from '../platform/persist';
import { getLastSource, getSavedView } from './session';

async function run(fn: () => Promise<RawMaplet | null>, origin = 'open'): Promise<void> {
  const st = useStore.getState();
  st.setLoading();
  try {
    const raw = await fn();
    if (!raw) {
      // dialog cancelled — restore the previous status
      useStore.setState({ status: useStore.getState().dataset ? 'ready' : 'empty' });
      return;
    }
    // Look up any saved view BEFORE the load overwrites session memory, then
    // restore it so the user reopens the experiment where they left off.
    const saved = await getSavedView(raw.source);
    await useStore.getState().loadRawAsync(raw, origin); // worker-parses large tables; origin = the command shown in the log
    if (useStore.getState().status !== 'ready') return; // load failed (error already surfaced)
    if (saved) useStore.getState().applySavedView(saved);
    useStore.getState().bindFile(null); // raw data isn't bound to a perspective/bundle file
  } catch (e) {
    useStore.getState().setError((e as Error).message);
  }
}

// Images load as a second step onto an already-loaded dataset, so a failure
// (or cancel) must NOT tear down the current view — just log it.
async function runImages(fn: () => Promise<ImagesResult | null>): Promise<void> {
  try {
    const res = await fn();
    if (res) useStore.getState().addImages(res.images, res.source);
  } catch (e) {
    useStore.getState().logMsg('error', `Load images failed: ${(e as Error).message}`);
  }
}

export const doOpen = () => run(loader.openFile, 'open');
export const doOpenFolder = () => run(loader.openFolder, 'folder');
export const doOpenImages = () => runImages(loader.openImages);
export const doLoadPath = (p: string) => run(() => loader.loadPath(p), 'open');
export const doUrl = (url: string) => run(() => loader.loadUrl(url), 'open');
export const doImagesUrl = (url: string) => runImages(() => loader.loadImagesUrl(url));

// The last dataset that can be reopened on launch, as a display name (basename),
// or null. Desktop only — the browser can't reload a file by path, so the launch
// screen won't offer a "reopen" button there.
export async function restorableSessionName(): Promise<string | null> {
  if (!isElectron()) return null;
  const last = await getLastSource();
  if (!last) return null;
  return last.split(/[\\/]/).filter(Boolean).pop() || last;
}

// On launch (desktop), reopen the last dataset; the browser can't reload a file by
// path, so it returns false. Called from the launch screen's "Load last dataset".
export async function restoreLastSession(): Promise<boolean> {
  if (!isElectron()) return false;
  const last = await getLastSource();
  if (!last) return false;
  try {
    const raw = await loader.loadPath(last);
    const saved = await getSavedView(raw.source);
    // Session restore: reuse the structure by auto-detect (no assignment modal on launch).
    await useStore.getState().loadRawAsync(raw, 'open', { prompt: false });
    if (useStore.getState().status !== 'ready') return false;
    if (saved) useStore.getState().applySavedView(saved);
    useStore.getState().bindFile(null);
    return useStore.getState().status === 'ready';
  } catch {
    return false; // moved/deleted — quietly fall back
  }
}

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

// Save the current view as a PERSPECTIVE (.yml): view + filters + layout + camera,
// no data. `filename` reuses the bound file's name for a smart "Save".
export async function savePerspectiveAs(filename?: string): Promise<void> {
  const st = useStore.getState();
  if (!st.dataset) return;
  const name = filename ?? perspectiveFilename(st.dataset.sourceName, stamp());
  const res = await savePreset(stringifyPerspective(st.buildSavedView()), name, 'application/x-yaml');
  if (res.canceled) return;
  if (res.ok) {
    st.bindFile({ name, kind: 'perspective' });
    st.logMsg('ok', `Saved perspective → ${res.path ?? name}.`);
  } else st.logMsg('error', `Save failed: ${res.error ?? 'unknown error'}`);
}

// Save the current view as a standalone BUNDLE (.json): everything, data embedded,
// so it reopens even if the original CSV/TSV is gone.
export async function saveBundleAs(filename?: string): Promise<void> {
  const st = useStore.getState();
  if (!st.dataset) return;
  const bundle = st.buildBundle();
  if (!bundle) {
    st.logMsg('error', "Can't bundle this dataset — its raw table isn't available. Reopen the data file, then save.");
    return;
  }
  const name = filename ?? bundleFilename(st.dataset.sourceName, stamp());
  const res = await savePreset(stringifyBundle(bundle), name, 'application/json');
  if (res.canceled) return;
  if (res.ok) {
    st.bindFile({ name, kind: 'bundle' });
    st.logMsg('ok', `Saved bundle — ${bundle.points?.toLocaleString() ?? '?'} points embedded → ${res.path ?? name}.`);
  } else st.logMsg('error', `Save failed: ${res.error ?? 'unknown error'}`);
}

// Smart "Save": write back to the bound file's format + name. Returns false when
// nothing is bound (the caller opens "Save as" to pick a format instead).
export async function doSave(): Promise<boolean> {
  const cf = useStore.getState().currentFile;
  if (!cf) return false;
  if (cf.kind === 'perspective') await savePerspectiveAs(cf.name);
  else await saveBundleAs(cf.name);
  return true;
}

// Rebuild a view-only preset shape from a bundle, so applySavedView can restore it.
function viewFromBundle(b: SavedBundle): SavedView {
  return {
    kind: 'maplet-view',
    version: 1,
    savedAt: b.savedAt,
    source: `bundle:${b.sourceName ?? 'visualization'}`,
    sourceName: b.sourceName,
    points: b.points,
    view: b.view,
    layout: b.layout,
    camera: b.camera ?? null,
  };
}

// Rebuild the whole dataset from a bundle's embedded bytes and apply its view —
// works even if the original data file is gone. (Shared by the bundle loader and
// the universal Browse.)
async function applyBundleText(text: string, pathHint?: string): Promise<void> {
  const st = useStore.getState();
  let bundle: SavedBundle;
  try {
    bundle = parseBundle(text);
  } catch (e) {
    st.setError(`Not a valid Maplet bundle (.json): ${(e as Error).message}`);
    return;
  }
  try {
    const raw: RawMaplet = {
      source: `bundle:${bundle.sourceName ?? 'visualization'}`,
      sourceName: bundle.sourceName,
      manifestJson: bundle.data.manifestJson || '{}',
      pointsTable: bundle.data.pointsTable ?? null,
      pointsJsonl: bundle.data.pointsJsonl ?? null,
    };
    await st.loadRawAsync(raw, 'load', { prompt: false }); // bundle already has a structure; auto-detect, no modal
    if (useStore.getState().status !== 'ready') return;
    st.applySavedView(viewFromBundle(bundle));
    st.bindFile({ name: pathHint ?? bundleFilename(bundle.sourceName, stamp()), kind: 'bundle' });
    st.logMsg('ok', `Loaded bundle${bundle.sourceName ? ` "${bundle.sourceName}"` : ''} — ${bundle.points?.toLocaleString() ?? '?'} points.`);
  } catch (e) {
    st.setError(`Couldn't open the bundle: ${(e as Error).message}`);
  }
}

// Apply a saved perspective (view + filters + layout + camera) onto the CURRENT
// dataset. (Shared by the perspective loader and the universal Browse.)
function applyPerspectiveText(text: string, pathHint?: string): void {
  const st = useStore.getState();
  if (!st.dataset) {
    st.setError('Load raw data (or a bundle) first, then apply a perspective (.yml) onto it.');
    return;
  }
  let view: SavedView;
  try {
    view = parsePerspective(text);
  } catch (e) {
    st.setError(`Not a valid Maplet perspective (.yml): ${(e as Error).message}`);
    return;
  }
  if (view.source && st.dataset.source !== view.source) {
    st.logMsg('warn', `This perspective was saved for "${view.sourceName ?? view.source}"; applying it to the current dataset.`);
  }
  st.applySavedView(view);
  // The dataset stays mounted here, so apply the camera directly rather than on mount.
  if (view.camera && viewerControls.setCamera) {
    viewerControls.setCamera(view.camera);
    useStore.setState({ pendingCamera: null });
  }
  st.bindFile({ name: pathHint ?? perspectiveFilename(view.sourceName, stamp()), kind: 'perspective' });
  st.logMsg('ok', 'Applied perspective.');
}

// "Full visualization (.json)": rebuild dataset + view from a standalone bundle.
export async function doLoadBundle(): Promise<void> {
  const picked = await loadPresetFile('.json,application/json');
  if (picked) await applyBundleText(picked.text, picked.path);
}

// "View (.yml/.yaml)": apply a saved view onto the current dataset.
export async function doLoadPerspective(): Promise<void> {
  if (!useStore.getState().dataset) {
    useStore.getState().setError('Load raw data (or a bundle) first, then apply a perspective (.yml) onto it.');
    return;
  }
  const picked = await loadPresetFile('.yml,.yaml,text/yaml');
  if (picked) applyPerspectiveText(picked.text, picked.path);
}

// "Browse…" (and "Sample dataset…"): pick ANY supported file and route by kind —
// a raw table loads a dataset, a .yml applies a view, a .json opens a bundle.
// `useSampleDir` only changes the desktop dialog's starting folder to the samples.
export async function doBrowse(useSampleDir = false): Promise<void> {
  const st = useStore.getState();
  const picked = await loader.pickAnyFile(useSampleDir);
  if (!picked) return;
  const ext = picked.name.toLowerCase().split('.').pop() ?? '';
  // Presets/bundles are small — read their text (from the desktop bridge, or the File).
  const readText = async () => picked.text ?? (picked.file ? await picked.file.text() : '');
  if (ext === 'yml' || ext === 'yaml') return applyPerspectiveText(await readText(), picked.path);
  if (ext === 'json') return applyBundleText(await readText(), picked.path);
  // Raw table: route through the SAME oversize-aware reader as drag-drop / Open, so a
  // huge or unreadable file gets the row-cap "Wowza" prompt or the "check the file"
  // notice — never a silent failure.
  st.setLoading();
  try {
    const raw: RawMaplet = picked.file
      ? await loader.readDroppedFile(picked.file)
      : { source: picked.path, sourceName: picked.name, manifestJson: '{}', pointsTable: picked.text ?? '' };
    const saved = await getSavedView(raw.source);
    await st.loadRawAsync(raw, 'open');
    if (useStore.getState().status !== 'ready') return;
    if (saved) st.applySavedView(saved);
    st.bindFile(null);
  } catch (e) {
    useStore.getState().setError((e as Error).message);
  }
}

export async function loadDropped(file: File): Promise<void> {
  // If a dataset is already loaded and this looks like an images spreadsheet,
  // treat the drop as "add images"; otherwise load it as points / a dataset.
  try {
    if (useStore.getState().dataset && (file.name.toLowerCase().endsWith('.csv') || file.name.toLowerCase().endsWith('.tsv'))) {
      const text = await file.text();
      if (looksLikeImagesTable(text, file.name)) {
        useStore.getState().addImages((await loader.readDroppedImages(file)).images, file.name);
        return;
      }
    }
  } catch {
    /* fall through to a normal load */
  }
  const st = useStore.getState();
  st.setLoading();
  try {
    const raw = await loader.readDroppedFile(file);
    await useStore.getState().loadRawAsync(raw);
  } catch (e) {
    useStore.getState().setError((e as Error).message);
  }
}
