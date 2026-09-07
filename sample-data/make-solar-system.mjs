// Generate a 4D (3D + time) sample for the Maplet viewer: solar-system bodies
// orbiting the Sun. Real orbital elements — the inner planets (J2000 mean
// elements) plus large main-belt asteroids and near-Earth objects fetched live
// from NASA/JPL's Small-Body Database — are propagated with a Kepler solver over
// a sequence of time frames, and written in the LONG (one row per body per frame)
// two-row-header format the parser turns into per-point position tracks.
//
// Run with the bundled node:
//   ./tools/node/win-x64/node.exe sample-data/make-solar-system.mjs
//
// Output: sample-data/solar-system.cells.tsv

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'solar-system.cells.tsv');

const N_FRAMES = 150;
const DT_DAYS = 12; // ~5-year window: the main belt completes about one orbit
const T0 = 2451545.0; // J2000 epoch (JD); planet elements are referenced here
const DEG = Math.PI / 180;

// ---- Kepler propagation ---------------------------------------------------

function solveKepler(M, e) {
  // M normalised to (-pi, pi] for fast, stable convergence.
  let m = M % (2 * Math.PI);
  if (m > Math.PI) m -= 2 * Math.PI;
  if (m < -Math.PI) m += 2 * Math.PI;
  let E = e < 0.8 ? m : Math.PI * Math.sign(m || 1);
  for (let k = 0; k < 60; k++) {
    const d = (E - e * Math.sin(E) - m) / (1 - e * Math.cos(E));
    E -= d;
    if (Math.abs(d) < 1e-12) break;
  }
  return E;
}

// Heliocentric ecliptic position (AU) at mean anomaly M (rad) for elements
// a (AU), e, i/Om/w (rad).
function positionAt(a, e, i, Om, w, M) {
  const E = solveKepler(M, e);
  const xo = a * (Math.cos(E) - e);
  const yo = a * Math.sqrt(Math.max(0, 1 - e * e)) * Math.sin(E);
  const cO = Math.cos(Om), sO = Math.sin(Om);
  const cw = Math.cos(w), sw = Math.sin(w);
  const ci = Math.cos(i), si = Math.sin(i);
  const x = (cO * cw - sO * sw * ci) * xo + (-cO * sw - sO * cw * ci) * yo;
  const y = (sO * cw + cO * sw * ci) * xo + (-sO * sw + cO * cw * ci) * yo;
  const z = (sw * si) * xo + (cw * si) * yo;
  return [x, y, z];
}

// Mean motion in rad/day from Kepler's third law (heliocentric): P = a^1.5 years.
const meanMotion = (a) => (2 * Math.PI) / (365.25 * Math.pow(a, 1.5));

// A body: elements + epoch (JD) at which meanAnomaly (deg) holds.
function makeBody({ id, cls, a, e, i, om, w, ma, epoch, diameter }) {
  const n = meanMotion(a);
  const mAtT0 = ma * DEG + n * (T0 - epoch); // mean anomaly at the common start
  return {
    id, cls, a, e, i, diameter,
    frameCoord(f) {
      const M = mAtT0 + n * (f * DT_DAYS);
      return positionAt(a, e, i * DEG, om * DEG, w * DEG, M);
    },
  };
}

// ---- Inner planets (J2000 mean elements; epoch = T0) ----------------------

const PLANETS = [
  { id: 'Mercury', a: 0.38710, e: 0.20563, i: 7.005, om: 48.331, w: 29.124, ma: 174.796, diameter: 4879 },
  { id: 'Venus', a: 0.72333, e: 0.00677, i: 3.395, om: 76.680, w: 54.884, ma: 50.115, diameter: 12104 },
  { id: 'Earth', a: 1.00000, e: 0.01671, i: 0.000, om: 0.0, w: 102.937, ma: 357.529, diameter: 12742 },
  { id: 'Mars', a: 1.52371, e: 0.09339, i: 1.850, om: 49.558, w: 286.502, ma: 19.373, diameter: 6779 },
  { id: 'Jupiter', a: 5.20288, e: 0.04839, i: 1.304, om: 100.464, w: 273.867, ma: 20.020, diameter: 139820 },
].map((p) => makeBody({ ...p, epoch: T0, cls: 'Planet' }));

