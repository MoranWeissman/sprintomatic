// server/design-store.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import type { AtomicWriter } from './atomic-write';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  readDesignDoc, writeDesignDoc, listDesignMeetings, listDiagrams, diagramPath, syncDesignMarkdown,
} from './design-store';
import { emptyDesignDoc } from './design';
import { listMeetings, hasHtmlArtifact } from './discovery-store';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'design-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('design-store', () => {
  it('reads null with no design/ folder; round-trips after write', () => {
    expect(readDesignDoc(dir)).toBeNull();

    const doc = emptyDesignDoc();
    doc.approach.lines = ['Use a shared queue.'];
    writeDesignDoc(dir, doc, { featureDisplayName: '**Declarative CD** (#100)' });

    expect(existsSync(join(dir, 'design', 'design.json'))).toBe(true);
    expect(existsSync(join(dir, 'design', 'design.md'))).toBe(true);
    expect(readFileSync(join(dir, 'design', 'design.md'), 'utf8')).toContain('## The approach');
    expect(readDesignDoc(dir)!.approach.lines).toEqual(['Use a shared queue.']);
  });

  it('listDesignMeetings reads design/meetings/*.md and ignores sources/; missing folder -> []', () => {
    expect(listDesignMeetings(dir)).toEqual([]);

    const meetingsDir = join(dir, 'design', 'meetings');
    mkdirSync(meetingsDir, { recursive: true });
    writeFileSync(join(meetingsDir, '2026-07-28.md'), '# Design review\nAgreed on the approach.');
    mkdirSync(join(meetingsDir, 'sources'), { recursive: true });
    writeFileSync(join(meetingsDir, 'sources', 'transcript.md'), '# Should be ignored\nRaw transcript.');

    const out = listDesignMeetings(dir);
    expect(out.map(m => m.file)).toEqual(['2026-07-28.md']);
    expect(out[0].title).toBe('Design review');
  });

  it('listMeetings (discovery) still works — regression on the extraction', () => {
    expect(listMeetings(dir)).toEqual([]);
    const discoMeetings = join(dir, 'discovery', 'meetings');
    mkdirSync(discoMeetings, { recursive: true });
    writeFileSync(join(discoMeetings, '2026-07-20.md'), '# Kickoff\nFirst talk.');
    const out = listMeetings(dir);
    expect(out.map(m => m.file)).toEqual(['2026-07-20.md']);
    expect(out[0].title).toBe('Kickoff');
  });

  it('listDiagrams returns only .svg names, sorted; diagramPath rejects unsafe/wrong-ext names', () => {
    expect(listDiagrams(dir)).toEqual([]);

    const diagramsDir = join(dir, 'design', 'diagrams');
    mkdirSync(diagramsDir, { recursive: true });
    writeFileSync(join(diagramsDir, 'b-flow.svg'), '<svg></svg>');
    writeFileSync(join(diagramsDir, 'a-flow.svg'), '<svg></svg>');
    writeFileSync(join(diagramsDir, 'notes.txt'), 'not a diagram');
    writeFileSync(join(diagramsDir, 'deploy flow.svg'), '<svg></svg>');

    expect(listDiagrams(dir)).toEqual(['a-flow.svg', 'b-flow.svg']);

    expect(diagramPath(dir, '../evil.svg')).toBeNull();
    expect(diagramPath(dir, 'x.png')).toBeNull();
    expect(diagramPath(dir, 'deploy-flow.svg')).toBe(join(dir, 'design', 'diagrams', 'deploy-flow.svg'));
  });

  it('hasHtmlArtifact for design-walkthrough flips true after writing design/walkthrough.html; walkthrough still resolves to demo/', () => {
    expect(hasHtmlArtifact(dir, 'design-walkthrough')).toBe(false);
    mkdirSync(join(dir, 'design'), { recursive: true });
    writeFileSync(join(dir, 'design', 'walkthrough.html'), '<!doctype html><title>w</title>');
    expect(hasHtmlArtifact(dir, 'design-walkthrough')).toBe(true);

    expect(hasHtmlArtifact(dir, 'walkthrough')).toBe(false);
    mkdirSync(join(dir, 'demo'), { recursive: true });
    writeFileSync(join(dir, 'demo', 'walkthrough.html'), '<!doctype html><title>w</title>');
    expect(hasHtmlArtifact(dir, 'walkthrough')).toBe(true);
  });
});

