import { describe, expect, it, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

// The store reads the live SQLite via getDb(). Swap in a fresh in-memory db
// per test so getSetting/setSetting work against test state.
const h = vi.hoisted(() => ({ db: { value: null as null | InstanceType<typeof Database> } }));
vi.mock('./db', () => ({ getDb: () => h.db.value }));

import { getGoals, normalizeGoals, prePlanSettingsKey, saveGoals } from './preplan';
import { setSetting } from './timers';

beforeEach(() => {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE settings ( key TEXT PRIMARY KEY, value TEXT NOT NULL );');
  h.db.value = db;
});

describe('normalizeGoals (legacy migration)', () => {
  it('turns a legacy string[] into goal records (owner null, isMine false)', () => {
    expect(normalizeGoals(['Ship the thing', ' '])).toEqual([
      { text: 'Ship the thing', owner: null, isMine: false },
    ]);
  });

  it('fills missing owner/isMine on partial records and trims', () => {
    expect(normalizeGoals([{ text: ' Goal ', owner: ' Sam ' }, { text: '' }])).toEqual([
      { text: 'Goal', owner: 'Sam', isMine: false },
    ]);
  });

  it('returns [] for non-arrays', () => {
    expect(normalizeGoals(null)).toEqual([]);
    expect(normalizeGoals({})).toEqual([]);
  });
});

describe('goal storage', () => {
  it('returns [] when nothing saved', () => {
    expect(getGoals('26_99')).toEqual([]);
  });

  it('round-trips and replaces the whole list', () => {
    saveGoals('26_99', [{ text: 'Goal A', owner: null, isMine: true }]);
    saveGoals('26_99', [{ text: 'Goal B', owner: null, isMine: false }]);
    expect(getGoals('26_99')).toEqual([{ text: 'Goal B', owner: null, isMine: false }]);
  });

  it('reads goals saved in the older shape with per-story calls', () => {
    setSetting(prePlanSettingsKey('26_98'), JSON.stringify({
      goals: ['Old goal'],
      stories: { '100908': { call: 'carries-over', goalIndex: 0 } },
    }));
    expect(getGoals('26_98')).toEqual([{ text: 'Old goal', owner: null, isMine: false }]);
  });

  it('keys per sprint and survives corrupt JSON', () => {
    expect(prePlanSettingsKey('26_13')).toBe('preplan_26_13');
    setSetting(prePlanSettingsKey('26_corrupt'), '{not json');
    expect(getGoals('26_corrupt')).toEqual([]);
  });
});
