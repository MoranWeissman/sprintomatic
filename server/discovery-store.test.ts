// server/discovery-store.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readdirSync } from 'node:fs';
import type { AtomicWriter } from './atomic-write';
import { readDiscoveryDoc, writeDiscoveryDoc, discoveryStatus, discoveryStartedAt, DISCOVERY_MD, DISCOVERY_DIR, htmlArtifactPath, hasHtmlArtifact, listMeetings, MEETINGS_DIR } from './discovery-store';
import { emptyDiscoveryDoc, discoveryDayStage, discoveryDayNudge } from './discovery';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'disco-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('discovery-store', () => {
  it('reads null when no file / garbage file', () => {
    expect(readDiscoveryDoc(dir)).toBeNull();
    mkdirSync(join(dir, DISCOVERY_DIR), { recursive: true });
    writeFileSync(join(dir, DISCOVERY_DIR, 'discovery.json'), 'not json {');
    expect(readDiscoveryDoc(dir)).toBeNull();
  });

  it('writes the json AND a rendered markdown into the discovery/ subfolder', () => {
    const doc = emptyDiscoveryDoc();
    doc.problem = 'Move CD.';
    doc.flow = ['step 1'];
    writeDiscoveryDoc(dir, doc, '**Declarative CD** (#100)');
    expect(existsSync(join(dir, DISCOVERY_DIR, 'discovery.json'))).toBe(true);
    expect(existsSync(join(dir, DISCOVERY_DIR, DISCOVERY_MD))).toBe(true);
    expect(readFileSync(join(dir, DISCOVERY_DIR, DISCOVERY_MD), 'utf8')).toContain('# Discovery: **Declarative CD** (#100)');
    expect(readDiscoveryDoc(dir)!.problem).toBe('Move CD.');
  });

  it('still reads a legacy file written at the feature-folder root', () => {
    const doc = emptyDiscoveryDoc();
    doc.problem = 'Legacy root draft.';
    // Simulate a file written before the discovery/ split.
    writeFileSync(join(dir, 'discovery.json'), JSON.stringify(doc));
    expect(readDiscoveryDoc(dir)?.problem).toBe('Legacy root draft.');
  });

  it('discoveryStatus reports has/finished/demo from the folder', () => {
    expect(discoveryStatus(dir)).toEqual({
      hasDiscovery: false, finished: false, missing: expect.any(Array), unagreed: expect.any(Array),
      demoStatus: 'none', hasWalkthrough: false, hasDemoHtml: false,
    });
    const doc = emptyDiscoveryDoc();
    doc.flow = ['s1', 's2'];
    doc.groups = [{ name: 'g', items: [
      { text: 'a', tags: ['diff'] }, { text: 'b', tags: ['risk'] }, { text: 'c', tags: ['fact'] },
    ] }];
    doc.agreed = ['flow', 'group:g'];
    doc.demo.status = 'scheduled';
    writeDiscoveryDoc(dir, doc, '#100');
    const st = discoveryStatus(dir);
    expect(st.hasDiscovery).toBe(true);
    expect(st.finished).toBe(true);
    expect(st.demoStatus).toBe('scheduled');
    expect(st.hasWalkthrough).toBe(false);
    expect(st.hasDemoHtml).toBe(false);

    // Once the artifact files land, the status flips.
    mkdirSync(join(dir, 'demo'), { recursive: true });
    writeFileSync(join(dir, 'demo', 'walkthrough.html'), '<!doctype html><title>w</title>');
    expect(discoveryStatus(dir).hasWalkthrough).toBe(true);
    expect(discoveryStatus(dir).hasDemoHtml).toBe(false);
  });

  it('maps html artifact kinds to demo/ files and reports existence', () => {
    expect(htmlArtifactPath(dir, 'walkthrough')).toBe(join(dir, 'demo', 'walkthrough.html'));
    expect(htmlArtifactPath(dir, 'demo')).toBe(join(dir, 'demo', 'concept-demo.html'));

    expect(hasHtmlArtifact(dir, 'demo')).toBe(false);
    mkdirSync(join(dir, 'demo'), { recursive: true });
    writeFileSync(join(dir, 'demo', 'concept-demo.html'), '<!doctype html><title>x</title>');
    expect(hasHtmlArtifact(dir, 'demo')).toBe(true);
    expect(hasHtmlArtifact(dir, 'walkthrough')).toBe(false);
  });
});

