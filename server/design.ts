/**
 * Per-feature design phase: the source-file shape, its markdown render, the
 * agree-per-part coverage check, and the three ordered gates (agreed →
 * reviewed → pushed). Pure functions over data passed in; never throws;
 * every reader tolerates missing/garbage input — same discipline as
 * server/discovery.ts. No fs access here; that's server/design-store.ts.
 */

export interface DesignStory {
  title: string;
  covers: string;
  estimateHours: number;
  why: string;
  /** What the BOARD should show as this story's description. Optional. When
   *  it's there, the push writes this instead of `covers` — `covers` is the
   *  design record's own detail, this is the text the delivery manager reads. */
  boardDescription?: string;
}

export interface DesignDoc {
  /** A free line at the top of the design — "reworked 2026-08-04, the earlier
   *  yes-marks are off until re-agreed". Not a part to agree, just a note the
   *  next reader needs. Empty most of the time. */
  note: string;
  approach: { lines: string[]; diagram: string };
  /** "Not in this design" — deliberate scope cuts, named up front so the
   *  review doesn't relitigate them. Empty = nothing was cut. */
  outOfScope: string[];
  flows: { name: string; steps: string[]; diagram: string }[];
  stories: DesignStory[];
  plan: { step: string; stories: string[]; note: string }[];
  decisions: { question: string; choice: string; decidedInMeeting: string }[];
  review: { status: 'none' | 'scheduled' | 'done'; date: string };
  /** Written by the push tool only — chats never hand-write it. */
  pushed: { at: string; storyIds: number[] };
  /** Agree-per-part record. Keys: 'approach','flows','plan','decisions','story:<title>'. */
  agreed: string[];
}

const VALID_REVIEW: ReadonlySet<string> = new Set(['none', 'scheduled', 'done']);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const strArray = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
const numArray = (v: unknown): number[] =>
  Array.isArray(v) ? v.filter((x): x is number => typeof x === 'number' && Number.isFinite(x)) : [];
const obj = (v: unknown): Record<string, unknown> =>
  (v != null && typeof v === 'object' && !Array.isArray(v)) ? v as Record<string, unknown> : {};

export function emptyDesignDoc(): DesignDoc {
  return {
    note: '',
    approach: { lines: [], diagram: '' },
    outOfScope: [],
    flows: [], stories: [], plan: [], decisions: [],
    review: { status: 'none', date: '' },
    pushed: { at: '', storyIds: [] },
    agreed: [],
  };
}

function parseStory(v: unknown): DesignStory | null {
  const o = obj(v);
  if (typeof o.title !== 'string' || o.title === '') return null;
  const hours = (typeof o.estimateHours === 'number' && Number.isFinite(o.estimateHours)) ? o.estimateHours : 0;
  const bd = str(o.boardDescription);
  return { title: o.title, covers: str(o.covers), estimateHours: hours, why: str(o.why), boardDescription: bd || undefined };
}

export function parseDesignDoc(raw: string | null | undefined): DesignDoc | null {
  if (!raw) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return null; }
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const o = parsed as Record<string, unknown>;
  const approach = obj(o.approach);
  const review = obj(o.review);
  const pushed = obj(o.pushed);
  return {
    note: str(o.note),
    approach: { lines: strArray(approach.lines), diagram: str(approach.diagram) },
    outOfScope: strArray(o.outOfScope),
    flows: Array.isArray(o.flows) ? o.flows.map(f => {
      const fo = obj(f);
      return typeof fo.name === 'string'
        ? { name: fo.name, steps: strArray(fo.steps), diagram: str(fo.diagram) } : null;
    }).filter((f): f is DesignDoc['flows'][number] => f !== null) : [],
    stories: Array.isArray(o.stories)
      ? o.stories.map(parseStory).filter((s): s is DesignStory => s !== null) : [],
    plan: Array.isArray(o.plan) ? o.plan.map(p => {
      const po = obj(p);
      return typeof po.step === 'string'
        ? { step: po.step, stories: strArray(po.stories), note: str(po.note) } : null;
    }).filter((p): p is DesignDoc['plan'][number] => p !== null) : [],
    decisions: Array.isArray(o.decisions) ? o.decisions.map(d => {
      const dd = obj(d);
      return typeof dd.question === 'string'
        ? { question: dd.question, choice: str(dd.choice), decidedInMeeting: str(dd.decidedInMeeting) } : null;
    }).filter((d): d is DesignDoc['decisions'][number] => d !== null) : [],
    review: {
      status: (typeof review.status === 'string' && VALID_REVIEW.has(review.status)
        ? review.status : 'none') as DesignDoc['review']['status'],
      date: str(review.date),
    },
    pushed: { at: str(pushed.at), storyIds: numArray(pushed.storyIds) },
    agreed: strArray(o.agreed),
  };
}

