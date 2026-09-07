// Copy the single-file build to a friendly name at the project root (download &
// double-click), AND to docs/index.html so GitHub Pages serves it live (Settings ▸
// Pages ▸ Deploy from a branch ▸ main /docs).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const src = path.join(root, 'dist-web', 'index.html');

if (!fs.existsSync(src)) {
  console.error('Build output not found:', src);
  process.exit(1);
}

const html = fs.readFileSync(src);
const outputs = [
  path.join(root, 'MapletViewer.html'), // download & run
  path.join(root, 'docs', 'index.html'), // GitHub Pages
];
for (const dst of outputs) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.writeFileSync(dst, html);
  console.log(`Wrote ${path.relative(root, dst)}  (${(fs.statSync(dst).size / 1e6).toFixed(1)} MB)`);
}
console.log('Double-click MapletViewer.html to run, or serve docs/ via GitHub Pages.');
