// One loading surface for both environments: in Electron it calls the native
// IPC bridge (dialogs + fs); in a plain browser it uses the File API and fetch.
// Points load ONLY from a flat CSV/TSV spreadsheet (cat_prototype_06); images load
// from a separate spreadsheet as a second step. Both return shapes the shared
// parser understands.

import type { ImagesResult, RawMaplet } from '../../shared/types';
import { CELL_CAP, headText, parseImagesTable } from '../../shared/table';

export function isElectron(): boolean {
  return typeof window !== 'undefined' && !!window.maplet;
}

export function platformLabel(): string {
  return isElectron() ? 'desktop' : 'browser';
}

// A quick content sniff (extension-independent): does this look like a delimited
// points table (a header with id, or x and y)?
function sniffCellsTable(text: string): boolean {
  const firstLine = text.split(/\r?\n/).find((l) => l.trim() !== '') ?? '';
  if (!/[,\t]/.test(firstLine)) return false;
  const cols = firstLine.split(/[,\t]/).map((s) => s.trim().toLowerCase());
  return cols.includes('id') || cols.includes('cell_id') || (cols.includes('x') && cols.includes('y'));
}

function isTableName(name: string): boolean {
  return name.endsWith('.csv') || name.endsWith('.tsv') || name.endsWith('.tab');
}

// Above this size a file is read only as a PREFIX (its first CELL_CAP rows) rather
// than pulled into memory whole — the app then offers "load the first N" (see
// readPrefixRows / rawFromFile).
const MAX_FILE_BYTES = 250 * 1024 * 1024; // ~250 MB

// Read ONLY the first ~nRows rows of a (possibly huge) file, pulling byte-slices until
// enough newlines are seen — so a multi-GB file never lands in memory whole. A hard
// byte ceiling guards the pathological case of very wide rows (few rows, huge bytes).
async function readPrefixRows(file: File, nRows: number): Promise<string> {
  const CHUNK = 4 * 1024 * 1024;
  const MAX_PREFIX_BYTES = 64 * 1024 * 1024;
  let text = '';
  let offset = 0;
  while (offset < file.size && offset < MAX_PREFIX_BYTES) {
    text += await file.slice(offset, offset + CHUNK).text();
    offset += CHUNK;
    if ((text.match(/\n/g)?.length ?? 0) > nRows + 1) break;
  }
  return headText(text, nRows);
}

// Estimate a file's total data-row count from its byte size and the average bytes per
// row in the prefix — good enough for the "that's N rows" warning.
function estimateRows(fileSize: number, prefix: string): number {
  const rowsInPrefix = Math.max(1, prefix.match(/\n/g)?.length ?? 1);
  const bytesPerRow = Math.max(1, prefix.length / rowsInPrefix);
  return Math.max(rowsInPrefix, Math.round(fileSize / bytesPerRow) - 1);
}

async function rawFromFile(file: File): Promise<RawMaplet> {
  const name = file.name.toLowerCase();
  if (name.endsWith('.json') || name.endsWith('.jsonl') || name.endsWith('.maplet')) {
    throw new Error('This version loads points from a CSV/TSV spreadsheet only (one row per point). Export your points to .csv or .tsv.');
  }
  // Electron's File objects expose a real path; fall back to the name in browsers.
  const source = (file as File & { path?: string }).path || file.name;
  // Too large to hold in memory: read ONLY the first CELL_CAP rows (a cheap prefix) and
  // record the (estimated) true row count, so the app can offer "load the first N"
  // instead of failing. Smaller files are read whole.
  if (file.size > MAX_FILE_BYTES) {
    const prefix = await readPrefixRows(file, CELL_CAP);
    return { source, sourceName: file.name, manifestJson: '{}', pointsTable: prefix, oversize: { rows: estimateRows(file.size, prefix) } };
  }
  // Empty / not-a-table problems are surfaced by the store as a friendly "check the
  // file" notice (see loadRawAsync), not thrown here — so any delimited file reaches
  // the assignment step where the user maps its columns.
  const text = await file.text();
  return { source, sourceName: file.name, manifestJson: '{}', pointsTable: text ?? '' };
}

function pickFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    let done = false;
    const finish = (f: File | null) => {
      if (done) return;
      done = true;
      window.removeEventListener('focus', onFocus);
      resolve(f);
    };
    // A pick resolves the file; dismissing the dialog must resolve null (otherwise
    // the caller stays in the "loading…" state forever).
    input.onchange = () => finish(input.files?.[0] ?? null);
    input.oncancel = () => finish(null); // modern browsers fire this on cancel
    // Fallback for browsers without 'cancel': when focus returns to the window after
    // the dialog closes and no file arrived, treat it as a cancel.
    const onFocus = () => setTimeout(() => finish(null), 350);
    window.addEventListener('focus', onFocus);
    input.click();
  });
}

export async function openFile(): Promise<RawMaplet | null> {
  if (window.maplet) return window.maplet.open();
  const f = await pickFile('.csv,.tsv,.tab,text/csv,text/tab-separated-values');
  return f ? rawFromFile(f) : null;
}

// Universal "Browse": pick ANY supported file (the caller routes by extension —
// raw table / .yml view / .json bundle). Desktop can start in the bundled samples
// folder via a native dialog; the browser (and desktop fallback) use a DOM input.
export async function pickAnyFile(
  useSampleDir: boolean,
): Promise<{ name: string; path: string; file?: File; text?: string } | null> {
  // Desktop "browse the samples folder" returns already-read text via the IPC bridge.
  if (useSampleDir && window.maplet?.browseSample) return window.maplet.browseSample();
  const f = await pickFile('.csv,.tsv,.tab,.yml,.yaml,.json');
  if (!f) return null;
  // Return the File (not eagerly-read text) so the caller can route a huge raw table
  // through the same prefix-reading loader as drag-drop / Open, instead of pulling
  // gigabytes into memory here.
  return { file: f, name: f.name, path: (f as File & { path?: string }).path || f.name };
}

export async function openFolder(): Promise<RawMaplet | null> {
  if (window.maplet) return window.maplet.openFolder();
  throw new Error('Opening a folder needs the desktop app. In the browser, open a .csv / .tsv points table.');
}

// Load a separate images spreadsheet (the second step). In Electron the main
// process reads image files and inlines them; in the browser the sheet's file
// paths must already be data: URIs or http(s) URLs.
export async function openImages(): Promise<ImagesResult | null> {
  if (window.maplet) return window.maplet.openImages();
  const f = await pickFile('.csv,.tsv,.tab,text/csv');
  if (!f) return null;
  const text = await f.text();
  const { images } = parseImagesTable(text, f.name);
  return { source: f.name, images };
}

export async function loadPath(path: string): Promise<RawMaplet> {
  if (window.maplet) return window.maplet.loadPath(path);
  throw new Error('Recent files are only available in the desktop app.');
}

export async function recent(): Promise<string[]> {
  if (window.maplet) return window.maplet.recent();
  return [];
}

// Load a dataset by URL (browser convenience, e.g. ?data= / ?points=).
export async function loadUrl(url: string): Promise<RawMaplet> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not fetch ${url} (${res.status}).`);
  const text = await res.text();
  const sourceName = url.split(/[\\/?#]/).filter(Boolean).pop() || url;
  if (!isTableName(url.toLowerCase()) && !sniffCellsTable(text)) {
    throw new Error(`${url} doesn't look like a CSV/TSV points table.`);
  }
  return { source: url, sourceName, manifestJson: '{}', pointsTable: text };
}

export async function loadImagesUrl(url: string): Promise<ImagesResult> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not fetch ${url} (${res.status}).`);
  const { images } = parseImagesTable(await res.text(), url);
  return { source: url, images };
}

export async function readDroppedFile(file: File): Promise<RawMaplet> {
  return rawFromFile(file);
}

export async function readDroppedImages(file: File): Promise<ImagesResult> {
  const { images } = parseImagesTable(await file.text(), file.name);
  return { source: file.name, images };
}
