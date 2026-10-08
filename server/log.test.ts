import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { logError } from './log';

// Every test gets its own throwaway folder — the real log folder at
// ~/.sprintomatic/logs is never touched here.
let tmp: string;

function logDir() {
  return join(tmp, 'logs');
}

function read(name = 'error.log') {
  return readFileSync(join(logDir(), name), 'utf8');
}

const NOW = new Date('2026-08-24T10:00:00.000Z');

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'sh-log-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('logError', () => {
  it('writes one line holding the label and the message', () => {
    logError('ado-client.runAz', new Error('the board said no'), undefined, {
      dir: logDir(),
      now: NOW,
    });

    const text = read();
    expect(text.split('\n').filter(Boolean)).toHaveLength(1);
    expect(text).toContain('2026-08-24T10:00:00.000Z');
    expect(text).toContain('ado-client.runAz');
    expect(text).toContain('the board said no');
    expect(text.endsWith('\n')).toBe(true);
  });

  it('adds a line per error instead of replacing the file', () => {
    logError('one', new Error('first'), undefined, { dir: logDir(), now: NOW });
    logError('two', new Error('second'), undefined, { dir: logDir(), now: NOW });

    const lines = read().split('\n').filter(Boolean);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('first');
    expect(lines[1]).toContain('second');
  });

  it('includes the stack, flattened onto the one line', () => {
    logError('db.getDb', new Error('boom'), undefined, { dir: logDir(), now: NOW });

    const text = read();
    expect(text).toContain('log.test.ts');
    expect(text.split('\n').filter(Boolean)).toHaveLength(1);
  });

  it('writes the extra fields it is handed', () => {
    logError('db.getDb', new Error('boom'), { workItemId: 100001, mode: 'cli' }, {
      dir: logDir(),
      now: NOW,
    });

    const text = read();
    expect(text).toContain('workItemId=100001');
    expect(text).toContain('mode=cli');
  });

  it('never writes a token, an Authorization header or a Bearer value', () => {
    // Made-up dummies, shaped like the real things but obviously not real.
    const fakePat = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const fakeBearer = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
    const err = new Error(
      `request failed with Authorization: Basic ${fakePat} and pat=${fakePat}`,
    );
    err.stack = `Error: rejected\n    at send (headers: Authorization: Bearer ${fakeBearer})`;

    logError('ado-client.rest', err, {
      Authorization: `Bearer ${fakeBearer}`,
      ado_pat: fakePat,
      uri: 'https://example.invalid/_apis/wit/workitems/100001',
    }, { dir: logDir(), now: NOW });

    const text = read();
    expect(text).not.toContain(fakePat);
    expect(text).not.toContain(fakeBearer);
    expect(text).toContain('[redacted]');
    // The harmless parts still survive, otherwise the line is useless.
    expect(text).toContain('ado-client.rest');
    expect(text).toContain('_apis/wit/workitems/100001');
  });

  it('rotates once the file passes the cap and keeps exactly one old file', () => {
    const cap = 6000;
    const opts = { dir: logDir(), now: NOW, maxBytes: cap };
    for (let i = 0; i < 40; i++) {
      logError(`round-${i}`, new Error(`error number ${i}`), undefined, opts);
    }

    expect(existsSync(join(logDir(), 'error.log'))).toBe(true);
    expect(existsSync(join(logDir(), 'error.log.1'))).toBe(true);
    expect(existsSync(join(logDir(), 'error.log.2'))).toBe(false);
    expect(statSync(join(logDir(), 'error.log')).size).toBeLessThanOrEqual(cap);
    // The newest error is in the live file, not the rolled-away one.
    expect(read()).toContain('error number 39');
  });

  it('still writes an error that is bigger than the cap all by itself', () => {
    const opts = { dir: logDir(), now: NOW, maxBytes: 50 };
    logError('first', new Error('the first one'), undefined, opts);
    logError('second', new Error('the second one'), undefined, opts);

    // Each one rolls the last away, so the newest error is never lost.
    expect(read()).toContain('the second one');
    expect(read()).not.toContain('the first one');
    expect(existsSync(join(logDir(), 'error.log.2'))).toBe(false);
  });

  it('does not throw when the log folder cannot be written', () => {
    // A plain file where the folder should be — creating the folder must fail.
    writeFileSync(logDir(), 'not a folder');

    expect(() => logError('db.getDb', new Error('boom'), undefined, { dir: logDir(), now: NOW })).not.toThrow();
  });

  it('does not throw when handed something that is not an Error', () => {
    const opts = { dir: logDir(), now: NOW };
    expect(() => logError('a', 'just a string', undefined, opts)).not.toThrow();
    expect(() => logError('b', null, undefined, opts)).not.toThrow();
    expect(() => logError('c', undefined, undefined, opts)).not.toThrow();
    expect(() => logError('d', { code: 'ENOENT' }, undefined, opts)).not.toThrow();
    expect(() => logError('e', 42, undefined, opts)).not.toThrow();

    const lines = read().split('\n').filter(Boolean);
    expect(lines).toHaveLength(5);
    expect(lines[0]).toContain('just a string');
    expect(lines[3]).toContain('ENOENT');
  });

  it('does not throw when an extra field cannot be turned into text', () => {
    const looping: Record<string, unknown> = { name: 'loops back on itself' };
    looping.self = looping;

    expect(() =>
      logError('db.getDb', new Error('boom'), looping, { dir: logDir(), now: NOW }),
    ).not.toThrow();
    expect(read()).toContain('boom');
  });

  it('keeps one huge error from filling the file', () => {
    logError('ado-client.rest', new Error('x'.repeat(50_000)), undefined, {
      dir: logDir(),
      now: NOW,
    });

    expect(statSync(join(logDir(), 'error.log')).size).toBeLessThan(10_000);
  });
});
