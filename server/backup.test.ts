import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database, { type Database as DB } from 'better-sqlite3';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { backupDatabase, checkpointWal } from './backup';

// Every test gets its own throwaway folder — the real store at
// ~/.sprintomatic/data.db is never opened here.
let tmp: string;
let db: DB;

function openDb(): DB {
  const d = new Database(join(tmp, 'data.db'));
  d.pragma('journal_mode = WAL');
  d.exec('CREATE TABLE IF NOT EXISTS notes (work_item_id INTEGER, body TEXT)');
  return d;
}

function backupDir() {
  return join(tmp, 'backups');
}

function daysAgo(n: number) {
  return new Date(Date.parse('2026-08-24T10:00:00.000Z') - n * 24 * 60 * 60 * 1000);
}

const NOW = daysAgo(0);

/** Drop a fake old backup file into the folder, named the way we name ours. */
function seedBackup(date: string) {
  mkdirSync(backupDir(), { recursive: true });
  writeFileSync(join(backupDir(), `data-${date}.db`), 'old backup');
}

function isoDay(d: Date) {
  return d.toISOString().slice(0, 10);
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'sprintomatic-backup-'));
  db = openDb();
});

afterEach(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe('backupDatabase', () => {
  it('writes a backup file named after today', () => {
    const result = backupDatabase(db, { dir: backupDir(), now: NOW });

    expect(result.status).toBe('created');
    expect(existsSync(join(backupDir(), `data-${isoDay(NOW)}.db`))).toBe(true);
  });

  it('does not write a second time on the same day', () => {
    backupDatabase(db, { dir: backupDir(), now: NOW });
    const second = backupDatabase(db, { dir: backupDir(), now: NOW });

    expect(second.status).toBe('exists');
    expect(readdirSync(backupDir())).toHaveLength(1);
  });

  it('deletes a backup older than 30 days and keeps a 29-day-old one', () => {
    seedBackup(isoDay(daysAgo(31)));
    seedBackup(isoDay(daysAgo(29)));

    const result = backupDatabase(db, { dir: backupDir(), now: NOW });

    expect(result.deleted).toEqual([`data-${isoDay(daysAgo(31))}.db`]);
    const left = readdirSync(backupDir()).sort();
    expect(left).toEqual([`data-${isoDay(daysAgo(29))}.db`, `data-${isoDay(NOW)}.db`]);
  });

  it('leaves files it did not name alone', () => {
    mkdirSync(backupDir(), { recursive: true });
    writeFileSync(join(backupDir(), 'notes.txt'), 'keep me');

    backupDatabase(db, { dir: backupDir(), now: NOW });

    expect(existsSync(join(backupDir(), 'notes.txt'))).toBe(true);
  });

  it('does not throw when the backup folder cannot be written', () => {
    // A file where the folder should be: creating the folder fails.
    const blocked = join(tmp, 'blocked');
    writeFileSync(blocked, 'not a folder');

    const result = backupDatabase(db, { dir: join(blocked, 'backups'), now: NOW });

    expect(result.status).toBe('failed');
    expect(result.error).toBeTruthy();
  });

  it('includes rows that are still only in the write-ahead log', () => {
    // This is the whole point: the main data.db file can be days out of date
    // while every recent row sits in the -wal sidecar. No checkpoint here.
    db.prepare('INSERT INTO notes (work_item_id, body) VALUES (?, ?)').run(
      100001,
      'only in the write-ahead log',
    );

    const result = backupDatabase(db, { dir: backupDir(), now: NOW });
    expect(result.status).toBe('created');

    const copy = new Database(result.file!, { readonly: true });
    try {
      const rows = copy.prepare('SELECT work_item_id, body FROM notes').all();
      expect(rows).toEqual([{ work_item_id: 100001, body: 'only in the write-ahead log' }]);
    } finally {
      copy.close();
    }
  });
});

describe('checkpointWal', () => {
  it('folds the write-ahead log back into the main file', () => {
    db.prepare('INSERT INTO notes (work_item_id, body) VALUES (?, ?)').run(100002, 'row');

    const result = checkpointWal(db);

    expect(result.ok).toBe(true);
    expect(result.busy).toBe(0);
  });

  it('does not throw when the checkpoint cannot run', () => {
    db.close(); // a closed connection stands in for any checkpoint that fails

    const result = checkpointWal(db);

    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });
});
