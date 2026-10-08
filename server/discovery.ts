/**
 * Per-feature discovery: the source-of-content file shape, its markdown render,
 * the "finished" check, and the day-count. Pure functions over data passed in;
 * every reader tolerates missing/garbage input and returns a safe empty state,
 * never throws — same discipline as server/workspace.ts. No fs or ADO access in
 * the pure core; the fs wrapper lives in Task 2.
 */
import { countWorkingDays } from './capacity';
import { getWorkingDays } from './user-config';

export type DiscoveryTag = 'diff' | 'risk' | 'fact' | 'option' | 'dep' | 'mitigation';
const VALID_TAGS: ReadonlySet<string> = new Set(['diff', 'risk', 'fact', 'option', 'dep', 'mitigation']);

export interface DiscoveryItem { text: string; tags: DiscoveryTag[] }
export interface DiscoveryGroup { name: string; items: DiscoveryItem[] }
export type DemoStatus = 'none' | 'scheduled' | 'built';
const VALID_DEMO: ReadonlySet<string> = new Set(['none', 'scheduled', 'built']);

export interface DiscoveryDoc {
  problem: string;
  flow: string[];
  groups: DiscoveryGroup[];
  lanes: { ours: string; techLead: string };
  /** `notes` = the demo candidate: which flow to demo and why. Free text until
   *  the demo generator gives it a richer home. */
  demo: { status: DemoStatus; shape: string; date: string; notes: string };
  openQuestions: string[];
  /** "What we don't accept as-is" — pushback one-liners for the product talk.
   *  Empty = the feature is accepted as written. Never blocks closing by content. */
  pushback: string[];
  /** Parts USER agreed after a plain-English walk-through. Keys: 'problem',
   *  'flow', 'lanes', 'pushback', 'openQuestions', and `group:<group name>`.
   *  The close gate requires every non-empty part to be listed here. */
  agreed: string[];
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const strArray = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

function parseItem(v: unknown): DiscoveryItem | null {
  if (v == null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.text !== 'string') return null;
  const tags = Array.isArray(o.tags)
    ? (o.tags.filter((t): t is DiscoveryTag => typeof t === 'string' && VALID_TAGS.has(t)))
    : [];
  return { text: o.text, tags };
}

function parseGroup(v: unknown): DiscoveryGroup | null {
  if (v == null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.name !== 'string') return null;
  const items = Array.isArray(o.items)
    ? o.items.map(parseItem).filter((i): i is DiscoveryItem => i !== null)
    : [];
  return { name: o.name, items };
}

export function emptyDiscoveryDoc(): DiscoveryDoc {
  return {
    problem: '', flow: [], groups: [],
    lanes: { ours: '', techLead: '' },
    demo: { status: 'none', shape: '', date: '', notes: '' },
    openQuestions: [],
    pushback: [], agreed: [],
  };
}

/** Parse the source file; missing/garbage/wrong-shape → null. Never throws. */
export function parseDiscoveryDoc(raw: string | null | undefined): DiscoveryDoc | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const o = parsed as Record<string, unknown>;
  const lanes = (o.lanes && typeof o.lanes === 'object' && !Array.isArray(o.lanes))
    ? o.lanes as Record<string, unknown> : {};
  const demo = (o.demo && typeof o.demo === 'object' && !Array.isArray(o.demo))
    ? o.demo as Record<string, unknown> : {};
  const status = typeof demo.status === 'string' && VALID_DEMO.has(demo.status)
    ? demo.status as DemoStatus : 'none';
  return {
    problem: str(o.problem),
    flow: strArray(o.flow),
    groups: Array.isArray(o.groups)
      ? o.groups.map(parseGroup).filter((g): g is DiscoveryGroup => g !== null) : [],
    lanes: { ours: str(lanes.ours), techLead: str(lanes.techLead) },
    demo: { status, shape: str(demo.shape), date: str(demo.date), notes: str(demo.notes) },
    openQuestions: strArray(o.openQuestions),
    pushback: strArray(o.pushback), agreed: strArray(o.agreed),
  };
}

export function isGroupComplete(g: DiscoveryGroup): boolean {
  const has = (t: DiscoveryTag) => g.items.some(i => i.tags.includes(t));
  return has('diff') && has('risk') && (has('fact') || has('option'));
}

