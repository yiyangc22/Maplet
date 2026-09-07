// Electron main process: window creation, native file dialogs, and ALL disk
// I/O. The renderer never touches the filesystem; it receives raw text over IPC
// and parses it with the same code the browser fallback uses.

import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import type { ImageLayer, ImagesResult, RawMaplet } from '../shared/types';
import { parseImagesTable } from '../shared/table';

let win: BrowserWindow | null = null;

const RECENT_MAX = 10;

function recentFile(): string {
  return path.join(app.getPath('userData'), 'maplet-recent.json');
}

function sessionFile(): string {
  return path.join(app.getPath('userData'), 'maplet-session.json');
}

function readRecent(): string[] {
  try {
    const list = JSON.parse(fs.readFileSync(recentFile(), 'utf8'));
    return Array.isArray(list) ? list.filter((p) => typeof p === 'string') : [];
  } catch {
    return [];
  }
}

function pushRecent(p: string): void {
  const list = [p, ...readRecent().filter((x) => x !== p)].slice(0, RECENT_MAX);
  try {
    fs.writeFileSync(recentFile(), JSON.stringify(list, null, 2), 'utf8');
  } catch {
    /* non-fatal: recent list is a convenience only */
  }
}

function mimeFor(p: string): string | null {
  const e = path.extname(p).toLowerCase();
  if (e === '.png') return 'image/png';
  if (e === '.jpg' || e === '.jpeg') return 'image/jpeg';
  if (e === '.webp') return 'image/webp';
  if (e === '.gif') return 'image/gif';
  return null;
}

// Inline the file-path srcs of parsed image layers (from an images spreadsheet)
// into data URIs, relative to the sheet's folder. data:/http(s) srcs pass through.
function inlineLayers(layers: ImageLayer[], baseDir: string): ImageLayer[] {
  return layers.map((layer) => ({
    ...layer,
    channels: (layer.channels ?? []).map((ch) => {
      const src = ch?.src;
      if (typeof src !== 'string' || src.startsWith('data:') || /^https?:\/\//.test(src)) return ch;
      const abs = path.isAbsolute(src) ? src : path.join(baseDir, src);
      const mime = mimeFor(abs);
      if (!mime) return ch;
      try {
        return { ...ch, src: `data:${mime};base64,${fs.readFileSync(abs).toString('base64')}` };
      } catch {
        return ch; // leave the original; the renderer skips unresolved srcs
      }
    }),
  }));
}

// Detect a flat-table save "bundle": a folder holding points.(tsv|csv) [+ images.(tsv|csv)].
const TABLE_CELLS = ['points.tsv', 'points.csv', 'points.tab'];
const TABLE_IMAGES = ['images.tsv', 'images.csv', 'images.tab'];
function firstExisting(dir: string, names: string[], re: RegExp): string | null {
  for (const n of names) {
    const p = path.join(dir, n);
    if (fs.existsSync(p)) return p;
  }
  try {
    const f = fs.readdirSync(dir).find((n) => re.test(n));
    if (f) return path.join(dir, f);
  } catch {
    /* not readable */
  }
  return null;
}
function tableBundleIn(dir: string): { points: string; images: string | null } | null {
  const points = firstExisting(dir, TABLE_CELLS, /\.points\.(c|t)sv$/i);
  if (!points) return null;
  const images = firstExisting(dir, TABLE_IMAGES, /\.images\.(c|t)sv$/i);
  return { points, images };
}
function readTableBundle(source: string, b: { points: string; images: string | null }): RawMaplet {
  const pointsTable = fs.readFileSync(b.points, 'utf8');
  let images: ImageLayer[] = [];
  if (b.images) {
    try {
      const parsed = parseImagesTable(fs.readFileSync(b.images, 'utf8'), b.images);
      images = inlineLayers(parsed.images, path.dirname(b.images));
    } catch {
      /* images are optional; keep the points */
    }
  }
  const manifestJson = JSON.stringify({ maplet_version: '1.0', dataset: {}, variables: [], images });
  // The reload path is the folder (`source`); the display name is the actual points file.
  return { source, sourceName: path.basename(b.points), manifestJson, pointsJsonl: null, pointsTable };
}

// Search a folder for a nested table bundle (the "experiment folder" workflow):
// a `maplet/` (or any one-level) subfolder holding points.tsv [+ images.tsv].
function findNestedTable(dir: string): { points: string; images: string | null } | null {
  let subdirs: string[] = [];
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) subdirs.push(e.name);
    }
  } catch {
    return null;
  }
  const ordered = ['maplet', ...subdirs.filter((s) => s !== 'maplet')];
  for (const sub of ordered) {
    const tb = tableBundleIn(path.join(dir, sub));
    if (tb) return tb;
  }
  return null;
}

