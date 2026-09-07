// Dev helper: serve ONE html file at '/', 404 everything else. Used to test the
// standalone build the way file:// behaves (sibling fetches fail -> embedded
// sample path is exercised). Not part of the app.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = path.resolve(root, process.argv[2] || 'MapletViewer.html');
const port = parseInt(process.argv[3] || '5175', 10);

http
  .createServer((req, res) => {
    const p = (req.url || '/').split('?')[0];
    if (p === '/' || p === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(fs.readFileSync(file));
    } else {
      res.writeHead(404);
      res.end('not found');
    }
  })
  .listen(port, '127.0.0.1', () => console.log('serving', file, 'on', port));
