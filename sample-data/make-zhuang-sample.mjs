// Build the bundled Zhuang-ABCA brain sample: stream the full 661 MB / 2.85 M-cell
// MERFISH metadata CSV and keep every STEP-th cell, so the ~6k-cell subset spreads
// across ALL coronal sections → the whole 3D mouse brain at a fraction of the size.
// Emits a TYPED table (name__type header) so it loads cleanly as the default sample.
//
// Run:  tools/node/win-x64/node.exe sample-data/make-zhuang-sample.mjs

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const SRC = path.join(root, 'examples', 'zhuang_01_cell_metadata.csv');
const OUT = path.join(__dirname, 'zhuang-brain.cells.tsv');
const STEP = 470; // 2.85M / 470 ≈ 6060 cells

// Source columns: 0 cell_label,1 brain_section_label,...,6 cluster_alias,7 x,8 y,9 z,
// 10 subclass_confidence_score,11 cluster_confidence_score,12 high_quality_transfer,13 abc_sample_id
const HEADER = [
  'id',
  'spatial_x__x0',
  'spatial_y__y0',
  'spatial_z__z0',
  'cluster__grad',
  'subclass_confidence__grad',
  'cluster_confidence__grad',
  'brain_section__cat',
  'high_quality__cat',
].join('\t');

const rl = readline.createInterface({ input: fs.createReadStream(SRC, { encoding: 'utf8' }), crlfDelay: Infinity });
const out = fs.createWriteStream(OUT);
out.write(HEADER + '\n');

let row = -1; // -1 is the header line
let kept = 0;
const round = (s, d = 3) => {
  const n = Number(s);
  return Number.isFinite(n) ? String(Number(n.toFixed(d))) : '';
};

rl.on('line', (line) => {
  row++;
  if (row === 0) return; // skip source header
  if ((row - 1) % STEP !== 0) return;
  const c = line.split(',');
  if (c.length < 13) return;
  // id, x, y, z, cluster, subclass_conf, cluster_conf, section, high_quality
  const rec = [c[0], round(c[7]), round(c[8]), round(c[9]), c[6], round(c[10], 4), round(c[11], 4), c[1], c[12]];
  out.write(rec.join('\t') + '\n');
  kept++;
});

rl.on('close', () => {
  out.end();
  console.log(`Wrote ${kept} cells → ${path.relative(root, OUT)}`);
});
