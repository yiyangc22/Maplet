// Generate the built-in SAMPLE dataset for cat_prototype_06 as a TYPED CSV/TSV
// spreadsheet — the only cell-input format this version accepts. It shows every
// declared variable type in the header (`name__type`):
//   cell_type__ranked (+ cell_type_conf, cell_type_2__ranked, cell_type_2_conf)
//   spatial_barcode__id      a high-cardinality identifier (never coloured)
//   barcode_conf__grad, mCH__grad, mCG__grad, total_reads__grad, qc_score__grad
//   region__cat, section__cat, donor__cat
//   umap_1__umap, umap_2__umap   UMAP axes (structural — only build the scatter)
//   id, x, y, z, outline         structural — no type tag
//
// Writes:
//   sample-data/sample.cells.tsv     (Electron reads this for the Sample button)
//   src/platform/sampleData.ts       (embedded string — browser / single-file)
//
// Fully synthetic. Run:  node sample-data/make_sample_tsv.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

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
const rnd = mulberry32(20260713);
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
  const others = CELL_TYPES.filter((t) => t !== trueType);
  const alt = pick(others);
  const altConf = round(Math.max(0.01, (1 - conf) * (0.3 + rnd() * 0.5)));
  return { top: trueType, topConf: round(conf), alt, altConf };
}
// A spatial barcode: 5 of 20 ports, applied together (I01..I20). Thousands of
// distinct combos exist -> a high-cardinality identifier, never a colour axis.
function barcodeCombo() {
  const ports = new Set();
  while (ports.size < 5) ports.add(1 + Math.floor(rnd() * 20));
  return [...ports].sort((a, b) => a - b).map((p) => `I${String(p).padStart(2, '0')}`).join('-');
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

// --- geometry ---------------------------------------------------------------
const A = 2200; // half-width (x)
const B = 1600; // half-height (y)
const N_SLICES = 3;
const PER_SLICE = 340;

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
    cells.push({
      id: `cell-S${s}-${String(made).padStart(3, '0')}`,
      spatial_x__x0: round(x, 1),
      spatial_y__y0: round(y, 1),
      spatial_z__z0: z,
      umap_1__x1: round(uc.x + gauss() * 1.7, 3),
      umap_2__y1: round(uc.y + gauss() * 1.7, 3),
      cell_type__ranked: ct.top,
      cell_type_conf: ct.topConf,
      cell_type_2__ranked: ct.alt,
      cell_type_2_conf: ct.altConf,
      spatial_barcode__id: barcodeCombo(),
      barcode_conf__grad: round(0.3 + rnd() * 0.65, 3),
      mCH__grad: round(mCH, 5),
      mCG__grad: round(mCG, 4),
      region__cat: region.name,
      section__cat: `S${s}`,
      donor__cat: pick(DONORS),
      total_reads__grad: Math.round(Math.exp(9.5 + gauss() * 0.8)),
      qc_score__grad: round(0.5 + rnd() * 0.5, 3),
      outline: rnd() < 0.06 ? outlinePacked(x, y) : '',
    });
  }
}

// --- write TSV --------------------------------------------------------------
const HEADER = [
  'id', 'spatial_x__x0', 'spatial_y__y0', 'spatial_z__z0', 'umap_1__x1', 'umap_2__y1',
  'cell_type__ranked', 'cell_type_conf', 'cell_type_2__ranked', 'cell_type_2_conf',
  'spatial_barcode__id', 'barcode_conf__grad', 'mCH__grad', 'mCG__grad',
  'region__cat', 'section__cat', 'donor__cat', 'total_reads__grad', 'qc_score__grad', 'outline',
];
const tsv = [HEADER.join('\t'), ...cells.map((c) => HEADER.map((k) => c[k]).join('\t'))].join('\n') + '\n';

fs.writeFileSync(path.join(root, 'sample-data', 'sample.cells.tsv'), tsv);

// Embed for the browser / single-file HTML (fetch is blocked under file://).
const ts = `// AUTO-GENERATED by sample-data/make_sample_tsv.mjs — do not edit by hand.
// The built-in sample dataset, as a typed CSV/TSV cells table (${cells.length} cells).
// It demonstrates every declared variable type: grad / cat / id / ranked.
export const SAMPLE_CELLS_TSV = ${JSON.stringify(tsv)};
`;
fs.writeFileSync(path.join(root, 'src', 'platform', 'sampleData.ts'), ts);

const kb = (fs.statSync(path.join(root, 'sample-data', 'sample.cells.tsv')).size / 1024).toFixed(0);
console.log(`Wrote sample-data/sample.cells.tsv and src/platform/sampleData.ts — ${cells.length} cells (${kb} KB).`);
