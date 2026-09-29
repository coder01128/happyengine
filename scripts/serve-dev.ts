// A tiny local web server for the developer test pages in dev/ (nothing to do with the app).
// Usage: node scripts/serve-dev.ts   then open http://localhost:5174/dev/highlight-test.html
//   /dev/…       the dev/ folder
//   /fixtures/…  eval/fixtures/ (the test PDF, its known word positions, saved parses)
//   /vendor/pdfjs/…  the installed pdfjs-dist build, so the page uses the same PDF.js version as the code
// Only these three folders are served; it listens on this computer only.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { extname, join, resolve, sep } from 'node:path';
import { root } from './local.ts';

const port = Number(process.env.PORT ?? 5174);
const pdfjsBuild = join(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'), '..', 'build');
const mounts: [string, string][] = [
  ['/dev/', join(root, 'dev')],
  ['/fixtures/', join(root, 'eval', 'fixtures')],
  ['/vendor/pdfjs/', pdfjsBuild],
];
const types: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.pdf': 'application/pdf',
  '.css': 'text/css; charset=utf-8',
};

createServer(async (req, res) => {
  const path = decodeURIComponent((req.url ?? '/').split('?')[0]!);
  const mount = mounts.find(([prefix]) => path.startsWith(prefix));
  if (!mount) {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
    return;
  }
  const file = resolve(mount[1], path.slice(mount[0].length));
  if (file !== mount[1] && !file.startsWith(mount[1] + sep)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' }).end('Forbidden');
    return;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': types[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' }).end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
  }
}).listen(port, '127.0.0.1', () => {
  console.log(`Serving on http://localhost:${port}/dev/highlight-test.html  (Ctrl+C to stop)`);
});