/** The story-close gate reads this. ok = a real flow + at least one complete
 *  group + every non-empty part agreed. `missing` is content gaps (plain
 *  English so the close error can quote it); `unagreed` is the bare labels of
 *  non-empty parts USER hasn't agreed to yet — kept separate so the close
 *  message can talk about them differently ("fill it in" vs "walk it through
 *  with USER and get a yes"). */
export function discoveryFinishedCheck(
  doc: DiscoveryDoc | null,
): { ok: boolean; missing: string[]; unagreed: string[] } {
  const missing: string[] = [];
  if (!doc) return { ok: false, missing: ['a discovery doc (none found)'], unagreed: [] };
  if (doc.flow.length === 0) missing.push('an end-to-end flow');
  if (!doc.groups.some(isGroupComplete)) {
    missing.push('at least one context group with a difference, a risk, and a fact or option');
  }
  // Agree-per-part: every part with content must be walked through with USER
  // and marked agreed before the story can close. Empty parts need no mark.
  const parts: { key: string; present: boolean; label: string }[] = [
    { key: 'problem', present: doc.problem.trim() !== '', label: 'the problem' },
    { key: 'flow', present: doc.flow.length > 0, label: 'the end-to-end flow' },
    ...doc.groups.map(g => ({
      key: `group:${g.name}`, present: g.items.length > 0, label: `the group "${g.name}"`,
    })),
    {
      key: 'lanes',
      present: doc.lanes.ours.trim() !== '' || doc.lanes.techLead.trim() !== '',
      label: 'the lanes',
    },
    { key: 'pushback', present: doc.pushback.length > 0, label: "the list of things we don't accept as-is" },
    { key: 'openQuestions', present: doc.openQuestions.length > 0, label: 'the open questions' },
  ];
  const unagreed: string[] = [];
  for (const p of parts) {
    if (p.present && !doc.agreed.includes(p.key)) {
      unagreed.push(p.label);
    }
  }
  return { ok: missing.length === 0 && unagreed.length === 0, missing, unagreed };
}

export function renderDiscoveryMarkdown(
  doc: DiscoveryDoc,
  opts: { featureDisplayName: string },
): string {
  const agreedMark = (key: string): string => (doc.agreed.includes(key) ? ' · agreed ✓' : '');
  const lines: string[] = [];
  lines.push(`# Discovery: ${opts.featureDisplayName}`, '');
  lines.push(`## What we're solving${agreedMark('problem')}`, '', doc.problem || '_(not filled in)_', '');
  if (doc.pushback.length > 0) {
    lines.push(`## What we don't accept as-is${agreedMark('pushback')}`, '');
    doc.pushback.forEach(p => lines.push(`- ${p}`));
    lines.push('');
  }
  lines.push(`## The feature end-to-end${agreedMark('flow')}`, '');
  if (doc.flow.length === 0) lines.push('_(no flow yet)_');
  else doc.flow.forEach((s, i) => lines.push(`${i + 1}. ${s}`));
  lines.push('');
  lines.push('## Context groups', '');
  if (doc.groups.length === 0) lines.push('_(no groups yet)_', '');
  for (const g of doc.groups) {
    lines.push(`### ${g.name}${agreedMark(`group:${g.name}`)}`, '');
    for (const it of g.items) {
      const tags = it.tags.length ? ` [${it.tags.join(', ')}]` : '';
      lines.push(`- ${it.text}${tags}`);
    }
    lines.push('');
  }
  lines.push(`## Lanes${agreedMark('lanes')}`, '');
  lines.push(`- Ours: ${doc.lanes.ours || '_(not filled in)_'}`);
  lines.push(`- Tech Lead's (parked): ${doc.lanes.techLead || '_(not filled in)_'}`, '');
  lines.push('## Demo', '');
  lines.push(`status: ${doc.demo.status}  ·  shape: ${doc.demo.shape || '—'}  ·  date: ${doc.demo.date || '—'}`, '');
  if (doc.demo.notes) lines.push('', `Candidate: ${doc.demo.notes}`, '');
  lines.push(`## Open questions for the platform-team talk${agreedMark('openQuestions')}`, '');
  if (doc.openQuestions.length === 0) lines.push('_(none yet)_');
  else doc.openQuestions.forEach(q => lines.push(`- ${q}`));
  lines.push('');
  return lines.join('\n');
}

export type DiscoveryDayStage = 'none' | 'ok' | 'day2' | 'day3' | 'overrun';