describe('listMeetings', () => {
  const meetingsDir = () => join(dir, DISCOVERY_DIR, MEETINGS_DIR);
  const addMeeting = (name: string, content: string) => {
    mkdirSync(meetingsDir(), { recursive: true });
    writeFileSync(join(meetingsDir(), name), content);
  };

  it('returns [] when the meetings folder does not exist', () => {
    expect(listMeetings(dir)).toEqual([]);
  });

  it('lists meetings newest first by filename', () => {
    addMeeting('2026-07-20.md', '# Kickoff\nFirst talk.');
    addMeeting('2026-07-27.md', '# Platform team\nSecond talk.');
    const out = listMeetings(dir);
    expect(out.map(m => m.file)).toEqual(['2026-07-27.md', '2026-07-20.md']);
  });

  it('extracts title from the first # heading and body without it', () => {
    addMeeting('2026-07-27.md', '# Platform team — deploy flow\n\nWe agreed on X.\n');
    const [m] = listMeetings(dir);
    expect(m.title).toBe('Platform team — deploy flow');
    expect(m.body).toBe('We agreed on X.');
    expect(m.date).toBe('2026-07-27');
  });

  it('falls back to the filename when there is no # heading', () => {
    addMeeting('2026-07-27-sync.md', 'Just notes, no heading.');
    const [m] = listMeetings(dir);
    expect(m.title).toBe('2026-07-27-sync');
    expect(m.body).toBe('Just notes, no heading.');
    expect(m.date).toBe('2026-07-27');
  });

  it('keeps a file without a date prefix, with empty date', () => {
    addMeeting('notes.md', '# Old notes\nBody.');
    const [m] = listMeetings(dir);
    expect(m.file).toBe('notes.md');
    expect(m.date).toBe('');
    expect(m.title).toBe('Old notes');
  });

  it('normalizes ##/### sub-headings in the body to the house **bold** lines', () => {
    addMeeting('2026-07-27.md', '# Title\n\n## Decisions\n- moved to the new queue\n### Details\ntext');
    const [m] = listMeetings(dir);
    expect(m.body).toBe('**Decisions**\n- moved to the new queue\n**Details**\ntext');
  });

  it('ignores non-md files and subdirectories', () => {
    addMeeting('2026-07-27.md', '# Real\nBody.');
    writeFileSync(join(meetingsDir(), 'image.png'), 'binary');
    mkdirSync(join(meetingsDir(), 'drafts'), { recursive: true });
    expect(listMeetings(dir).map(m => m.file)).toEqual(['2026-07-27.md']);
  });

  it('never throws on an unreadable folder path', () => {
    expect(listMeetings(join(dir, 'no-such-feature'))).toEqual([]);
  });

  it('falls back to the filename when the first non-blank line is a paragraph, even with a heading mid-file', () => {
    addMeeting(
      '2026-07-27-sync.md',
      'Quick notes before the call started.\n\n# Decisions\n- moved to the new queue\n',
    );
    const [m] = listMeetings(dir);
    expect(m.title).toBe('2026-07-27-sync');
    expect(m.body).toContain('Quick notes before the call started.');
    expect(m.body).toContain('**Decisions**\n- moved to the new queue');
  });

  it('detects the title heading even after leading blank lines', () => {
    addMeeting('2026-07-27.md', '\n\n  # Platform team\nBody line.');
    const [m] = listMeetings(dir);
    expect(m.title).toBe('Platform team');
    expect(m.body).toBe('Body line.');
  });

  it('skips an unreadable file but still lists the readable ones', () => {
    addMeeting('2026-07-27.md', '# Good\nFine.');
    const badPath = join(meetingsDir(), '2026-07-20-bad.md');
    writeFileSync(badPath, '# Bad\nUnreachable.');
    chmodSync(badPath, 0o000);
    try {
      // Guard: only assert the skip behavior if this environment actually
      // enforces the permission bits (e.g. not running as root, where
      // reads succeed regardless of chmod).
      readFileSync(badPath, 'utf8');
      // If we get here, chmod 000 did not block the read on this host —
      // skip the assertion rather than leave a flaky test.
    } catch {
      const out = listMeetings(dir);
      expect(out.map(m => m.file)).toEqual(['2026-07-27.md']);
    } finally {
      chmodSync(badPath, 0o644);
    }
  });
});

