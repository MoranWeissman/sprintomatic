/**
 * Long-lived facts about the user — the tool's own memory.
 *
 * A fact is something the user said that will still be true next month: a
 * path, a preference, a rule of their process ("the team's repos live under
 * <folder>", "demos are every second Thursday"). Facts ride into every
 * orient packet, so a brand-new chat starts already knowing them.
 *
 * What a fact is NOT: status, estimates, hours, or anything that happened
 * today. The board owns planning and status; the session log owns what
 * happened. Storing those here would create a second copy that drifts —
 * exactly what this tool is built to avoid.
 *
 * Facts are keyed by name. Saving a newer value under the same name replaces
 * the old one, so the list never piles up duplicates. Forgetting deletes the
 * row for real — a fact is current knowledge, not history.
 */
import { getDb } from './db';

export interface Fact {
  name: string;
  body: string;
  createdAt: string;
  updatedAt: string;
}

/** Hard ceiling. Fifty one-line facts is already a lot to know about one
 *  person; past that the list has stopped being curated and started being a
 *  junk drawer. The error tells the model to clean up, not to squeeze in. */
export const MAX_FACTS = 50;
const MAX_NAME_LENGTH = 64;
const MAX_BODY_LENGTH = 300;

interface FactRow {
  name: string;
  body: string;
  created_at: string;
  updated_at: string;
}

function toFact(row: FactRow): Fact {
  return {
    name: row.name,
    body: row.body,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Normalise a fact name into a stable key: lowercase, words joined by single
 * dashes ("Docs repo" and "docs-repo" are the same fact). Throws in plain
 * English when nothing usable is left.
 */
export function normalizeFactName(raw: string): string {
  const name = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!name) throw new Error('The fact needs a short name, like "docs-repo" or "workweek".');
  if (name.length > MAX_NAME_LENGTH) {
    throw new Error(`That name is too long (over ${MAX_NAME_LENGTH} characters). Pick a shorter one.`);
  }
  return name;
}

/**
 * Save a fact. Same name replaces the old value (and keeps the original
 * created-at, so "how long have I known this" stays honest). Returns the
 * saved fact plus whether it replaced an earlier value.
 */
export function rememberFact(rawName: string, rawBody: string): { fact: Fact; replaced: boolean } {
  const db = getDb();
  const name = normalizeFactName(rawName);
  const body = rawBody.trim();
  if (!body) throw new Error('The fact came through empty. Say it again in one plain sentence.');
  if (body.length > MAX_BODY_LENGTH) {
    throw new Error(
      `That is too long for one fact (over ${MAX_BODY_LENGTH} characters). ` +
        'A fact is one plain sentence. If it is really several facts, save them one by one.',
    );
  }

  const existing = db.prepare('SELECT 1 FROM facts WHERE name = ?').get(name);
  if (!existing) {
    const count = (db.prepare('SELECT COUNT(*) AS n FROM facts').get() as { n: number }).n;
    if (count >= MAX_FACTS) {
      throw new Error(
        `The facts list is full (${MAX_FACTS}). Ask the user which facts are no longer true and forget those first.`,
      );
    }
  }

  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO facts (name, body, created_at, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at`,
  ).run(name, body, now, now);

  const row = db.prepare('SELECT * FROM facts WHERE name = ?').get(name) as FactRow;
  return { fact: toFact(row), replaced: Boolean(existing) };
}

/** Delete a fact for real. Returns false when there was nothing under that name. */
export function forgetFact(rawName: string): boolean {
  const db = getDb();
  const name = normalizeFactName(rawName);
  const info = db.prepare('DELETE FROM facts WHERE name = ?').run(name);
  return info.changes > 0;
}

/** Every stored fact, ordered by name so the list reads stably. */
export function listFacts(): Fact[] {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM facts ORDER BY name').all() as FactRow[];
  return rows.map(toFact);
}

/**
 * The slim shape orient carries: name + body only. Background knowledge for
 * the model — the greeting must not recite it.
 */
export function factsForOrient(): { name: string; body: string }[] {
  return listFacts().map(({ name, body }) => ({ name, body }));
}
