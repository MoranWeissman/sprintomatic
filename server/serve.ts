/**
 * The dashboard as a normal program: the data API plus the built screens from
 * `dist/`, on one port. `npm start` builds the screens and runs this.
 *
 * Two chats may start it at the same moment. The port settles it: the second
 * copy can't bind, says so, and quits. Nothing else needs a lock.
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApi } from './api';
import { DASHBOARD_PORT } from './dashboard-process';
import { contentType, resolveStatic } from './static-files';

const distDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const port = Number(process.env.SPRINTOMATIC_PORT) || DASHBOARD_PORT;
const api = createApi();

async function sendFile(path: string): Promise<{ type: string; data: Buffer } | null> {
  try {
    return { type: contentType(path), data: await readFile(path) };
  } catch {
    return null;
  }
}

const server = createServer(async (req, res) => {
  const url = req.url ?? '/';
  if (url === '/api' || url.startsWith('/api/') || url.startsWith('/api?')) return api(req, res);

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.statusCode = 405;
    return res.end();
  }
  const asked = resolveStatic(distDir, url);
  if (!asked) {
    res.statusCode = 404;
    return res.end();
  }
  // Anything that isn't a real file is a screen address: hand back the page.
  // Except a missing built file — that gets a plain 404, or the browser would
  // keep the page under that name forever (assets are cached for good).
  const isAsset = url.startsWith('/assets/');
  const file = (await sendFile(asked)) ?? (isAsset ? null : await sendFile(join(distDir, 'index.html')));
  if (!file && isAsset) {
    res.statusCode = 404;
    return res.end();
  }
  if (!file) {
    res.statusCode = 503;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    return res.end('The screens are not built yet. Run: npm start');
  }
  res.setHeader('Content-Type', file.type);
  // Built files under assets/ carry a hash in their name, so they never go
  // stale. The page itself must always be fresh, or a rebuild wouldn't show.
  res.setHeader('Cache-Control', isAsset ? 'public, max-age=31536000, immutable' : 'no-store');
  res.end(req.method === 'HEAD' ? undefined : file.data);
});

server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.log(`Port ${port} is taken — the dashboard is already running. Nothing to do.`);
    process.exit(0);
  }
  throw err;
});

// localhost only: the API has no password, so nothing outside this computer
// may reach it.
server.listen(port, 'localhost', () => {
  console.log(`Dashboard running at http://localhost:${port}`);
});
