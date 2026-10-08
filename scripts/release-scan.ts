/**
 * Checks every file in the repo for private words. Exits 1 if anything is
 * found, so the git hooks can stop a commit or a push.
 *
 *   npm run release-scan          # counts per word, per file
 *   npm run release-scan -- --all # every matching line
 *
 * Two private sources, both outside the repo:
 *   - the word list: ~/.sprintomatic/release-words.txt (or SH_RELEASE_WORDS)
 *   - every ticket id the local database has ever seen
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { BUILT_IN_RULES, parseWordList, rulesFromWords, scanFiles } from '../server/release-scan';

const home = join(homedir(), '.sprintomatic');
const wordsPath = process.env.SH_RELEASE_WORDS ?? join(home, 'release-words.txt');

if (!existsSync(wordsPath)) {
  console.error(`No word list at ${wordsPath}.\nCreate it: one private word per line (employer, org, tenant, email, names).`);
  process.exit(2);
}
const words = parseWordList(readFileSync(wordsPath, 'utf8'));

function ticketIds(): string[] {
  const dbPath = join(home, 'data.db');
  if (!existsSync(dbPath)) return [];
  const db = new Database(dbPath, { readonly: true });
  const rows = db
    .prepare(
      `SELECT work_item_id AS id FROM time_entries
       UNION SELECT work_item_id FROM sessions
       UNION SELECT work_item_id FROM sh_created_items
       UNION SELECT work_item_id FROM helper_notes`,
    )
    .all() as { id: number | null }[];
  db.close();
  return rows.filter((r) => r.id != null).map((r) => String(r.id));
}
const ids = ticketIds();

const paths = execFileSync('git', ['ls-files'], { encoding: 'utf8' }).split('\n').filter(Boolean);
const files = paths
  .map((path) => ({ path, buf: readFileSync(path) }))
  .filter((f) => !f.buf.includes(0)) // skip images and other binary files
  .map((f) => ({ path: f.path, text: f.buf.toString('utf8') }));

const idRules = rulesFromWords(ids).map((r) => ({ ...r, label: 'real ticket id' }));
const hits = scanFiles(files, [...rulesFromWords(words), ...idRules, ...BUILT_IN_RULES]);

if (hits.length === 0) {
  console.log(`Clean: ${files.length} files, ${words.length} words, ${ids.length} ticket ids checked.`);
  process.exit(0);
}

if (process.argv.includes('--all')) {
  for (const h of hits) console.log(`${h.path}:${h.line}  [${h.label}]  ${h.text.slice(0, 140)}`);
} else {
  const byLabel = new Map<string, Map<string, number>>();
  for (const h of hits) {
    const perFile = byLabel.get(h.label) ?? new Map<string, number>();
    perFile.set(h.path, (perFile.get(h.path) ?? 0) + 1);
    byLabel.set(h.label, perFile);
  }
  for (const [label, perFile] of byLabel) {
    const total = [...perFile.values()].reduce((a, b) => a + b, 0);
    console.log(`\n${label}: ${total} lines in ${perFile.size} files`);
    for (const [path, n] of [...perFile].sort((a, b) => b[1] - a[1])) console.log(`  ${n.toString().padStart(4)}  ${path}`);
  }
}
const fileCount = new Set(hits.map((h) => h.path)).size;
console.log(`\nNOT CLEAN: ${hits.length} lines in ${fileCount} files.`);
process.exit(1);
