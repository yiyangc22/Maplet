// Session memory: remembers the last-used view per dataset so reopening an
// experiment restores where you left off, and remembers the last opened source
// so the desktop app can reopen it on launch. The on-disk shape is a single
// blob (userData/maplet-session.json in Electron, localStorage in the browser),
// loaded once at startup; writes are debounced.

import { useStore } from '../model/store';
import { viewerControls } from '../viewer/controls';
import { isSavedView, type SavedView } from '../model/preset';
import { readSessionRaw, writeSessionRaw } from '../platform/persist';

interface SessionBlob {
  version: 1;
  lastSource?: string;
  views: Record<string, SavedView>; // keyed by dataset source (reload path)
}

const MAX_VIEWS = 24;
let mem: SessionBlob | null = null;
let loading: Promise<SessionBlob> | null = null;

function loadBlob(): Promise<SessionBlob> {
  if (mem) return Promise.resolve(mem);
  if (!loading) {
    loading = (async () => {
      const raw = await readSessionRaw();
      const blob: SessionBlob = { version: 1, views: {} };
      if (raw) {
        try {
          const p = JSON.parse(raw) as Partial<SessionBlob>;
          if (p && typeof p === 'object') {
            if (typeof p.lastSource === 'string') blob.lastSource = p.lastSource;
            if (p.views && typeof p.views === 'object') {
              for (const [k, v] of Object.entries(p.views)) if (isSavedView(v)) blob.views[k] = v as SavedView;
            }
          }
        } catch {
          /* corrupt — start fresh */
        }
      }
      mem = blob;
      return blob;
    })();
  }
  return loading;
}

/** The saved view for a dataset source, if any (read before a load overwrites it). */
export async function getSavedView(source: string): Promise<SavedView | null> {
  if (!source) return null;
  const b = await loadBlob();
  return b.views[source] ?? null;
}

/** The last dataset source opened (for desktop reopen-on-launch). */
export async function getLastSource(): Promise<string | null> {
  const b = await loadBlob();
  return b.lastSource ?? null;
}

async function persistNow(): Promise<void> {
  const st = useStore.getState();
  if (!st.dataset || st.status !== 'ready') return;
  const view = st.buildSavedView();
  if (!view.source) return;
  const b = await loadBlob();
  b.lastSource = view.source;
  b.views[view.source] = view;
  const keys = Object.keys(b.views);
  if (keys.length > MAX_VIEWS) {
    keys.sort((a, c) => Date.parse(b.views[c].savedAt) - Date.parse(b.views[a].savedAt));
    for (const k of keys.slice(MAX_VIEWS)) delete b.views[k];
  }
  try {
    await writeSessionRaw(JSON.stringify(b));
  } catch {
    /* non-fatal: session restore is a convenience */
  }
}

let timer: ReturnType<typeof setTimeout> | null = null;
function scheduleSave(): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void persistNow();
  }, 600);
}

let started = false;
/** Begin persisting the current view (debounced) on every relevant change. */
export function startSessionAutosave(): void {
  if (started) return;
  started = true;
  void loadBlob(); // warm the cache early so getSavedView is ready before a load

  useStore.subscribe((s, p) => {
    if (s.status !== 'ready' || !s.dataset) return;
    if (
      s.colorKey !== p.colorKey ||
      s.rankedMode !== p.rankedMode ||
      s.colormaps !== p.colormaps ||
      s.domains !== p.domains ||
      s.filters !== p.filters ||
      s.selection !== p.selection ||
      s.primary !== p.primary ||
      s.settings !== p.settings
    ) {
      scheduleSave();
    }
  });

  // Camera moves aren't in the store — the viewer notifies us here.
  viewerControls.onCameraMoved = () => {
    if (useStore.getState().status === 'ready') scheduleSave();
  };

  // Best-effort flush on close (localStorage is synchronous; the Electron IPC
  // write may not complete, but the debounced saves keep disk near-current).
  window.addEventListener('beforeunload', () => {
    void persistNow();
  });
}
