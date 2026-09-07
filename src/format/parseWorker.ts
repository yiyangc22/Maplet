// Web Worker: parse a raw points table + build the Dataset OFF the main thread, so a
// large file (hundreds of MB / millions of rows) doesn't freeze the UI. It returns a
// columnar DatasetPayload (typed arrays); the heavy transient parse intermediates
// (the split rows, the per-point objects) live and die inside this worker, never
// reaching the main heap. Inlined into the bundle via `?worker&inline`, so the
// single-file MapletViewer.html keeps working (no separate worker chunk to fetch).

import type { RawMaplet } from '../../shared/types';
import type { Assignment, CapOption } from '../../shared/table';
import { parseRawMaplet, datasetToPayload, type DatasetPayload } from './maplet';

export interface WorkerRequest {
  raw: RawMaplet;
  cap?: CapOption;
  assignment?: Assignment;
}
export type WorkerResponse = { ok: true; payload: DatasetPayload } | { ok: false; error: string };

// Minimal typing for the dedicated worker scope, to avoid needing the "webworker" lib.
const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<WorkerRequest>) => void) | null;
  postMessage: (m: WorkerResponse) => void;
};

ctx.onmessage = (e) => {
  try {
    const ds = parseRawMaplet(e.data.raw, e.data.cap, e.data.assignment);
    const payload = datasetToPayload(ds);
    ctx.postMessage({ ok: true, payload });
  } catch (err) {
    ctx.postMessage({ ok: false, error: (err as Error).message });
  }
};
