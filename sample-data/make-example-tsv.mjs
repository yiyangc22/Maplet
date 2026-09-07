// Generate a self-contained SPREADSHEET example for the Maplet Viewer — the
// simple CSV/TSV save format — so anyone can load it as a worked example.
//
// Writes into  cat_prototype_05/examples/ :
//   tissue-sample.cells.tsv            one row per cell (all format features)
//   tissue-sample.images.tsv           overlay images by RELATIVE path -> images/
//   tissue-sample.images.datauri.tsv   same images embedded as data URIs (browser)
//   images/*.png                       real (synthetic) multichannel PNGs
//   README.md                          how to load it
//
// Fully synthetic — no real data. Run:  node sample-data/make-example-tsv.mjs

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const outDir = path.join(root, 'examples');
const imgDir = path.join(outDir, 'images');

// --- deterministic RNG ------------------------------------------------------
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(20260709);
const gauss = () => Math.sqrt(-2 * Math.log(1 - rnd())) * Math.cos(2 * Math.PI * rnd());
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const round = (v, d = 3) => Number(v.toFixed(d));

// --- biology-ish setup ------------------------------------------------------
const CELL_TYPES = ['ExN', 'InN', 'Astro', 'Oligo', 'OPC', 'Micro', 'Endo', 'VLMC'];
const REGIONS = ['Cortex', 'Hippocampus', 'Thalamus', 'Striatum', 'Hypothalamus', 'FiberTract'];
const REGION_TYPE_W = {
  Cortex: { ExN: 6, InN: 2, Astro: 1.4, Oligo: 1, OPC: 0.5, Micro: 0.5, Endo: 0.3, VLMC: 0.2 },
  Hippocampus: { ExN: 7, InN: 1.5, Astro: 1.2, Oligo: 0.8, OPC: 0.4, Micro: 0.4, Endo: 0.3, VLMC: 0.15 },
  Thalamus: { ExN: 4, InN: 3, Astro: 1.2, Oligo: 1.2, OPC: 0.5, Micro: 0.5, Endo: 0.3, VLMC: 0.15 },
  Striatum: { InN: 7, ExN: 0.6, Astro: 1.4, Oligo: 1, OPC: 0.5, Micro: 0.5, Endo: 0.4, VLMC: 0.2 },
  Hypothalamus: { InN: 4, ExN: 2.5, Astro: 1.3, Oligo: 1, OPC: 0.5, Micro: 0.5, Endo: 0.4, VLMC: 0.2 },
  FiberTract: { Oligo: 7, OPC: 2, Astro: 1.5, Micro: 0.8, ExN: 0.3, InN: 0.3, Endo: 0.4, VLMC: 0.2 },
};
const NEURON = new Set(['ExN', 'InN']);
const DONORS = ['D1', 'D2', 'D3'];

function weightedPick(weights) {
  const entries = Object.entries(weights);
  const total = entries.reduce((s, [, w]) => s + w, 0);
  let r = rnd() * total;
  for (const [k, w] of entries) {
    r -= w;
    if (r <= 0) return k;
  }
  return entries[0][0];
}
function rankedTypes(trueType) {
  const conf = 0.55 + rnd() * 0.4;
  const calls = [{ label: trueType, confidence: round(conf) }];
  const others = CELL_TYPES.filter((t) => t !== trueType);
  let remaining = 1 - conf;
  const nAlt = 1 + Math.floor(rnd() * 2);
  for (let i = 0; i < nAlt; i++) {
    const c = remaining * (0.3 + rnd() * 0.5);
    remaining -= c;
    calls.push({ label: pick(others), confidence: round(Math.max(0.01, c)) });
  }
  return calls;
}
function barcodeCombo() {
  const ports = new Set();
  while (ports.size < 5) ports.add(1 + Math.floor(rnd() * 19));
  return [...ports].sort((a, b) => a - b).map((p) => `I${String(p).padStart(2, '0')}`).join('-');
}
function rankedBarcodes() {
  const nCand = 3 + Math.floor(rnd() * 4);
  const reads = [];
  for (let i = 0; i < nCand; i++) reads.push(Math.round(30 + Math.abs(gauss()) * (i === 0 ? 600 : 120)));
  reads.sort((a, b) => b - a);
  const total = reads.reduce((s, r) => s + r, 0);
  return reads.map((r) => ({ label: barcodeCombo(), confidence: round(r / total, 4), reads: r }));
}
function outlinePacked(cx, cy) {
  const nv = 8;
  const rad = 12 + rnd() * 16;
  const pts = [];
  for (let i = 0; i < nv; i++) {
    const a = (i / nv) * 2 * Math.PI;
    const rr = rad * (0.75 + rnd() * 0.5);
    pts.push(`${round(cx + Math.cos(a) * rr, 1)},${round(cy + Math.sin(a) * rr, 1)}`);
  }
  return pts.join('; ');
}

