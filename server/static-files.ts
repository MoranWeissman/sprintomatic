/**
 * Picks the file to send for a screen request, from the built dashboard in
 * `dist/`. Pure — server/serve.ts does the reading and sending.
 */
import { extname, join, normalize, sep } from 'node:path';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
};

export function contentType(file: string): string {
  return TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream';
}

/**
 * The file inside `distDir` this URL asks for, or null when the URL points
 * outside it (`/../../.ssh/id_rsa` and the like). An empty path means the
 * page itself. Whether the file exists is the caller's question — a path that
 * isn't a file falls back to index.html, since the screens keep their state
 * in the address, not in real files.
 */
export function resolveStatic(distDir: string, urlPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath.split('?')[0]);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  const rel = normalize(decoded).replace(/^[/\\]+/, '');
  const file = join(distDir, rel || 'index.html');
  const root = distDir.endsWith(sep) ? distDir : distDir + sep;
  return file.startsWith(root) ? file : null;
}