// Resolve a chosen path to a RawMaplet (cat_prototype_06: CSV/TSV points only).
// Handles:
//   - a flat points table file        (points.csv / points.tsv)
//   - a table bundle directory       (dir/ with points.tsv [+ images.tsv])
//   - an experiment folder that CONTAINS a table bundle (searched for; images
//     resolve relative to the chosen experiment folder)
function readMapletFromPath(target: string): RawMaplet {
  const stat = fs.statSync(target);

  if (stat.isDirectory()) {
    // A direct table bundle (points.tsv [+ images.tsv]).
    const directTable = tableBundleIn(target);
    if (directTable) return readTableBundle(target, directTable);
    // An experiment folder that CONTAINS a table bundle (nested).
    const found = findNestedTable(target);
    if (found) return readTableBundle(target, found);
    throw new Error(
      `No points spreadsheet found in ${target} (looked for points.tsv/.csv, or a maplet/ subfolder holding one).`,
    );
  }

  // A flat points table (CSV/TSV): the renderer parses it; images come separately.
  const ext = path.extname(target).toLowerCase();
  if (ext === '.csv' || ext === '.tsv' || ext === '.tab') {
    return {
      source: target,
      sourceName: path.basename(target),
      manifestJson: '{}',
      pointsJsonl: null,
      pointsTable: fs.readFileSync(target, 'utf8'),
    };
  }

  throw new Error(`Unsupported file "${path.basename(target)}". Open a .csv or .tsv points spreadsheet.`);
}

function sampleDir(): string {
  return path.join(app.getAppPath(), 'sample-data');
}

