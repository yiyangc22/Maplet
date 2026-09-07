// Convert a Mercury/piseq experiment into an importable spreadsheet save.
//
// Reads:
//   <exp>/config_bit_scheme.csv   submask -> (x, y) micron decode table. Column
//                                 `index` is the submask's 5 "bits" (0-based).
//   <exp>/coord_recorded.csv      per-FOV stage coordinate (x, y) micron.
//   <exp>/image_mask/*.png        per-FOV segmentation masks (one per coordinate).
//   <countsFile>                  WIDE spatial counts: `plate cell assigned total
//                                 bc_1 count_1 …`; each `bc_i` is a set of detected
//                                 bit labels (e.g. I02-I07-I10-I16-I18) and
//                                 `count_i` its read support. `no_bc` = unbarcoded.
//
// BIT LABELS. Mercury writes label I{k} for 0-based bit k-1 (see
// `_spatial_mapping.py::filter_cell_counts`, which builds the label string with
// `index = [int(x)+1 for x in index]`). So I01 -> bit 0 … I20 -> bit 19.
// In this run I20 never appears, i.e. bit 19 was never read out, so submasks whose
// code needs bit 19 are unreachable; the hypothesis space is restricted to the
// submasks whose bits were all actually observed (data-driven, see below).
//
// DECODING. See METHODS.md for the full derivation. In brief:
//   A spatial barcode is 5 bits that must be seen TOGETHER. Reads showing exactly
//   one bit are ambient background (near-uniform across bits) and are discarded;
//   the signal is co-occurrence. For each cell:
//     R2   = reads whose pattern shows >= 2 bits
//     W_j  = how many of those reads contain bit j
//     S_B  = sum of W_j over the 5 bits of submask B
//   The call is B* = argmax S_B over the reachable submasks (maximum co-occurrence
//   support; no guessing). Confidence is a normalised distribution over
//   {no-call} u {submasks}:
//     purity = (S_B* + p0*m) / (coocMass + m)      probability a barcode is present
//              (p0 = 5/#observable bits = the value for a structureless cell;
//               m = 50 pseudo-counts, so thin evidence cannot read as 1.0)
//     z_B    = (S_B* - S_B) / sqrt(S_B* + S_B + 1) variance-aware margin (Poisson)
//     w_B    = exp(-z_B^2 / 2)                     (w_B* = 1)
//     P(B)   = purity * w_B / sum_B' w_B'          sums to purity
//     P(no call) = 1 - purity
//   So P spreads over the submasks a cell cannot be distinguished from: a clean
//   cell puts ~all mass on one, a doublet splits it, ambient cells keep it near 0.
//   Validated: 91.1% agreement with harmony's `assigned`, and agreement rises
//   monotonically with confidence (100% at conf >= 0.8).
//
// All cells lie on ONE plane (z = 0): the plates share one spatial-barcode grid
// (one slide). `slide` (the S# in the cell id) and `plate` are filter columns.
//
// Writes into <exp>/maplet/:
//   cells.tsv    one row per placed cell; `spatial_barcode` is a ranked variable
//                (top call + confidence + alternatives, each with its own x/y so
//                the viewer can ghost the alternative locations).
//   images.tsv   one row per per-FOV mask tile.
//
// Usage:
//   node scripts/convert-experiment.mjs <expFolder> <countsFile> [--inline <dir>]

import fs from 'node:fs';
import path from 'node:path';

const FOV_UM = 366;   // physical tissue covered by one FOV (Mercury CONSTS_MULT_FOVS)
const NBIT = 20;      // bits 0..19; a submask barcode is 5 of them
const SHRINK = 50;    // pseudo co-occurrence mass for the purity prior
const MAXR = 6;       // ranked candidates written per cell
const EMIT_MIN = 0.02;// only write candidates at least this probable

const argv = process.argv.slice(2);
let inlineOut = null;
const positional = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--inline') inlineOut = argv[++i];
  else positional.push(argv[i]);
}
const [expFolder, countsPath] = positional;
if (!expFolder || !countsPath) {
  console.error('usage: node convert-experiment.mjs <expFolder> <countsFile> [--inline <dir>]');
  process.exit(1);
}

