/**
 * Daily copy of the local SQLite store.
 *
 * Why this exists: the store runs in write-ahead-log mode, and several
 * long-lived processes keep the connection open, so SQLite may not fold the
 * -wal sidecar back into data.db for days. Copying data.db on its own can
 * therefore restore a version that is days behind. `VACUUM INTO` writes one
 * consistent file that already contains everything sitting in the sidecar, so
 * the copy is complete on its own.
 *
 * A backup is never allowed to break the caller: if the disk is full or the
 * folder can't be written, we report it in the result and the app carries on.
 */
import { type Database as DB } from 'better-sqlite3';
import { existsSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Backups older than this many days are removed. */
const KEEP_DAYS = 30;

const FILE_PATTERN = /^data-(\d{4}-\d{2}-\d{2})\.db$/;

export type BackupOptions = {
  /** Where to write copies. Default: ~/.sprintomatic/backups. */
  dir?: string;
  /** Clock, injected by tests. */
  now?: Date;
  /** How many days of copies to keep. Default: 30. */
  keepDays?: number;
};

export type BackupResult = {
  /** created = a new copy was written; exists = today's copy was already there. */
  status: 'created' | 'exists' | 'failed';
  /** Full path of today's copy, when there is one. */
  file?: string;
  /** File names removed for being too old. */
  deleted: string[];
  /** Why it failed, when it did. */
  error?: string;
};

function defaultBackupDir() {
  return join(homedir(), '.sprintomatic', 'backups');
}

/**
 * Write today's copy of the store, then drop copies older than `keepDays`.
 * Safe to call on every start: the second call on the same day does nothing.
 */
export function backupDatabase(db: DB, opts: BackupOptions = {}): BackupResult {
  const dir = opts.dir ?? defaultBackupDir();
  const now = opts.now ?? new Date();
  const keepDays = opts.keepDays ?? KEEP_DAYS;
  const deleted: string[] = [];

  try {
    mkdirSync(dir, { recursive: true });
    const name = `data-${isoDay(now)}.db`;
    const file = join(dir, name);
    const already = existsSync(file);
    if (!already) {
      // VACUUM INTO refuses to overwrite, which is exactly the guard we want.
      db.prepare('VACUUM INTO ?').run(file);
    }
    deleted.push(...removeOldBackups(dir, now, keepDays));
    return { status: already ? 'exists' : 'created', file, deleted };
  } catch (e) {
    return { status: 'failed', deleted, error: e instanceof Error ? e.message : String(e) };
  }
}

export type CheckpointResult = {
  ok: boolean;
  /** 1 when another process held the lock — normal, not a failure. */
  busy?: number;
  /** Pages moved into the main file. */
  checkpointed?: number;
  error?: string;
};

/**
 * Fold the write-ahead log back into the main file and shrink it.
 * A busy checkpoint (someone else is reading) is a normal outcome, not an error.
 */
export function checkpointWal(db: DB): CheckpointResult {
  try {
    const rows = db.pragma('wal_checkpoint(TRUNCATE)') as Array<{
      busy: number;
      log: number;
      checkpointed: number;
    }>;
    const row = rows[0];
    return { ok: true, busy: row?.busy ?? 0, checkpointed: row?.checkpointed ?? 0 };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Remove copies whose day is more than `keepDays` back. Other files are left alone. */
function removeOldBackups(dir: string, now: Date, keepDays: number): string[] {
  const cutoff = Date.parse(isoDay(now)) - keepDays * 24 * 60 * 60 * 1000;
  const gone: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const match = FILE_PATTERN.exec(name);
    if (!match) continue;
    const day = Date.parse(match[1]);
    if (Number.isNaN(day) || day >= cutoff) continue;
    try {
      unlinkSync(join(dir, name));
      gone.push(name);
    } catch {
      // A copy we can't delete isn't worth failing the backup over.
    }
  }
  return gone;
}

function isoDay(d: Date) {
  return d.toISOString().slice(0, 10);
}