describe('syncDesignMarkdown', () => {
  const NAME = { featureDisplayName: '**Declarative CD** (#100)' };

  function writeJson(value: unknown): void {
    mkdirSync(join(dir, 'design'), { recursive: true });
    writeFileSync(join(dir, 'design', 'design.json'), JSON.stringify(value, null, 2));
  }

  it('says so plainly when there is no design yet', () => {
    const res = syncDesignMarkdown(dir, NAME);
    expect(res.ok).toBe(false);
    expect(res.problems[0]).toContain('no design/design.json');
  });

  it('rewrites design.md from design.json and counts the parts', () => {
    const doc = emptyDesignDoc();
    doc.approach.lines = ['Use a shared queue.'];
    doc.decisions = [{ question: 'one app or two?', choice: '', decidedInMeeting: '' }];
    writeJson(doc);

    const res = syncDesignMarkdown(dir, NAME);
    expect(res.ok).toBe(true);
    expect(res.counts).toEqual({ flows: 0, stories: 0, plan: 0, decisions: 1 });
    const md = readFileSync(join(dir, 'design', 'design.md'), 'utf8');
    expect(md).toContain('Do NOT edit this file');
    expect(md).toContain('Use a shared queue.');
    expect(md).toContain('one app or two?');
  });

  // The point of the whole thing: design.md can never be a stale second copy.
  it('overwrites a design.md that had drifted', () => {
    const doc = emptyDesignDoc();
    doc.approach.lines = ['the real approach'];
    writeJson(doc);
    writeFileSync(join(dir, 'design', 'design.md'), '# something someone typed by hand');

    syncDesignMarkdown(dir, NAME);
    const md = readFileSync(join(dir, 'design', 'design.md'), 'utf8');
    expect(md).toContain('the real approach');
    expect(md).not.toContain('someone typed by hand');
  });

  it('writes nothing when design.json is broken, and keeps the good render', () => {
    const doc = emptyDesignDoc();
    doc.approach.lines = ['the good version'];
    writeJson(doc);
    syncDesignMarkdown(dir, NAME);

    writeFileSync(join(dir, 'design', 'design.json'), '{ "approach": ');
    const res = syncDesignMarkdown(dir, NAME);

    expect(res.ok).toBe(false);
    expect(res.problems[0]).toContain('not valid JSON');
    expect(readFileSync(join(dir, 'design', 'design.md'), 'utf8')).toContain('the good version');
  });

  it('reports a missing picture but still writes the markdown', () => {
    const doc = emptyDesignDoc();
    doc.approach = { lines: ['a'], diagram: 'architecture.svg' };
    writeJson(doc);

    const res = syncDesignMarkdown(dir, NAME);
    expect(res.ok).toBe(true);
    expect(res.problems[0]).toContain('architecture.svg');
    expect(existsSync(join(dir, 'design', 'design.md'))).toBe(true);
  });

  it('stops reporting the picture once the file is on disk', () => {
    const doc = emptyDesignDoc();
    doc.approach = { lines: ['a'], diagram: 'architecture.svg' };
    writeJson(doc);
    mkdirSync(join(dir, 'design', 'diagrams'), { recursive: true });
    writeFileSync(join(dir, 'design', 'diagrams', 'architecture.svg'), '<svg/>');

    expect(syncDesignMarkdown(dir, NAME).problems).toEqual([]);
  });

  it('reports an entry the reader had to skip', () => {
    writeJson({ ...emptyDesignDoc(), decisions: [{ question: 'q', choice: '', decidedInMeeting: '' }, 'oops'] });
    const res = syncDesignMarkdown(dir, NAME);
    expect(res.ok).toBe(true);
    expect(res.problems[0]).toContain('1 of the 2 decisions');
  });
});


describe('design writes are safe against a crash mid-write', () => {
  const OPTS = { featureDisplayName: '**Declarative CD** (#100001)' };

  /** A writer whose rename never lands — stands in for a crash or a full disk
   *  after the temp file was written. */
  const failingWriter: AtomicWriter = {
    writeFile: (path, content) => writeFileSync(path, content),
    rename: () => { throw new Error('rename failed on purpose'); },
  };

  it('leaves no temp file behind after a normal write', () => {
    const doc = emptyDesignDoc();
    doc.approach.lines = ['Use a shared queue.'];
    writeDesignDoc(dir, doc, OPTS);
    const names = readdirSync(join(dir, 'design'));
    expect(names.some(n => n.includes('.tmp'))).toBe(false);
    expect(names).toContain('design.json');
    expect(names).toContain('design.md');
  });

  it('a failed write leaves the design already on disk exactly as it was', () => {
    const good = emptyDesignDoc();
    good.approach.lines = ['The approach the user already agreed to.'];
    writeDesignDoc(dir, good, OPTS);
    const jsonPath = join(dir, 'design', 'design.json');
    const before = readFileSync(jsonPath, 'utf8');

    const next = emptyDesignDoc();
    next.approach.lines = ['A newer draft that never lands.'];
    expect(() => writeDesignDoc(dir, next, OPTS, failingWriter)).toThrow('on purpose');

    expect(readFileSync(jsonPath, 'utf8')).toBe(before);
    expect(readDesignDoc(dir)!.approach.lines).toEqual(['The approach the user already agreed to.']);
    expect(readdirSync(join(dir, 'design')).some(n => n.includes('.tmp'))).toBe(false);
  });

  it('a failed markdown rebuild keeps the old design.md and says what went wrong', () => {
    const doc = emptyDesignDoc();
    doc.approach.lines = ['Use a shared queue.'];
    writeDesignDoc(dir, doc, OPTS);
    const mdPath = join(dir, 'design', 'design.md');
    const before = readFileSync(mdPath, 'utf8');

    const res = syncDesignMarkdown(dir, OPTS, failingWriter);

    expect(res.ok).toBe(false);
    expect(res.problems.join(' ')).toContain('on purpose');
    expect(readFileSync(mdPath, 'utf8')).toBe(before);
    expect(readdirSync(join(dir, 'design')).some(n => n.includes('.tmp'))).toBe(false);
  });
});