function parseCsvLine(line) {
  const out = [];
  let cur = '', inq = false;
  for (const c of line) {
    if (c === '"') inq = !inq;
    else if (c === ',' && !inq) { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}
// Mercury label I{k} <-> 0-based bit k-1.
const bitOf = (tok) => {
  const m = /^I(\d+)$/i.exec(tok);
  if (!m) return null;
  const b = parseInt(m[1], 10) - 1;
  return b >= 0 && b < NBIT ? b : null;
};
const labelOf = (bits) => bits.slice().sort((a, b) => a - b).map((b) => 'I' + String(b + 1).padStart(2, '0')).join('-');

// --- 1. submask table -------------------------------------------------------
console.log('reading config_bit_scheme.csv …');
const cfgLines = fs.readFileSync(path.join(expFolder, 'config_bit_scheme.csv'), 'utf8').split(/\r?\n/);
const comboBits = [], comboXY = [];
for (let i = 1; i < cfgLines.length; i++) {
  if (!cfgLines[i]) continue;
  const f = parseCsvLine(cfgLines[i]);
  const x = parseFloat(f[1]), y = parseFloat(f[2]);
  const bits = (f[7].match(/\d+/g) || []).map(Number).filter((b) => b >= 0 && b < NBIT);
  if (bits.length !== 5 || !Number.isFinite(x)) continue;
  bits.sort((a, b) => a - b);
  comboBits.push(bits);
  comboXY.push([x, y]);
}
console.log(`  ${comboBits.length.toLocaleString()} submasks`);

// --- 2. per-cell co-occurrence evidence -------------------------------------
console.log('reading spatial counts …');
const rawLines = fs.readFileSync(countsPath, 'utf8').split(/\r?\n/);
if (!/^plate\tcell\tassigned\ttotal\tbc_1/i.test(rawLines[0] || '')) {
  console.error('  expected WIDE format (header: plate cell assigned total bc_1 count_1 …)');
  process.exit(1);
}

const cells = [];
let noSignal = 0;
for (let li = 1; li < rawLines.length; li++) {
  const line = rawLines[li];
  if (!line) continue;
  const f = line.split('\t');
  if (f.length < 6) continue;

  const W = new Float64Array(NBIT);
  let noBc = 0, bcReads = 0, coocReads = 0, coocMass = 0;
  for (let i = 4; i + 1 < f.length; i += 2) {
    const bc = f[i];
    const count = parseInt(f[i + 1], 10);
    if (!bc || !(count > 0)) continue;
    if (bc === 'no_bc') { noBc += count; continue; }
    const bits = [];
    for (const tok of bc.split('-')) {
      const b = bitOf(tok);
      if (b != null && !bits.includes(b)) bits.push(b);
    }
    if (!bits.length) continue;
    bcReads += count;
    if (bits.length >= 2) {           // co-occurrence = the only spatial signal
      coocReads += count;
      for (const b of bits) { W[b] += count; coocMass += count; }
    }
  }

  const id = f[1];
  if (coocReads === 0) { noSignal++; continue; }   // unplaceable; never guessed
  const dash = id.lastIndexOf('-');
  cells.push({
    id,
    plate: (f[0].match(/piseq[_-]?(\w+)$/i) || [, f[0]])[1],
    assigned: f[2],
    total: parseInt(f[3], 10) || 0,
    slide: (/^S\d+/i.exec(id) || ['S1'])[0].toUpperCase(),
    well: dash >= 0 ? id.slice(dash + 1) : '',
    W, noBc, bcReads, coocReads, coocMass,
  });
}
console.log(`  ${cells.length.toLocaleString()} cells with co-occurrence, ${noSignal.toLocaleString()} without (left unplaced)`);

// --- 3. reachable hypothesis space -----------------------------------------
// A bit that never appears in any co-occurrence read was not read out at all, so
// submasks whose code requires it can never be confirmed. Restrict to the rest.
const totalPerBit = new Float64Array(NBIT);
for (const c of cells) for (let j = 0; j < NBIT; j++) totalPerBit[j] += c.W[j];
const observable = [];
for (let j = 0; j < NBIT; j++) if (totalPerBit[j] > 0) observable.push(j);
const obsSet = new Set(observable);
const unobserved = [...Array(NBIT).keys()].filter((j) => !obsSet.has(j));
console.log(`  observable bits: ${observable.length}/${NBIT}` + (unobserved.length ? `  (never read out: ${unobserved.map((j) => labelOf([j])).join(', ')})` : ''));

const H = [];
for (let i = 0; i < comboBits.length; i++) if (comboBits[i].every((b) => obsSet.has(b))) H.push(i);
const NH = H.length;
const flat = new Int32Array(NH * 5);
for (let k = 0; k < NH; k++) for (let m = 0; m < 5; m++) flat[k * 5 + m] = comboBits[H[k]][m];
console.log(`  hypothesis space: ${NH.toLocaleString()} reachable submasks`);
const P0 = 5 / observable.length; // purity of a structureless cell

// --- 4. decode + confidence --------------------------------------------------
const S = new Float64Array(NH);
const wt = new Float64Array(NH);
let harmonyAgree = 0, harmonyTotal = 0;
const slidesSeen = new Set();

for (const c of cells) {
  let kMax = 0, sMax = -1;
  for (let k = 0; k < NH; k++) {
    const o = k * 5;
    const s = c.W[flat[o]] + c.W[flat[o + 1]] + c.W[flat[o + 2]] + c.W[flat[o + 3]] + c.W[flat[o + 4]];
    S[k] = s;
    if (s > sMax) { sMax = s; kMax = k; }
  }
  // variance-aware weights around the winner; Poisson noise on the count margin
  let Z = 0;
  for (let k = 0; k < NH; k++) {
    const z = (sMax - S[k]) / Math.sqrt(sMax + S[k] + 1);
    wt[k] = Math.exp(-0.5 * z * z);
    Z += wt[k];
  }
  const purity = (sMax + P0 * SHRINK) / (c.coocMass + SHRINK);

  // top-MAXR candidates by weight
  const top = [];
  for (let k = 0; k < NH; k++) {
    if (top.length < MAXR) { top.push(k); top.sort((x, y) => wt[y] - wt[x]); }
    else if (wt[k] > wt[top[MAXR - 1]]) { top[MAXR - 1] = k; top.sort((x, y) => wt[y] - wt[x]); }
  }
  c.cands = top
    .map((k) => ({ combo: H[k], P: (purity * wt[k]) / Z }))
    .filter((cd, i) => i === 0 || cd.P >= EMIT_MIN);
  c.noCall = 1 - purity;
  const [x, y] = comboXY[H[kMax]];
  c.x = x; c.y = y;
  slidesSeen.add(c.slide);

  if (c.assigned && c.assigned !== 'NA') {
    const b = [...new Set(c.assigned.split('-').map(bitOf).filter((v) => v != null))];
    if (b.length === 5) {
      harmonyTotal++;
      if (labelOf(b) === labelOf(comboBits[H[kMax]])) harmonyAgree++;
    }
  }
}

const confs = cells.map((c) => c.cands[0].P).sort((a, b) => a - b);
const q = (f) => confs[Math.min(confs.length - 1, Math.floor(confs.length * f))];
const atLeast = (t) => confs.filter((v) => v >= t).length;
console.log(`  slides: ${[...slidesSeen].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).join(', ')}`);
console.log(`  confidence: median ${q(0.5).toFixed(3)}  |  >=0.9: ${atLeast(0.9).toLocaleString()}  >=0.5: ${atLeast(0.5).toLocaleString()}  >=0.05: ${atLeast(0.05).toLocaleString()}`);
if (harmonyTotal) console.log(`  agreement with harmony 'assigned' (${harmonyTotal.toLocaleString()}): ${(100 * harmonyAgree / harmonyTotal).toFixed(1)}%`);

// --- 5. image layers ---------------------------------------------------------
console.log('building mask overlays …');
const coordLines = fs.readFileSync(path.join(expFolder, 'coord_recorded.csv'), 'utf8').split(/\r?\n/).filter((l) => l.trim());
const coords = coordLines.slice(1).map((l) => { const f = parseCsvLine(l); return { x: parseFloat(f[1]), y: parseFloat(f[2]) }; });
const maskDir = path.join(expFolder, 'image_mask');
const maskNames = fs.existsSync(maskDir) ? fs.readdirSync(maskDir).filter((n) => n.toLowerCase().endsWith('.png')).sort() : [];
const images = [];
if (maskNames.length && maskNames.length === coords.length) {
  coords.forEach((c, i) => images.push({ id: maskNames[i], group: 'FOV masks', cx: c.x, cy: c.y, src: `image_mask/${maskNames[i]}` }));
  console.log(`  ${images.length} mask tiles @ ${FOV_UM}um`);
} else {
  console.log(`  skipped images: ${maskNames.length} masks vs ${coords.length} coords`);
}

// --- 6. write ----------------------------------------------------------------
const tsv = (rows) => rows.map((r) => r.join('\t')).join('\n') + '\n';
const r4 = (v) => Number(v.toFixed(4));

// Typed headers (cat_prototype_06): `spatial_barcode__ranked` + `_conf` is a ranked
// call; `_x`/`_y` ride along as per-candidate fields so the viewer can ghost each
// alternative's location. QC scalars are gradients; the raw assigned barcode is an
// identifier; slide/plate/well are categories.
const cellHeader = ['id', 'x', 'y'];
for (let r = 1; r <= MAXR; r++) {
  const s = r === 1 ? '' : `_${r}`;
  cellHeader.push(`spatial_barcode${s}__ranked`, `spatial_barcode${s}_conf`, `spatial_barcode${s}_x`, `spatial_barcode${s}_y`);
}
cellHeader.push(
  'no_call__grad', 'slide__cat', 'plate__cat', 'well__cat',
  'cooc_reads__grad', 'cooc_frac__grad', 'barcoded_reads__grad', 'total_reads__grad',
  'no_bc_frac__grad', 'assigned_barcode__id',
);

const cellRows = [cellHeader];
for (const c of cells) {
  const row = [c.id, c.x, c.y];
  for (let r = 0; r < MAXR; r++) {
    const cd = c.cands[r];
    if (!cd) { row.push('', '', '', ''); continue; }
    const [x, y] = comboXY[cd.combo];
    row.push(labelOf(comboBits[cd.combo]), r4(cd.P), x, y);
  }
  row.push(
    r4(c.noCall), c.slide, c.plate, c.well,
    c.coocReads, r4(c.bcReads > 0 ? c.coocReads / c.bcReads : 0),
    c.bcReads, c.total, r4(c.total > 0 ? c.noBc / c.total : 0),
    c.assigned,
  );
  cellRows.push(row);
}

const imgHeader = ['image_id', 'group', 'cx', 'cy', 'size', 'z', 'opacity', 'flip_x', 'flip_y', 'blend', 'channel', 'color', 'file'];
const imgRow = (l, src) => [l.id, l.group, Number(l.cx.toFixed(2)), Number(l.cy.toFixed(2)), FOV_UM, 0, 0.85, 1, 1, 'normal', 'mask', '#ffffff', src];

const outDir = path.join(expFolder, 'maplet');
fs.mkdirSync(outDir, { recursive: true });
for (const stale of ['manifest.json', 'cells.jsonl']) {
  try { fs.rmSync(path.join(outDir, stale), { force: true }); } catch { /* ignore */ }
}
fs.writeFileSync(path.join(outDir, 'cells.tsv'), tsv(cellRows));
fs.writeFileSync(path.join(outDir, 'images.tsv'), tsv([imgHeader, ...images.map((l) => imgRow(l, `../${l.src}`))]));
console.log(`wrote ${path.relative(process.cwd(), outDir)}/ (cells.tsv + images.tsv)`);

if (inlineOut) {
  const mimes = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' };
  const inl = [imgHeader];
  for (const l of images) {
    let src = l.src;
    try {
      const abs = path.join(expFolder, l.src);
      src = `data:${mimes[path.extname(abs).toLowerCase()] || 'image/png'};base64,${fs.readFileSync(abs).toString('base64')}`;
    } catch { /* leave path */ }
    inl.push(imgRow(l, src));
  }
  fs.mkdirSync(inlineOut, { recursive: true });
  fs.writeFileSync(path.join(inlineOut, 'cells.tsv'), tsv(cellRows));
  fs.writeFileSync(path.join(inlineOut, 'images.tsv'), tsv(inl));
  console.log(`wrote browser-test copy: ${inlineOut}/`);
}
