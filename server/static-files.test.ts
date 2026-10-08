import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { contentType, resolveStatic } from './static-files';

const DIST = join('/srv', 'app', 'dist');

describe('resolveStatic', () => {
  it('maps the bare address to index.html', () => {
    expect(resolveStatic(DIST, '/')).toBe(join(DIST, 'index.html'));
    expect(resolveStatic(DIST, '/?mode=plan')).toBe(join(DIST, 'index.html'));
  });

  it('maps a built file to its place in dist', () => {
    expect(resolveStatic(DIST, '/assets/index-abc.js')).toBe(join(DIST, 'assets', 'index-abc.js'));
  });

  it('never hands out a file outside dist, however the path climbs', () => {
    const tries = ['/../../etc/passwd', '/%2e%2e/%2e%2e/etc/passwd', '/assets/../../secret', '/..%5c..%5csecret', '/../dist-other/x.js'];
    for (const t of tries) {
      const file = resolveStatic(DIST, t);
      if (file !== null) expect(file.startsWith(DIST + '/') || file.startsWith(DIST + '\\')).toBe(true);
    }
  });

  it('refuses broken escapes and null bytes', () => {
    expect(resolveStatic(DIST, '/%E0%A4%A')).toBeNull();
    expect(resolveStatic(DIST, '/index.html%00.png')).toBeNull();
  });
});

describe('contentType', () => {
  it('knows the built file kinds and falls back to binary', () => {
    expect(contentType('a/index.html')).toMatch(/text\/html/);
    expect(contentType('x.JS')).toMatch(/javascript/);
    expect(contentType('x.bin')).toBe('application/octet-stream');
  });
});