/** Agree-per-part coverage: every part with content + every story needs its
 *  key in `agreed`. Labels are plain English for the block message. */
export function designAgreementCheck(doc: DesignDoc): { ok: boolean; unagreed: string[] } {
  const unagreed: string[] = [];
  const parts: { key: string; present: boolean; label: string }[] = [
    { key: 'approach', present: doc.approach.lines.length > 0 || doc.approach.diagram.trim() !== '', label: 'the approach' },
    { key: 'outOfScope', present: doc.outOfScope.length > 0, label: 'the "not in this design" list' },
    { key: 'flows', present: doc.flows.length > 0, label: 'the flows' },
    ...doc.stories.map(s => ({ key: `story:${s.title}`, present: true, label: `the story "${s.title}"` })),
    { key: 'plan', present: doc.plan.length > 0, label: 'the working plan' },
    { key: 'decisions', present: doc.decisions.length > 0, label: 'the open decisions' },
  ];
  for (const p of parts) {
    if (p.present && !doc.agreed.includes(p.key)) unagreed.push(p.label);
  }
  return { ok: unagreed.length === 0, unagreed };
}

/** Title-based: design stories are titled "Design: X" (mirror of discovery). */
export function isDesignStoryTitle(title: string): boolean {
  return /^\s*design\b/i.test(title);
}

/* ============================================================
   Checks. The design file is the one place in the workspace where a bad
   edit is SILENT: a search-and-replace that matches nothing doesn't fail,
   it just leaves the design saying something nobody meant. These turn that
   into a message. Pure — the fs side lives in design-store.ts.
   ============================================================ */

/** Every string in the doc, each with a plain-English name for where it is. */
function labelledText(doc: DesignDoc): { where: string; text: string }[] {
  const out: { where: string; text: string }[] = [];
  doc.approach.lines.forEach(l => out.push({ where: 'the approach', text: l }));
  doc.outOfScope.forEach(l => out.push({ where: 'the "not in this design" list', text: l }));
  doc.flows.forEach(f => {
    out.push({ where: `the flow "${f.name}"`, text: f.name });
    f.steps.forEach(s => out.push({ where: `the flow "${f.name}"`, text: s }));
  });
  doc.stories.forEach(s => {
    out.push({ where: `the story "${s.title}"`, text: `${s.title} ${s.covers} ${s.why}` });
  });
  doc.plan.forEach(p => out.push({ where: 'the working plan', text: `${p.step} ${p.note}` }));
  doc.decisions.forEach(d => out.push({ where: 'the open decisions', text: `${d.question} ${d.choice}` }));
  return out;
}

/** "turns green", "all green", "is red" — a colour standing in for a state. */
const COLOUR_AS_STATE = /\b(?:turns?|goes|stays?|is|are|all|everything is)\s+(?:green|red)\b/i;

/**
 * Everything wrong with a design, in plain words, ready to read out.
 *
 * `diagramsOnDisk` is what actually sits in `design/diagrams/`. A picture
 * named here but missing from disk breaks the slideshow with no error at
 * all — that is the whole reason this check exists.
 */