export function discoveryDayStage(args: {
  firstSessionAt: string | null;
  now: Date;
  workdays?: ReadonlySet<number>;
}): { workday: number; stage: DiscoveryDayStage } {
  if (!args.firstSessionAt) return { workday: 0, stage: 'none' };
  const start = new Date(args.firstSessionAt);
  if (Number.isNaN(start.getTime())) return { workday: 0, stage: 'none' };
  const workday = countWorkingDays(start, args.now, args.workdays ?? getWorkingDays());
  let stage: DiscoveryDayStage;
  if (workday <= 1) stage = 'ok';
  else if (workday === 2) stage = 'day2';
  else if (workday === 3) stage = 'day3';
  else stage = 'overrun';
  return { workday, stage };
}

/**
 * Short label for the D&D list row: how far into the discovery the user is.
 *
 * One helper so the label and {@link discoveryDayNudge} can't disagree. The list
 * used to build `day ${workday} of 2` inline, which read as "day 3 of 2" on the
 * extra day and worse past the end. The budget really is two days plus one
 * extra, so the third day gets named rather than counted.
 */
export function discoveryDayLabel(stage: DiscoveryDayStage, workday: number): string | null {
  switch (stage) {
    case 'ok':
    case 'day2':
      return `day ${workday} of 2`;
    case 'day3':
      return 'day 3 — the extra day';
    case 'overrun':
      return 'past its 3 days';
    default:
      return null;
  }
}

export function discoveryDayNudge(stage: DiscoveryDayStage): string | null {
  switch (stage) {
    case 'day2': return 'Discovery day 2 — aim to wrap it up today.';
    case 'day3': return 'Discovery day 3, the extra day — close it out.';
    case 'overrun': return 'This discovery ran past its 3 days — close it or say why it needs longer.';
    default: return null;
  }
}

/** Once discovery is finished, the sequence is walkthrough → demo → close.
 *  orient surfaces this so a plain "what's next?" names the real next step,
 *  instead of the session guessing "just close it" from finished + dayNudge.
 *  Null while discovery is unfinished — the day/start nudges own that phase. */
export function discoveryNextStep(status: {
  finished: boolean;
  hasWalkthrough: boolean;
  hasDemoHtml: boolean;
}): string | null {
  if (!status.finished) return null;
  if (!status.hasWalkthrough) {
    return 'Discovery is done. Next: build the walkthrough (a slideshow to present it), then the concept demo. Say "build the walkthrough".';
  }
  if (!status.hasDemoHtml) {
    return 'Walkthrough is built. Next: build the concept demo (a page picturing the product working). Say "build the demo".';
  }
  return 'Walkthrough and demo are both built. Next: review them, then close the discovery story.';
}

/** Title-based: POM discovery stories are titled "Discovery: X". */
export function isDiscoveryStoryTitle(title: string): boolean {
  return /^\s*discovery\b/i.test(title);
}

/** The story-close gate's message. null = allowed to close. Content gaps and
 *  agreement gaps read as separate sentences — one says "fill it in", the
 *  other says "walk it through with USER and get a yes" — so a mixed case
 *  doesn't tell USER to just fill in something that's already written but
 *  not yet agreed. */
export function discoveryCloseBlockMessage(args: {
  isDiscoveryStory: boolean;
  folderPath: string | null;
  check: { ok: boolean; missing: string[]; unagreed: string[] };
}): string | null {
  if (!args.isDiscoveryStory) return null;
  if (args.check.ok) return null;
  const { missing, unagreed } = args.check;
  const sentences: string[] = [];
  if (missing.length > 0) {
    const gaps = missing.join('; ');
    sentences.push(
      unagreed.length > 0
        ? `This discovery isn't finished yet — still needs: ${gaps}.`
        : `This discovery isn't finished yet — still needs: ${gaps}. Fill it in, then close the story.`,
    );
  }
  if (unagreed.length > 0) {
    sentences.push(
      `These parts aren't agreed yet: ${unagreed.join(', ')}. Explain each one to the user in plain words, get their yes, then close the story.`,
    );
  }
  return sentences.join(' ');
}

export function discoveryStartNudge(status: { hasDiscovery: boolean; finished: boolean }): string | null {
  if (status.finished) return null;
  if (!status.hasDiscovery) {
    return 'Heads up: this feature has no finished discovery yet. Want to start one before building?';
  }
  return 'Heads up: this feature\'s discovery is not finished yet.';
}