// --- minimal no-deps 8-bit grayscale PNG encoder ----------------------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
function grayPngBuffer(w, h, px) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // grayscale
  const raw = Buffer.alloc(h * (w + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (w + 1)] = 0;
    for (let x = 0; x < w; x++) raw[y * (w + 1) + 1 + x] = px[y * w + x];
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', Buffer.alloc(0))]);
}
function channelPixels(w, h, seed, nBlobs) {
  const r = mulberry32(seed);
  const px = new Uint8Array(w * h);
  const blobs = Array.from({ length: nBlobs }, () => ({
    cx: r() * w, cy: r() * h, rx: 6 + r() * 22, ry: 6 + r() * 22, amp: 45 + r() * 120,
  }));
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let v = 3;
      for (const b of blobs) {
        const dx = (x - b.cx) / b.rx;
        const dy = (y - b.cy) / b.ry;
        v += b.amp * Math.exp(-(dx * dx + dy * dy) / 2);
      }
      px[y * w + x] = Math.min(255, v);
    }
  return px;
}

// --- geometry ---------------------------------------------------------------
const A = 2200; // half-width (x)
const B = 1600; // half-height (y)
const N_SLICES = 2;
const PER_SLICE = 380;
const IMG_W = 200;
const IMG_H = 145;

// UMAP: cells cluster by cell type (8 blobs around a ring).
const UMAP_CENTERS = {};
CELL_TYPES.forEach((t, i) => {
  const ang = (i / CELL_TYPES.length) * 2 * Math.PI;
  UMAP_CENTERS[t] = { x: Math.cos(ang) * 9, y: Math.sin(ang) * 9 };
});

// --- generate cells ---------------------------------------------------------
const cells = [];
for (let s = 0; s < N_SLICES; s++) {
  const z = s * 150;
  const seeds = REGIONS.map((name, i) => {
    const ang = (i / REGIONS.length) * 2 * Math.PI + s * 0.15;
    const rad = 0.55 + 0.25 * ((i % 2) - 0.5);
    return { name, x: Math.cos(ang) * A * rad, y: Math.sin(ang) * B * rad };
  });
  let made = 0;
  let guard = 0;
  while (made < PER_SLICE && guard < PER_SLICE * 20) {
    guard++;
    const x = (rnd() * 2 - 1) * A;
    const y = (rnd() * 2 - 1) * B;
    if ((x * x) / (A * A) + (y * y) / (B * B) > 1) continue;
    made++;
    let region = seeds[0];
    let best = Infinity;
    for (const seed of seeds) {
      const d = (x - seed.x) ** 2 + (y - seed.y) ** 2;
      if (d < best) {
        best = d;
        region = seed;
      }
    }
    const trueType = weightedPick(REGION_TYPE_W[region.name]);
    const isNeuron = NEURON.has(trueType);
    const mCH = Math.max(0.001, (isNeuron ? 0.028 : 0.007) + gauss() * (isNeuron ? 0.008 : 0.002));
    const mCG = Math.min(0.9, Math.max(0.5, (isNeuron ? 0.76 : 0.71) + gauss() * 0.03));
    const uc = UMAP_CENTERS[trueType];
    const ct = rankedTypes(trueType);
    const bc = rankedBarcodes();
    cells.push({
      id: `cell-S${s}-${String(made).padStart(3, '0')}`,
      x: round(x, 1),
      y: round(y, 1),
      z,
      umap_1: round(uc.x + gauss() * 1.7, 3),
      umap_2: round(uc.y + gauss() * 1.7, 3),
      cell_type: ct[0].label,
      cell_type_conf: ct[0].confidence,
      cell_type_2: ct[1] ? ct[1].label : '',
      cell_type_2_conf: ct[1] ? ct[1].confidence : '',
      barcode: bc[0].label,
      barcode_conf: bc[0].confidence,
      barcode_reads: bc[0].reads,
      barcode_2: bc[1] ? bc[1].label : '',
      barcode_2_conf: bc[1] ? bc[1].confidence : '',
      barcode_2_reads: bc[1] ? bc[1].reads : '',
      mCH: round(mCH, 5),
      mCG: round(mCG, 4),
      region: region.name,
      section: `S${s}`,
      total_reads: Math.round(Math.exp(9.5 + gauss() * 0.8)),
      cis_ratio: round(Math.min(0.98, Math.max(0.4, 0.72 + gauss() * 0.08)), 3),
      donor: pick(DONORS),
      qc_score: round(0.5 + rnd() * 0.5, 3),
      outline: rnd() < 0.08 ? outlinePacked(x, y) : '',
    });
  }
}