export function designProblems(doc: DesignDoc, diagramsOnDisk: readonly string[]): string[] {
  const problems: string[] = [];
  const onDisk = new Set(diagramsOnDisk);

  const needPicture = (name: string, where: string): void => {
    if (name.trim() !== '' && !onDisk.has(name)) {
      problems.push(`${where} names the picture \`${name}\`, but that file is not in design/diagrams/.`);
    }
  };
  needPicture(doc.approach.diagram, 'The approach');
  doc.flows.forEach(f => needPicture(f.diagram, `The flow "${f.name}"`));

  for (const { where, text } of labelledText(doc)) {
    const hit = text.match(COLOUR_AS_STATE);
    if (hit) {
      problems.push(`Colours are not states — say passed or failed. Found "${hit[0]}" in ${where}.`);
    }
  }

  doc.stories
    .filter(s => s.estimateHours <= 0)
    .forEach(s => problems.push(`The story "${s.title}" has no hours yet. The push refuses a story with no hours.`));

  const titles = new Set(doc.stories.map(s => s.title));
  doc.agreed
    .filter(k => k.startsWith('story:'))
    .map(k => k.slice('story:'.length))
    .filter(t => !titles.has(t))
    .forEach(t => problems.push(
      `The agreed list still marks the story "${t}", but no story has that title now. Retitling drops the mark — walk that story again and ask for a fresh yes.`,
    ));

  return problems;
}

/**
 * What the parser had to throw away. The reader is deliberately forgiving —
 * a wrongly-shaped entry is skipped rather than blowing up the whole file —
 * so without this, an edit that mangles one decision loses it in silence.
 */
export function droppedByParse(raw: string, doc: DesignDoc): string[] {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return []; }
  const o = obj(parsed);
  const countIn = (v: unknown): number => (Array.isArray(v) ? v.length : 0);

  const lists: { raw: unknown; kept: number; name: string }[] = [
    { raw: obj(o.approach).lines, kept: doc.approach.lines.length, name: 'approach lines' },
    { raw: o.outOfScope, kept: doc.outOfScope.length, name: '"not in this design" lines' },
    { raw: o.flows, kept: doc.flows.length, name: 'flows' },
    { raw: o.stories, kept: doc.stories.length, name: 'stories' },
    { raw: o.plan, kept: doc.plan.length, name: 'plan steps' },
    { raw: o.decisions, kept: doc.decisions.length, name: 'decisions' },
  ];

  return lists
    .filter(l => countIn(l.raw) > l.kept)
    .map(l => `${countIn(l.raw) - l.kept} of the ${countIn(l.raw)} ${l.name} in design.json are not shaped right and were skipped. Check the last edit.`);
}

export type DesignGateStep = 'none' | 'start' | 'agree' | 'review' | 'push';

/** The three ordered doors as data. 'none' = all passed (or not a design
 *  story). The message is the plain-English block text for that step. */
export function designGate(args: {
  isDesignStory: boolean;
  doc: DesignDoc | null;
  meetingCount: number;
}): { step: DesignGateStep; message: string | null } {
  if (!args.isDesignStory) return { step: 'none', message: null };
  if (!args.doc) {
    return { step: 'start', message: 'This design story has no design yet. Start the design (the design skill walks it part by part), then close.' };
  }
  const check = designAgreementCheck(args.doc);
  if (!check.ok) {
    return { step: 'agree', message: `These parts of the design aren't agreed yet: ${check.unagreed.join(', ')}. Explain each one to the user in plain words, get their yes, then continue.` };
  }
  const reviewed = args.doc.review.status === 'done' && args.meetingCount > 0;
  if (!reviewed) {
    return { step: 'review', message: 'All parts are agreed. Next: hold the design review with the team, record it as a meeting summary, and mark the review done. Then the stories can go to the board.' };
  }
  if (args.doc.pushed.storyIds.length === 0) {
    return { step: 'push', message: 'Agreed and reviewed. Next: push the stories to the board with the push tool, then close this design story.' };
  }
  return { step: 'none', message: null };
}

