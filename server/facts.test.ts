import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

// The store reads the live SQLite via getDb(). Swap in a fresh in-memory db
// per test carrying the facts table exactly as migrate() creates it.
const h = vi.hoisted(() => ({ db: { value: null as null | InstanceType<typeof Database> } }));
vi.mock('./db', () => ({ getDb: () => h.db.value }));

import {
  rememberFact,
  forgetFact,
  listFacts,
  factsForOrient,
  normalizeFactName,
  MAX_FACTS,
} from './facts';

function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE facts (
      name       TEXT PRIMARY KEY,
      body       TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  return db;
}

beforeEach(() => {
  h.db.value = makeDb();
});

describe('normalizeFactName', () => {
  it('lowercases and joins words with single dashes', () => {
    expect(normalizeFactName('  Docs Repo ')).toBe('docs-repo');
    expect(normalizeFactName('team__org / name')).toBe('team-org-name');
  });

  it('treats different spellings of the same name as one key', () => {
    expect(normalizeFactName('Docs repo')).toBe(normalizeFactName('docs-repo'));
  });

  it('refuses a name with nothing usable in it', () => {
    expect(() => normalizeFactName('  --- ')).toThrow(/needs a short name/);
  });

  it('refuses an over-long name', () => {
    expect(() => normalizeFactName('x'.repeat(80))).toThrow(/too long/);
  });
});

describe('rememberFact', () => {
  it('stores a fact and returns it', () => {
    const { fact, replaced } = rememberFact('workweek', 'The user works Sunday to Thursday.');
    expect(replaced).toBe(false);
    expect(fact.name).toBe('workweek');
    expect(fact.body).toBe('The user works Sunday to Thursday.');
    expect(listFacts()).toHaveLength(1);
  });

  it('replaces the value under the same name instead of piling up', () => {
    rememberFact('workday', 'The workday is 8 hours.');
    const { fact, replaced } = rememberFact('Workday', 'The workday is 9 hours.');
    expect(replaced).toBe(true);
    expect(fact.body).toBe('The workday is 9 hours.');
    expect(listFacts()).toHaveLength(1);
  });

  it('keeps the original created-at when replacing', () => {
    const first = rememberFact('demo-day', 'Demos are every second Thursday.').fact;
    const second = rememberFact('demo-day', 'Demos are every Thursday.').fact;
    expect(second.createdAt).toBe(first.createdAt);
  });

  it('trims the body and refuses an empty one', () => {
    expect(() => rememberFact('empty', '   ')).toThrow(/came through empty/);
  });

  it('refuses a body longer than one plain sentence deserves', () => {
    expect(() => rememberFact('long', 'x'.repeat(400))).toThrow(/too long for one fact/);
  });

  it('refuses fact number 51 but still allows replacing an existing one', () => {
    for (let i = 0; i < MAX_FACTS; i++) rememberFact(`fact-${i}`, `Fact number ${i}.`);
    expect(() => rememberFact('one-too-many', 'This should not fit.')).toThrow(/list is full/);
    // Updating an existing name is not adding — must still work at the cap.
    expect(() => rememberFact('fact-0', 'Updated value.')).not.toThrow();
    expect(listFacts()).toHaveLength(MAX_FACTS);
  });
});

describe('forgetFact', () => {
  it('deletes the fact for real', () => {
    rememberFact('old-path', 'The projects live under a folder that moved.');
    expect(forgetFact('Old Path')).toBe(true);
    expect(listFacts()).toHaveLength(0);
  });

  it('says so when there was nothing under that name', () => {
    expect(forgetFact('never-stored')).toBe(false);
  });
});

describe('listFacts / factsForOrient', () => {
  it('orders by name and slims the orient shape to name + body', () => {
    rememberFact('zebra', 'Last alphabetically.');
    rememberFact('alpha', 'First alphabetically.');
    expect(listFacts().map((f) => f.name)).toEqual(['alpha', 'zebra']);
    expect(factsForOrient()).toEqual([
      { name: 'alpha', body: 'First alphabetically.' },
      { name: 'zebra', body: 'Last alphabetically.' },
    ]);
  });
});