function registerIpc(): void {
  ipcMain.handle('maplet:open', async (): Promise<RawMaplet | null> => {
    const res = await dialog.showOpenDialog(win!, {
      title: 'Open a points spreadsheet (CSV/TSV)',
      properties: ['openFile'],
      filters: [
        { name: 'Points spreadsheet', extensions: ['csv', 'tsv', 'tab'] },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    if (res.canceled || res.filePaths.length === 0) return null;
    const raw = readMapletFromPath(res.filePaths[0]);
    pushRecent(raw.source);
    return raw;
  });

  // Universal "Browse", starting in the bundled samples folder. Returns the raw
  // file text; the renderer routes by extension (table / .yml view / .json bundle).
  ipcMain.handle('maplet:browseSample', async (): Promise<{ text: string; name: string; path: string } | null> => {
    const res = await dialog.showOpenDialog(win!, {
      title: 'Open a sample dataset',
      defaultPath: sampleDir(),
      properties: ['openFile'],
      filters: [
        { name: 'Maplet files', extensions: ['csv', 'tsv', 'tab', 'yml', 'yaml', 'json'] },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    if (res.canceled || res.filePaths.length === 0) return null;
    const p = res.filePaths[0];
    return { text: fs.readFileSync(p, 'utf8'), name: path.basename(p), path: p };
  });

  ipcMain.handle('maplet:openImages', async (): Promise<ImagesResult | null> => {
    const res = await dialog.showOpenDialog(win!, {
      title: 'Open an images spreadsheet (image coordinates + file paths)',
      properties: ['openFile'],
      filters: [
        { name: 'Images sheet (CSV/TSV)', extensions: ['csv', 'tsv', 'tab'] },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    if (res.canceled || res.filePaths.length === 0) return null;
    const p = res.filePaths[0];
    const parsed = parseImagesTable(fs.readFileSync(p, 'utf8'), p);
    return { source: p, images: inlineLayers(parsed.images, path.dirname(p)) };
  });

  ipcMain.handle('maplet:openFolder', async (): Promise<RawMaplet | null> => {
    const res = await dialog.showOpenDialog(win!, {
      title: 'Open a points folder (experiment folder or one holding points.tsv)',
      properties: ['openDirectory'],
    });
    if (res.canceled || res.filePaths.length === 0) return null;
    const raw = readMapletFromPath(res.filePaths[0]);
    pushRecent(raw.source);
    return raw;
  });

  ipcMain.handle('maplet:loadPath', (_e, p: string): RawMaplet => {
    const raw = readMapletFromPath(p);
    pushRecent(raw.source);
    return raw;
  });

  ipcMain.handle('maplet:loadSample', (_e, name: string): RawMaplet => {
    // Read a bundled sample by filename from sample-data/ (basename only — no path
    // traversal outside the folder).
    return readMapletFromPath(path.join(sampleDir(), path.basename(name)));
  });

  ipcMain.handle('maplet:recent', (): string[] => readRecent());
  ipcMain.handle('maplet:clearRecent', (): void => {
    try {
      fs.rmSync(recentFile(), { force: true });
    } catch {
      /* ignore */
    }
  });

  // --- session memory (last-used view per dataset) -------------------------
  ipcMain.handle('session:get', (): string | null => {
    try {
      return fs.readFileSync(sessionFile(), 'utf8');
    } catch {
      return null;
    }
  });
  ipcMain.handle('session:set', (_e, json: string): void => {
    try {
      fs.writeFileSync(sessionFile(), json, 'utf8');
    } catch {
      /* non-fatal: session restore is a convenience */
    }
  });

  // --- export a figure + a sidecar .maplet.json preset next to it ---------
  ipcMain.handle(
    'export:save',
    async (
      _e,
      p: { format: 'png' | 'svg'; dataBase64?: string; text?: string; suggestedName: string; presetJson: string },
    ): Promise<{ ok: boolean; path?: string; canceled?: boolean; error?: string }> => {
      const res = await dialog.showSaveDialog(win!, {
        title: 'Export figure',
        defaultPath: p.suggestedName,
        filters: [p.format === 'png' ? { name: 'PNG image', extensions: ['png'] } : { name: 'SVG image', extensions: ['svg'] }],
      });
      if (res.canceled || !res.filePath) return { ok: false, canceled: true };
      try {
        const out = res.filePath;
        if (p.format === 'png') fs.writeFileSync(out, Buffer.from(p.dataBase64 ?? '', 'base64'));
        else fs.writeFileSync(out, p.text ?? '', 'utf8');
        // Reproducible view preset alongside the image.
        const sidecar = out.replace(/\.(png|svg)$/i, '') + '.maplet.json';
        fs.writeFileSync(sidecar, p.presetJson, 'utf8');
        return { ok: true, path: out };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    },
  );

  // --- explicit preset save / load -----------------------------------------
  ipcMain.handle(
    'preset:save',
    async (_e, p: { json: string; suggestedName: string }): Promise<{ ok: boolean; path?: string; canceled?: boolean; error?: string }> => {
      const res = await dialog.showSaveDialog(win!, {
        title: 'Save view preset',
        defaultPath: p.suggestedName,
        filters: [{ name: 'Maplet view preset', extensions: ['json'] }],
      });
      if (res.canceled || !res.filePath) return { ok: false, canceled: true };
      try {
        fs.writeFileSync(res.filePath, p.json, 'utf8');
        return { ok: true, path: res.filePath };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    },
  );
  ipcMain.handle(
    'preset:load',
    async (): Promise<{ ok: boolean; text?: string; path?: string; canceled?: boolean; error?: string }> => {
      const res = await dialog.showOpenDialog(win!, {
        title: 'Load view preset',
        properties: ['openFile'],
        filters: [
          { name: 'Maplet view preset', extensions: ['json'] },
          { name: 'All files', extensions: ['*'] },
        ],
      });
      if (res.canceled || res.filePaths.length === 0) return { ok: false, canceled: true };
      try {
        return { ok: true, text: fs.readFileSync(res.filePaths[0], 'utf8'), path: res.filePaths[0] };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    },
  );
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1500,
    height: 950,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#050505',
    title: 'Maplet Viewer',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // The in-app menu bar covers everything; keep a few window shortcuts working.
  win.webContents.on('before-input-event', (_e, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F12') win?.webContents.toggleDevTools();
    else if (input.key === 'F11') win?.setFullScreen(!win.isFullScreen());
    else if (input.key.toLowerCase() === 'r' && input.control && process.env.VITE_DEV_SERVER_URL) {
      win?.webContents.reload();
    }
  });

  // External links open in the user's browser, never in-app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) {
    void win.loadURL(devUrl);
  } else {
    void win.loadFile(path.join(__dirname, '..', '..', 'dist', 'index.html'));
  }
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  registerIpc();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
