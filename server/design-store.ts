// server/design-store.ts
/**
 * Filesystem wrapper for the design source file. The pure shape/logic lives
 * in server/design.ts; this reads/writes it in a feature's workspace folder.
 * Same discipline as server/discovery-store.ts: try/catch everywhere, a
 * missing `design/` folder is a normal state, reads never throw.
 */
import { join } from 'node:path';
import { existsSync, readFileSync, mkdirSync, readdirSync } from 'node:fs';
import { writeFileAtomicSync, type AtomicWriter } from './atomic-write';
import {
  parseDesignDoc, renderDesignMarkdown, designProblems, droppedByParse, type DesignDoc,
} from './design';
import { listMeetingsFromDir, MEETINGS_DIR, type DiscoveryMeeting } from './discovery-store';

/** Design files live in a `design/` subfolder of the feature folder, mirroring
 *  discovery's `discovery/` split — discovery / design / demo stay separate. */
const DESIGN_DIR = 'design';
const DESIGN_FILE = 'design.json';
const DESIGN_MD = 'design.md';
const DIAGRAMS_DIR = 'diagrams';

/** Only names like `deploy-flow.svg` are ever read back off disk — this
 *  guards against `../..` traversal once diagrams are served over HTTP, and
 *  keeps names with spaces or other odd characters out of the list too. */
const SAFE_SVG_NAME = /^[\w][\w.-]*\.svg$/;

export function readDesignDoc(featureFolderPath: string): DesignDoc | null {
  const p = join(featureFolderPath, DESIGN_DIR, DESIGN_FILE);
  if (!existsSync(p)) return null;
  try {
    return parseDesignDoc(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

/** Write the source JSON and regenerate the markdown render beside it, so the
 *  two never drift — the md is always rebuilt from the json on every write.
 *  Both land in the feature's `design/` subfolder (created if absent).
 *
 *  Both files are written through a temp file and a rename, so a crash or a
 *  full disk can never leave the user's design half-written. `writer` is only
 *  for tests that need a write to fail on purpose. */
export function writeDesignDoc(
  featureFolderPath: string,
  doc: DesignDoc,
  opts: { featureDisplayName: string },
  writer?: AtomicWriter,
): void {
  const dir = join(featureFolderPath, DESIGN_DIR);
  mkdirSync(dir, { recursive: true });
  writeFileAtomicSync(join(dir, DESIGN_FILE), JSON.stringify(doc, null, 2) + '\n', writer);
  writeFileAtomicSync(join(dir, DESIGN_MD), renderDesignMarkdown(doc, opts), writer);
}

export interface DesignSyncResult {
  /** design.json read and parsed, and design.md written from it. */
  ok: boolean;
  /** How many parts the design has, for a one-line "still all here" report. */
  counts: { flows: number; stories: number; plan: number; decisions: number };
  /** Plain-English things to fix. Can be non-empty even when ok is true. */
  problems: string[];
}

/**
 * Rewrite `design.md` from `design.json`, and say what's wrong with the design.
 *
 * design.md is a RENDER, not a second copy. Before this existed the only thing
 * that rebuilt it was the push at the very end, so during the design itself
 * every change was hand-edited into both files and nothing checked that they
 * still agreed.
 *
 * Nothing is written when the JSON won't parse — a broken source must not
 * quietly overwrite a good render.
 */
export function syncDesignMarkdown(
  featureFolderPath: string,
  opts: { featureDisplayName: string },
  writer?: AtomicWriter,
): DesignSyncResult {
  const zero = { flows: 0, stories: 0, plan: 0, decisions: 0 };
  const dir = join(featureFolderPath, DESIGN_DIR);
  const jsonPath = join(dir, DESIGN_FILE);
  if (!existsSync(jsonPath)) {
    return { ok: false, counts: zero, problems: [`This feature has no ${DESIGN_DIR}/${DESIGN_FILE} yet.`] };
  }

  let raw: string;
  try {
    raw = readFileSync(jsonPath, 'utf8');
  } catch (e) {
    return { ok: false, counts: zero, problems: [`Could not read ${DESIGN_FILE}: ${msgOf(e)}`] };
  }

  const doc = parseDesignDoc(raw);
  if (!doc) {
    return {
      ok: false,
      counts: zero,
      problems: [`${DESIGN_FILE} is not valid JSON any more — the last edit broke it. Nothing was written. Fix the file and run this again.`],
    };
  }

  const counts = {
    flows: doc.flows.length,
    stories: doc.stories.length,
    plan: doc.plan.length,
    decisions: doc.decisions.length,
  };
  const problems = [...droppedByParse(raw, doc), ...designProblems(doc, listDiagrams(featureFolderPath))];

  try {
    writeFileAtomicSync(join(dir, DESIGN_MD), renderDesignMarkdown(doc, opts), writer);
  } catch (e) {
    return { ok: false, counts, problems: [...problems, `Could not write ${DESIGN_MD}: ${msgOf(e)}`] };
  }
  return { ok: true, counts, problems };
}

const msgOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** List a feature's design-meeting summaries — same shape and rules as
 *  discovery's `listMeetings`, just reading `design/meetings/` instead. */
export function listDesignMeetings(featureFolderPath: string): DiscoveryMeeting[] {
  return listMeetingsFromDir(join(featureFolderPath, DESIGN_DIR, MEETINGS_DIR));
}

/** Names of `design/diagrams/*.svg`, sorted. Missing folder → []. Never throws. */
export function listDiagrams(featureFolderPath: string): string[] {
  const dir = join(featureFolderPath, DESIGN_DIR, DIAGRAMS_DIR);
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter(e => e.isFile() && SAFE_SVG_NAME.test(e.name))
      .map(e => e.name)
      .sort();
  } catch {
    return [];
  }
}

/** Absolute path to a diagram file, or null when `name` isn't a bare,
 *  safe `.svg` filename (path-safety — this gets served over HTTP later). */
export function diagramPath(featureFolderPath: string, name: string): string | null {
  if (!SAFE_SVG_NAME.test(name)) return null;
  return join(featureFolderPath, DESIGN_DIR, DIAGRAMS_DIR, name);
}
