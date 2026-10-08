import { describe, it, expect } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { router } from './api';

function fakeRes() {
  const res = {
    statusCode: 200,
    headersSent: false,
    body: '',
    setHeader() {},
    end(b?: string) { res.body = b ?? ''; },
  };
  return res;
}

function call(r: ReturnType<typeof router>, url: string) {
  const req = { url, method: 'GET', headers: {} } as unknown as IncomingMessage;
  const res = fakeRes();
  r.handle(req, res as unknown as ServerResponse);
  return res;
}

describe('the API router', () => {
  it('hands a route the path after its prefix, query kept', () => {
    const r = router();
    let seen = '';
    r.use('/api/workitem/', (req, res) => { seen = req.url ?? ''; res.end(); });
    call(r, '/api/workitem/100001/edit?x=1');
    expect(seen).toBe('/100001/edit?x=1');
  });

  it('gives a route mounted on exactly its address a bare slash', () => {
    const r = router();
    let seen = '';
    r.use('/api/retro', (req, res) => { seen = req.url ?? ''; res.end(); });
    call(r, '/api/retro');
    expect(seen).toBe('/');
  });

  it('does not match a longer word that only starts the same', () => {
    const r = router();
    const hit: string[] = [];
    r.use('/api/retro', (_q, res) => { hit.push('retro'); res.end(); });
    r.use('/api/retrospective', (_q, res) => { hit.push('long'); res.end(); });
    call(r, '/api/retrospective');
    expect(hit).toEqual(['long']);
  });

  it('tries routes in order and lets next() pass along with the url restored', () => {
    const r = router();
    let seen = '';
    r.use('/api', (_q, _s, next) => next());
    r.use('/api/health', (req, res) => { seen = req.url ?? ''; res.end('ok'); });
    expect(call(r, '/api/health').body).toBe('ok');
    expect(seen).toBe('/');
  });

  it('answers 404 when nothing matches', () => {
    const res = call(router(), '/api/nothing');
    expect(res.statusCode).toBe(404);
  });

  it('answers 500 when a route throws', async () => {
    const r = router();
    r.use('/api/boom', async () => { throw new Error('bad'); });
    const res = call(r, '/api/boom');
    await new Promise((ok) => setTimeout(ok, 0));
    expect(res.statusCode).toBe(500);
    expect(res.body).toContain('bad');
  });
});