// --- generate overlay images (2 sections x 3 fluorescence channels) ---------
fs.mkdirSync(imgDir, { recursive: true });
const CHANNELS = [
  { name: 'DAPI', color: '#5b8cff', blobs: 60 },
  { name: 'NeuN', color: '#46e39a', blobs: 30 },
  { name: 'Signal', color: '#ff6ec7', blobs: 15 },
];
const imgLayers = []; // { image_id, z, files: [{channel,color,rel,dataUri}] }
for (let s = 0; s < N_SLICES; s++) {
  const files = [];
  CHANNELS.forEach((ch, ci) => {
    const buf = grayPngBuffer(IMG_W, IMG_H, channelPixels(IMG_W, IMG_H, 1000 + s * 10 + ci, ch.blobs));
    const fname = `sec${s}_${ch.name.toLowerCase()}.png`;
    fs.writeFileSync(path.join(imgDir, fname), buf);
    files.push({ channel: ch.name, color: ch.color, rel: `images/${fname}`, dataUri: `data:image/png;base64,${buf.toString('base64')}` });
  });
  imgLayers.push({ image_id: `section${s}`, z: s * 150, files });
}

// --- write cells.tsv --------------------------------------------------------
function tsv(rows) {
  return rows.map((r) => r.join('\t')).join('\n') + '\n';
}
// Typed headers (cat_prototype_06): the suffix after `__` is the variable type;
// the second entry of each pair is the key on the generated cell object.
const cellCols = [
  ['id', 'id'], ['spatial_x__x0', 'x'], ['spatial_y__y0', 'y'], ['spatial_z__z0', 'z'], ['umap_1__x1', 'umap_1'], ['umap_2__y1', 'umap_2'],
  ['cell_type__ranked', 'cell_type'], ['cell_type_conf', 'cell_type_conf'],
  ['cell_type_2__ranked', 'cell_type_2'], ['cell_type_2_conf', 'cell_type_2_conf'],
  ['spatial_barcode__id', 'barcode'], ['barcode_conf__grad', 'barcode_conf'], ['barcode_reads__grad', 'barcode_reads'],
  ['mCH__grad', 'mCH'], ['mCG__grad', 'mCG'], ['region__cat', 'region'], ['section__cat', 'section'],
  ['total_reads__grad', 'total_reads'], ['cis_ratio__grad', 'cis_ratio'], ['donor__cat', 'donor'], ['qc_score__grad', 'qc_score'],
  ['outline', 'outline'],
];
const cellHeader = cellCols.map(([h]) => h);
const cellRows = [cellHeader, ...cells.map((c) => cellCols.map(([, k]) => c[k]))];
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'tissue-sample.cells.tsv'), tsv(cellRows));