const SUN = {
  id: 'Sun', cls: 'Sun', a: 0, e: 0, i: 0, diameter: 1391000,
  frameCoord: () => [0, 0, 0],
};

// ---- Real small bodies from JPL SBDB --------------------------------------

async function sbdbQuery(constraints, limit) {
  const fields = 'full_name,a,e,i,om,w,ma,epoch,diameter,class';
  const url =
    'https://ssd-api.jpl.nasa.gov/sbdb_query.api?fields=' +
    encodeURIComponent(fields) +
    '&sb-cdata=' +
    encodeURIComponent(JSON.stringify({ AND: constraints })) +
    '&limit=' +
    limit;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`SBDB ${res.status}`);
  const json = await res.json();
  const idx = Object.fromEntries(json.fields.map((f, k) => [f, k]));
  const out = [];
  for (const row of json.data ?? []) {
    const num = (f) => parseFloat(row[idx[f]]);
    const a = num('a'), e = num('e'), i = num('i'), om = num('om'), w = num('w'), ma = num('ma'), epoch = num('epoch');
    const diameter = num('diameter');
    if (![a, e, i, om, w, ma, epoch].every(Number.isFinite)) continue;
    const rawName = String(row[idx.full_name]).trim();
    const name = rawName.replace(/\s+/g, ' ').replace(/\s*\(.*\)$/, ''); // "1 Ceres (A801 AA)" -> "1 Ceres"
    const sbClass = String(row[idx.class] ?? '').trim();
    let cls = 'Main-belt asteroid';
    if (['AMO', 'APO', 'ATE', 'IEO'].includes(sbClass)) cls = 'Near-Earth asteroid';
    else if (sbClass === 'TJN') cls = 'Jupiter trojan';
    if (/^1 Ceres/.test(name)) cls = 'Dwarf planet';
    out.push(makeBody({ id: name, cls, a, e, i, om, w, ma, epoch, diameter: Number.isFinite(diameter) ? diameter : NaN }));
  }
  return out;
}

// ---- Assemble + propagate + write -----------------------------------------

async function main() {
  console.log('Fetching real small bodies from JPL SBDB…');
  // Large main-belt asteroids (known diameter) + a spread of sizeable near-Earth objects.
  const belt = await sbdbQuery(['a|GT|2.0', 'a|LT|3.4', 'diameter|GT|45'], 140);
  const neo = await sbdbQuery(['a|LT|1.9', 'diameter|GT|1.5'], 30);
  console.log(`  main-belt: ${belt.length}, near-Earth: ${neo.length}`);

  const bodies = [SUN, ...PLANETS, ...belt, ...neo];

  const names = ['body', 'frame', 'orbit', 'orbit', 'orbit', 'class', 'a_au', 'ecc', 'incl_deg', 'diameter_km'];
  const types = ['id', 'frame', 'x', 'y', 'z', 'cat', 'grad', 'grad', 'grad', 'grad'];
  const lines = [names.join('\t'), types.join('\t')];

  const fmt = (v) => (Number.isFinite(v) ? (Math.abs(v) < 1e-6 ? '0' : v.toFixed(5)) : '');
  let rows = 0;
  for (const b of bodies) {
    for (let f = 0; f < N_FRAMES; f++) {
      const [x, y, z] = b.frameCoord(f);
      // Static per-body properties ride only on frame 0 (blank after) — the parser
      // carries them forward, which also shrinks the file and demos carry-forward.
      const props =
        f === 0
          ? [b.cls, fmt(b.a), fmt(b.e), fmt(b.i), Number.isFinite(b.diameter) ? String(Math.round(b.diameter)) : '']
          : ['', '', '', '', ''];
      lines.push([b.id, String(f), fmt(x), fmt(y), fmt(z), ...props].join('\t'));
      rows++;
    }
  }

  fs.writeFileSync(OUT, lines.join('\n') + '\n');
  console.log(`Wrote ${OUT}`);
  console.log(`  ${bodies.length} bodies × ${N_FRAMES} frames = ${rows} rows`);
}

main().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
