// Decide whether to parse a dataset inline (small files) or in a Web Worker (large
// files), and return the built Dataset either way. The worker keeps the UI
// responsive during a long parse and confines the transient parse memory to its own
// heap; the result comes back columnar (see payloadToDataset / makePointsView).

import type { RawMaplet } from '../../shared/types';
import type { Assignment, CapOption } from '../../shared/table';
import { parseRawMaplet, payloadToDataset, type Dataset } from './maplet';
import ParseWorker from './parseWorker?worker&inline';
import type { WorkerResponse } from './parseWorker';

// Tables at/above this size parse in a worker. Below it, the worker setup + payload
// hand-back isn't worth it (and inline parsing keeps the full per-point records).
const WORKER_MIN_BYTES = 8_000_000; // ~8 MB of CSV/TSV text

export function isLargeTable(raw: RawMaplet): boolean {
  return typeof raw.pointsTable === 'string' && raw.pointsTable.length >= WORKER_MIN_BYTES;
}

export function parseDatasetAsync(raw: RawMaplet, cap?: CapOption, assignment?: Assignment): Promise<Dataset> {
  if (!isLargeTable(raw)) return Promise.resolve(parseRawMaplet(raw, cap, assignment));
  return new Promise<Dataset>((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new ParseWorker();
    } catch {
      resolve(parseRawMaplet(raw, cap, assignment)); // worker unavailable → inline fallback
      return;
    }
    worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
      const msg = e.data;
      worker.terminate();
      if (msg.ok) resolve(payloadToDataset(msg.payload));
      else reject(new Error(msg.error));
    };
    worker.onerror = (ev) => {
      worker.terminate();
      reject(new Error(ev.message || 'The parse worker failed — the file may be too large to load in one piece.'));
    };
    worker.postMessage({ raw, cap, assignment });
  });
}