// --- write images.tsv (relative paths) + images.datauri.tsv (embedded) ------
const imgHeader = [
  'image_id', 'label', 'group', 'x0', 'y0', 'x1', 'y1', 'z', 'opacity',
  'flip_x', 'flip_y', 'blend', 'channel', 'color', 'file',
];
function imageRows(useDataUri) {
  const rows = [imgHeader];
  for (const layer of imgLayers) {
    for (const f of layer.files) {
      rows.push([
        layer.image_id,
        `Section ${layer.image_id.slice(-1)} — multichannel`,
        'fluorescence',
        -A, -B, A, B,
        layer.z, 0.85, 0, 0, 'additive',
        f.channel, f.color, useDataUri ? f.dataUri : f.rel,
      ]);
    }
  }
  return rows;
}
fs.writeFileSync(path.join(outDir, 'tissue-sample.images.tsv'), tsv(imageRows(false)));
fs.writeFileSync(path.join(outDir, 'tissue-sample.images.datauri.tsv'), tsv(imageRows(true)));

// --- README -----------------------------------------------------------------
const readme = `# Maplet Viewer — example dataset (spreadsheet format)

Fully synthetic demo data (a small "brain" of ${cells.length} cells across
${N_SLICES} sections). It shows every part of the CSV/TSV save format. Not real data.

## Files

| file | what it is |
|------|------------|
| \`tissue-sample.cells.tsv\` | one row per cell — open it in Excel |
| \`tissue-sample.images.tsv\` | overlay images by **relative path** (→ \`images/\`) — for the desktop app |
| \`tissue-sample.images.datauri.tsv\` | the same images **embedded** — for the browser / single-file HTML |
| \`images/\` | the actual (synthetic) multichannel PNGs |

## How to load

**Desktop app** — the easy way: **Open folder** on this \`examples/\` folder. It
finds \`tissue-sample.cells.tsv\` + \`tissue-sample.images.tsv\` and loads cells and
images together. (Or **Open** the cells file, then **+ images** → the images file.)

**Browser / single-file \`MapletViewer.html\`** — **Open** (or drag) the cells
file, then **+ images** → \`tissue-sample.images.datauri.tsv\` (the browser can't
read local image files by path, so use the embedded one).

## What's inside \`cells.tsv\`

Each column declares its type in the header as \`name__type\`:

- \`id\`, \`x\`, \`y\`, \`z\` — position (structural, no tag). \`umap_1__umap\`,
  \`umap_2__umap\` — the **umap** type: UMAP axes used only to build the linked
  scatter (never coloured or filtered), clustered here by cell type.
- \`cell_type__ranked\` + \`cell_type_conf\` (+ \`cell_type_2__ranked\`,
  \`cell_type_2_conf\`) — a **ranked** call: confidence bars and a min-confidence filter.
- \`spatial_barcode__id\` — a high-cardinality **identifier**: never coloured, filtered
  by text search. \`barcode_conf__grad\`, \`barcode_reads__grad\` ride alongside.
- \`mCH__grad\`, \`mCG__grad\`, \`total_reads__grad\`, \`cis_ratio__grad\`, \`qc_score__grad\`
  — **gradients** (colormaps + range filters). \`region__cat\`, \`section__cat\`,
  \`donor__cat\` — **categories** (palette + checkboxes).
- \`outline\` — a few cells carry a segmentation polygon, packed as \`x,y; x,y; …\`.

Add your own \`name__type\` column and it becomes colorable/filterable automatically.

Regenerate with: \`node sample-data/make-example-tsv.mjs\`
`;
fs.writeFileSync(path.join(outDir, 'README.md'), readme);

// --- done -------------------------------------------------------------------
const kb = (p) => (fs.statSync(p).size / 1024).toFixed(0);
console.log(`Wrote examples/ — ${cells.length} cells, ${imgLayers.length} image layers (${CHANNELS.length} channels each).`);
console.log(`  tissue-sample.cells.tsv            (${kb(path.join(outDir, 'tissue-sample.cells.tsv'))} KB)`);
console.log(`  tissue-sample.images.tsv           (${kb(path.join(outDir, 'tissue-sample.images.tsv'))} KB, relative paths)`);
console.log(`  tissue-sample.images.datauri.tsv   (${kb(path.join(outDir, 'tissue-sample.images.datauri.tsv'))} KB, embedded)`);
console.log(`  images/*.png                       (${fs.readdirSync(imgDir).length} files)`);
console.log(`  README.md`);
