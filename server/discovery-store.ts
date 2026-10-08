// server/discovery-store.ts
/**
 * Filesystem wrapper for the discovery source file. The pure shape/logic lives
 * in server/discovery.ts; this reads/writes it in a feature's workspace folder
 * and exposes the read-from-any-session status summary. Reads never throw.
 */
import { join } from 'node:path';
import { existsSync, readFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { writeFileAtomicSync, type AtomicWriter } from './atomic-write';
import {
  parseDiscoveryDoc, renderDiscoveryMarkdown, discoveryFinishedCheck,
  type DiscoveryDoc,
} from './discovery';

/** Discovery files live in a `discovery/` subfolder of the feature folder, so
 *  discovery / design / demo files stay cleanly separated. */
export const DISCOVERY_DIR = 'discovery';
const DISCOVERY_FILE = 'discovery.json';
export const DISCOVERY_MD = 'discovery.md';

/** HTML artifacts a session builds for a feature, shown in the dashboard's
 *  Discovery sub-tabs (walkthrough/demo, in `demo/`) or the design phase
 *  (design-walkthrough, in `design/`). Each kind carries its own subfolder
 *  AND file name, since they no longer all share one folder. */
export type HtmlArtifactKind = 'walkthrough' | 'demo' | 'design-walkthrough';
const HTML_ARTIFACT_FILE: Record<HtmlArtifactKind, { dir: string; file: string }> = {
  walkthrough: { dir: 'demo', file: 'walkthrough.html' },
  demo: { dir: 'demo', file: 'concept-demo.html' },
  'design-walkthrough': { dir: 'design', file: 'walkthrough.html' },
};

/** Absolute path to a feature's HTML artifact of the given kind. */
export function htmlArtifactPath(featureFolderPath: string, kind: HtmlArtifactKind): string {
  const { dir, file } = HTML_ARTIFACT_FILE[kind];
  return join(featureFolderPath, dir, file);
}

/** True when that artifact file exists on disk. */
export function hasHtmlArtifact(featureFolderPath: string, kind: HtmlArtifactKind): boolean {
  return existsSync(htmlArtifactPath(featureFolderPath, kind));
}

/** Discovery-meeting summaries live under `discovery/meetings/`, one dated
 *  markdown file per meeting (`YYYY-MM-DD.md`, extra same-day meetings get a
 *  slug suffix). Chat-written, human-readable, never overwritten — the record
 *  of what each discovery meeting said. */
export const MEETINGS_DIR = 'meetings';

export interface DiscoveryMeeting {
  file: string;
  /** The filename's YYYY-MM-DD prefix; '' when the name has none. */
  date: string;
  /** First `# ` heading's text; the filename (no extension) when absent. */
  title: string;
  /** Raw markdown after the title line; `#`-headings normalized to the house
   *  `**bold**` header lines so the dashboard's existing block renderer shows
   *  them as collapsible sections. */
  body: string;
}

/** Core of `listMeetings`, taking an already-resolved absolute meetings
 *  folder — shared by discovery's and design's meeting listings. Newest
 *  first (filename descending — the date prefix makes that chronological).
 *  Missing folder → []. Never throws. */
export function listMeetingsFromDir(dir: string): DiscoveryMeeting[] {
  let files: string[];
  try {
    files = readdirSync(dir, { withFileTypes: true })
      .filter(e => e.isFile() && e.name.endsWith('.md'))
      .map(e => e.name)
      .sort()
      .reverse();
  } catch {
    return []; // missing folder — an empty list, never an error
  }
  const meetings: DiscoveryMeeting[] = [];
  for (const file of files) {
    try {
      const raw = readFileSync(join(dir, file), 'utf8');
      const lines = raw.split('\n');
      // Only the first NON-BLANK line is a title candidate — a hand-written
      // file that opens with a paragraph and has a heading further down
      // (e.g. "# Decisions") keeps that paragraph instead of losing it.
      const firstIdx = lines.findIndex(l => l.trim() !== '');
      const firstLine = firstIdx >= 0 ? lines[firstIdx].trim() : '';
      const hasTitle = /^#\s+\S/.test(firstLine);
      const title = hasTitle ? firstLine.replace(/^#\s+/, '') : file.replace(/\.md$/, '');
      const bodyLines = hasTitle ? lines.slice(firstIdx + 1) : lines;
      const body = bodyLines
        .map(l => {
          const h = l.trim().match(/^#{1,3}\s+(.+)$/);
          return h ? `**${h[1]}**` : l;
        })
        .join('\n')
        .trim();
      const date = /^(\d{4}-\d{2}-\d{2})/.exec(file)?.[1] ?? '';
      meetings.push({ file, date, title, body });
    } catch {
      // unreadable file — skip it, the rest still list
    }
  }
  return meetings;
}

/** List a feature's discovery meeting summaries — see `listMeetingsFromDir`. */
export function listMeetings(featureFolderPath: string): DiscoveryMeeting[] {
  return listMeetingsFromDir(join(featureFolderPath, DISCOVERY_DIR, MEETINGS_DIR));
}

/** The discovery file's path, preferring the `discovery/` subfolder but falling
 *  back to the feature-folder root for anything written before the split. */
function discoveryJsonPath(featureFolderPath: string): string {
  const inDir = join(featureFolderPath, DISCOVERY_DIR, DISCOVERY_FILE);
  if (existsSync(inDir)) return inDir;
  const atRoot = join(featureFolderPath, DISCOVERY_FILE);
  if (existsSync(atRoot)) return atRoot; // legacy location
  return inDir; // default target when nothing exists yet
}

/**
 * When the discovery actually started — the moment `discovery.json` first
 * appeared on disk. Null when there's no file, or when the filesystem can't tell
 * us (some filesystems don't record a creation time).
 *
 * The day count used to run from `active_feature.setAt`, which is when the
 * FEATURE FOLDER was opened. That measured how long a feature had been open, not
 * how long its discovery had been running — so the "past its 3 days" warning was
 * wrong on every feature, including a real one. Reading the file's own birth time
 * fixes it with no change to the file's shape and nothing to migrate.
 *
 * Deliberately NOT falling back to mtime: on a discovery being edited today,
 * mtime is today, which would reset the clock every time the user touched it. Null
 * lets the caller fall back to the old behaviour instead of reporting a lie.
 */
export function discoveryStartedAt(featureFolderPath: string): string | null {
  const p = discoveryJsonPath(featureFolderPath);
  if (!existsSync(p)) return null;
  try {
    const { birthtimeMs } = statSync(p);
    if (!Number.isFinite(birthtimeMs) || birthtimeMs <= 0) return null;
    return new Date(birthtimeMs).toISOString();
  } catch {
    return null;
  }
}

export function readDiscoveryDoc(featureFolderPath: string): DiscoveryDoc | null {
  const p = discoveryJsonPath(featureFolderPath);
  if (!existsSync(p)) return null;
  try {
    return parseDiscoveryDoc(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

/** Write the source JSON and regenerate the markdown render beside it, so the
 *  two never drift — the md is always rebuilt from the json on every write.
 *  Both land in the feature's `discovery/` subfolder (created if absent).
 *
 *  Both files are written through a temp file and a rename, so a crash or a
 *  full disk can never leave the user's discovery half-written. `writer` is
 *  only for tests that need a write to fail on purpose. */
export function writeDiscoveryDoc(
  featureFolderPath: string,
  doc: DiscoveryDoc,
  featureDisplayName: string,
  writer?: AtomicWriter,
): void {
  const dir = join(featureFolderPath, DISCOVERY_DIR);
  mkdirSync(dir, { recursive: true });
  writeFileAtomicSync(join(dir, DISCOVERY_FILE), JSON.stringify(doc, null, 2) + '\n', writer);
  writeFileAtomicSync(
    join(dir, DISCOVERY_MD),
    renderDiscoveryMarkdown(doc, { featureDisplayName }),
    writer,
  );
}

export interface DiscoveryStatus {
  hasDiscovery: boolean;
  finished: boolean;
  missing: string[];
  /** Bare labels of non-empty parts USER hasn't agreed to yet — a sibling of
   *  `missing`, never folded into it (content gaps vs agreement gaps). */
  unagreed: string[];
  demoStatus: string;
  hasWalkthrough: boolean;
  hasDemoHtml: boolean;
}

export function discoveryStatus(featureFolderPath: string): DiscoveryStatus {
  const doc = readDiscoveryDoc(featureFolderPath);
  const check = discoveryFinishedCheck(doc);
  return {
    hasDiscovery: doc !== null,
    finished: check.ok,
    missing: check.missing,
    unagreed: check.unagreed,
    demoStatus: doc?.demo.status ?? 'none',
    hasWalkthrough: hasHtmlArtifact(featureFolderPath, 'walkthrough'),
    hasDemoHtml: hasHtmlArtifact(featureFolderPath, 'demo'),
  };
}
