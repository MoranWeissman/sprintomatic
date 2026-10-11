import { describe, it, expect, afterEach } from 'vitest';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { dataDir, isDemo } from './data-dir';

const before = process.env.SPRINTOMATIC_DEMO;
afterEach(() => {
  if (before == null) delete process.env.SPRINTOMATIC_DEMO;
  else process.env.SPRINTOMATIC_DEMO = before;
});

describe('data folder', () => {
  it('is the real folder unless demo mode is on', () => {
    delete process.env.SPRINTOMATIC_DEMO;
    expect(isDemo()).toBe(false);
    expect(dataDir()).toBe(join(homedir(), '.sprintomatic'));
    for (const off of ['', '0', 'false']) {
      process.env.SPRINTOMATIC_DEMO = off;
      expect(dataDir()).toBe(join(homedir(), '.sprintomatic'));
    }
  });

  it('is a separate folder in demo mode', () => {
    process.env.SPRINTOMATIC_DEMO = '1';
    expect(isDemo()).toBe(true);
    expect(dataDir()).toBe(join(homedir(), '.sprintomatic-demo'));
  });
});