/** The story-close gate's message. Names ONLY the first unmet gate —
 *  one instruction at a time, never a wall. null = allowed to close. */
export function designGateMessage(args: {
  isDesignStory: boolean;
  doc: DesignDoc | null;
  meetingCount: number;
}): string | null {
  return designGate(args).message;
}

export function renderDesignMarkdown(
  doc: DesignDoc,
  opts: { featureDisplayName: string },
): string {
  const mark = (key: string): string => (doc.agreed.includes(key) ? ' · agreed ✓' : '');
  const lines: string[] = [];
  // design.md is a render of design.json, never a second copy to keep in step.
  // Say so in the file, so nobody hand-edits it and loses the change.
  lines.push(
    '<!-- Written from design.json by sprintomatic (design_sync).',
    '     Do NOT edit this file — your change is lost on the next write.',
    '     Edit design.json instead. -->',
    '',
  );
  lines.push(`# Design: ${opts.featureDisplayName}`, '');
  if (doc.note.trim() !== '') {
    doc.note.split('\n').forEach(l => lines.push(l.trim() === '' ? '>' : `> ${l}`));
    lines.push('');
  }
  lines.push(`## The approach${mark('approach')}`, '');
  if (doc.approach.lines.length === 0) lines.push('_(not filled in)_');
  else doc.approach.lines.forEach(l => lines.push(`- ${l}`));
  if (doc.approach.diagram) lines.push('', `Picture: ${doc.approach.diagram}`);
  lines.push('');
  lines.push(`## Not in this design${mark('outOfScope')}`, '');
  if (doc.outOfScope.length === 0) lines.push('_(nothing cut)_');
  else doc.outOfScope.forEach(x => lines.push(`- ${x}`));
  lines.push('');
  lines.push(`## The flows${mark('flows')}`, '');
  if (doc.flows.length === 0) lines.push('_(none yet)_', '');
  for (const f of doc.flows) {
    lines.push(`### ${f.name}`, '');
    f.steps.forEach((s, i) => lines.push(`${i + 1}. ${s}`));
    if (f.diagram) lines.push('', `Picture: ${f.diagram}`);
    lines.push('');
  }
  lines.push('## The stories', '');
  if (doc.stories.length === 0) lines.push('_(none yet)_', '');
  for (const s of doc.stories) {
    lines.push(`### ${s.title} — ${s.estimateHours}h${mark(`story:${s.title}`)}`, '');
    lines.push(s.covers || '_(no description)_', '');
    if (s.boardDescription) lines.push('_On the board:_', s.boardDescription, '');
    lines.push(`Why this estimate: ${s.why || '_(not justified yet)_'}`, '');
  }
  lines.push(`## The working plan${mark('plan')}`, '');
  if (doc.plan.length === 0) lines.push('_(none yet)_');
  else doc.plan.forEach((p, i) => {
    const which = p.stories.length ? ` — ${p.stories.join(', ')}` : '';
    const note = p.note ? ` (${p.note})` : '';
    lines.push(`${i + 1}. ${p.step}${which}${note}`);
  });
  lines.push('');
  lines.push(`## Open decisions${mark('decisions')}`, '');
  if (doc.decisions.length === 0) lines.push('_(none)_');
  else for (const d of doc.decisions) {
    const settled = d.choice
      ? `${d.choice}${d.decidedInMeeting ? ` (decided in ${d.decidedInMeeting})` : ''}`
      : 'not decided yet';
    lines.push(`- ${d.question} → ${settled}`);
  }
  lines.push('');
  lines.push('## Review and push', '');
  lines.push(`review: ${doc.review.status}${doc.review.date ? ` · ${doc.review.date}` : ''}`);
  lines.push(doc.pushed.storyIds.length
    ? `pushed: ${doc.pushed.storyIds.length} stories · ${doc.pushed.at}`
    : 'pushed: not yet');
  lines.push('');
  return lines.join('\n');
}
