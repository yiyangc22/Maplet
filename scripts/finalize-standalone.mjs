// Copy the single-file build to a friendly name at the project root.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const src = path.join(root, 'dist-web', 'index.html');
const dst = path.join(root, 'MapletViewer.html');

if (!fs.existsSync(src)) {
  console.error('Build output not found:', src);
  process.exit(1);
}
fs.copyFileSync(src, dst);
console.log(`Wrote ${path.relative(root, dst)}  (${(fs.statSync(dst).size / 1e6).toFixed(1)} MB)`);
console.log('Double-click it to run in any browser — no Node, no install.');