describe('discoveryStartedAt — the day clock counts the discovery, not the folder', () => {
  // The bug this fixes: the clock ran from active_feature.setAt, i.e. when the
  // FEATURE FOLDER was opened. So "past its 3 days" fired about discoveries
  // that had not started, and understated nothing — it just measured the wrong
  // thing. #100905 (no discovery at all) would have been warned at day 4.
  it('is null when there is no discovery file — so no day nudge fires', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sh-started-none-'));
    try {
      expect(discoveryStartedAt(dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns the moment the discovery file appeared once one exists', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sh-started-'));
    try {
      const before = Date.now();
      writeDiscoveryDoc(dir, emptyDiscoveryDoc(), '**X** (#1)');
      const got = discoveryStartedAt(dir);
      expect(got).not.toBeNull();
      const at = new Date(got!).getTime();
      // Created just now, so it sits in this test's own window — not whenever
      // the feature folder happened to be opened.
      expect(at).toBeGreaterThanOrEqual(before - 2000);
      expect(at).toBeLessThanOrEqual(Date.now() + 2000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('feeds discoveryDayStage so a discovery started today reads as ok', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sh-started-stage-'));
    try {
      writeDiscoveryDoc(dir, emptyDiscoveryDoc(), '**X** (#1)');
      const { stage } = discoveryDayStage({
        firstSessionAt: discoveryStartedAt(dir),
        now: new Date(),
      });
      expect(stage).toBe('ok');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a null start means stage none, which is what silences the nudge', () => {
    const { stage } = discoveryDayStage({ firstSessionAt: null, now: new Date() });
    expect(stage).toBe('none');
    expect(discoveryDayNudge(stage)).toBeNull();
  });
});


describe('discovery writes are safe against a crash mid-write', () => {
  const NAME = '**Declarative CD** (#100001)';

  /** A writer whose rename never lands — stands in for a crash or a full disk
   *  after the temp file was written. */
  const failingWriter: AtomicWriter = {
    writeFile: (path, content) => writeFileSync(path, content),
    rename: () => { throw new Error('rename failed on purpose'); },
  };

  it('leaves no temp file behind after a normal write', () => {
    const doc = emptyDiscoveryDoc();
    doc.problem = 'Move CD.';
    writeDiscoveryDoc(dir, doc, NAME);
    const names = readdirSync(join(dir, DISCOVERY_DIR));
    expect(names.some(n => n.includes('.tmp'))).toBe(false);
    expect(names).toContain('discovery.json');
    expect(names).toContain(DISCOVERY_MD);
  });

  it('a failed write leaves the discovery already on disk exactly as it was', () => {
    const good = emptyDiscoveryDoc();
    good.problem = 'The discovery the user already wrote.';
    writeDiscoveryDoc(dir, good, NAME);
    const jsonPath = join(dir, DISCOVERY_DIR, 'discovery.json');
    const before = readFileSync(jsonPath, 'utf8');

    const next = emptyDiscoveryDoc();
    next.problem = 'A newer draft that never lands.';
    expect(() => writeDiscoveryDoc(dir, next, NAME, failingWriter)).toThrow('on purpose');

    expect(readFileSync(jsonPath, 'utf8')).toBe(before);
    expect(readDiscoveryDoc(dir)!.problem).toBe('The discovery the user already wrote.');
    expect(readdirSync(join(dir, DISCOVERY_DIR)).some(n => n.includes('.tmp'))).toBe(false);
  });
});
