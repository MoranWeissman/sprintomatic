// server/discovery.test.ts
import { describe, it, expect } from 'vitest';
import { parseDiscoveryDoc, emptyDiscoveryDoc, renderDiscoveryMarkdown, isGroupComplete, discoveryFinishedCheck, discoveryDayStage, discoveryDayNudge, discoveryDayLabel, discoveryCloseBlockMessage, discoveryStartNudge, discoveryNextStep } from './discovery';

describe('parseDiscoveryDoc', () => {
  it('returns null for unset/garbage input', () => {
    expect(parseDiscoveryDoc(null)).toBeNull();
    expect(parseDiscoveryDoc(undefined)).toBeNull();
    expect(parseDiscoveryDoc('not json {')).toBeNull();
    expect(parseDiscoveryDoc('[]')).toBeNull(); // array, not an object
    expect(parseDiscoveryDoc('42')).toBeNull();
  });

  it('parses a full valid doc and keeps its fields', () => {
    const doc = {
      problem: 'Move CD to GitHub.',
      flow: ['dev merges PR', 'pipeline runs', 'live in dev'],
      groups: [
        { name: 'How apps deploy', items: [
          { text: 'double the checkout servers', tags: ['diff', 'fact'] },
          { text: 'more Akuity cost', tags: ['risk'] },
        ] },
      ],
      lanes: { ours: 'the flow shape', techLead: 'pipeline internals' },
      demo: { status: 'scheduled', shape: 'pipeline', date: '2026-08-01' },
      openQuestions: ['who owns the runner?'],
    };
    const parsed = parseDiscoveryDoc(JSON.stringify(doc));
    expect(parsed).not.toBeNull();
    expect(parsed!.problem).toBe('Move CD to GitHub.');
    expect(parsed!.flow).toHaveLength(3);
    expect(parsed!.groups[0].items[0].tags).toEqual(['diff', 'fact']);
    expect(parsed!.demo.status).toBe('scheduled');
  });

  it('parses the demo candidate notes, defaulting to empty', () => {
    const withNotes = parseDiscoveryDoc(JSON.stringify({ demo: { status: 'none', notes: 'demo the dev-to-prod PR flow' } }));
    expect(withNotes!.demo.notes).toBe('demo the dev-to-prod PR flow');
    const withoutNotes = parseDiscoveryDoc(JSON.stringify({ demo: { status: 'none' } }));
    expect(withoutNotes!.demo.notes).toBe('');
  });

  it('drops unknown tags and malformed items rather than throwing', () => {
    const doc = {
      problem: 'x', flow: [], groups: [
        { name: 'g', items: [
          { text: 'ok', tags: ['diff', 'nonsense'] },
          { text: 42, tags: ['risk'] }, // bad text type -> dropped
          'garbage',                      // not an object -> dropped
        ] },
      ], lanes: { ours: '', techLead: '' },
      demo: { status: 'weird', shape: '', date: '' }, openQuestions: [],
    };
    const parsed = parseDiscoveryDoc(JSON.stringify(doc));
    expect(parsed).not.toBeNull();
    expect(parsed!.groups[0].items).toHaveLength(1);
    expect(parsed!.groups[0].items[0].tags).toEqual(['diff']); // 'nonsense' dropped
    expect(parsed!.demo.status).toBe('none'); // unknown status -> safe default
  });

  it('emptyDiscoveryDoc is a well-formed empty doc', () => {
    const e = emptyDiscoveryDoc();
    expect(e.problem).toBe('');
    expect(e.flow).toEqual([]);
    expect(e.groups).toEqual([]);
    expect(e.demo.status).toBe('none');
    expect(e.pushback).toEqual([]);
    expect(e.agreed).toEqual([]);
  });

  it('keeps the new dep and mitigation tags, still drops unknown ones', () => {
    const doc = {
      problem: 'x', flow: [], groups: [
        { name: 'g', items: [
          { text: 'needs platform-team access first', tags: ['dep'] },
          { text: 'start with one shared app', tags: ['mitigation', 'bogus'] },
        ] },
      ], lanes: { ours: '', techLead: '' },
      demo: { status: 'none', shape: '', date: '' }, openQuestions: [],
    };
    const parsed = parseDiscoveryDoc(JSON.stringify(doc));
    expect(parsed!.groups[0].items[0].tags).toEqual(['dep']);
    expect(parsed!.groups[0].items[1].tags).toEqual(['mitigation']);
  });

  it('reads pushback and agreed, defaulting to empty arrays', () => {
    const withBoth = parseDiscoveryDoc(JSON.stringify({
      pushback: ['this bundles two features', 7], agreed: ['problem', 'flow'],
    }));
    expect(withBoth!.pushback).toEqual(['this bundles two features']); // non-string dropped
    expect(withBoth!.agreed).toEqual(['problem', 'flow']);
    const without = parseDiscoveryDoc('{}');
    expect(without!.pushback).toEqual([]);
    expect(without!.agreed).toEqual([]);
  });
});

describe('isGroupComplete', () => {
  it('needs a diff, a risk, and a fact-or-option', () => {
    expect(isGroupComplete({ name: 'g', items: [
      { text: 'a', tags: ['diff'] }, { text: 'b', tags: ['risk'] }, { text: 'c', tags: ['fact'] },
    ] })).toBe(true);
    expect(isGroupComplete({ name: 'g', items: [
      { text: 'a', tags: ['diff'] }, { text: 'b', tags: ['risk'] }, // no fact/option
    ] })).toBe(false);
    expect(isGroupComplete({ name: 'g', items: [
      { text: 'a', tags: ['diff', 'fact', 'option'] }, // no risk
    ] })).toBe(false);
  });
});

describe('discoveryFinishedCheck', () => {
  it('fails for a null doc', () => {
    const r = discoveryFinishedCheck(null);
    expect(r.ok).toBe(false);
    expect(r.missing.length).toBeGreaterThan(0);
  });
  it('fails when the flow is empty', () => {
    const doc = emptyDiscoveryDoc();
    doc.groups = [{ name: 'g', items: [
      { text: 'a', tags: ['diff'] }, { text: 'b', tags: ['risk'] }, { text: 'c', tags: ['fact'] },
    ] }];
    const r = discoveryFinishedCheck(doc);
    expect(r.ok).toBe(false);
    expect(r.missing).toContain('an end-to-end flow');
  });
  it('fails when no group is complete', () => {
    const doc = emptyDiscoveryDoc();
    doc.flow = ['step 1'];
    doc.groups = [{ name: 'g', items: [{ text: 'a', tags: ['diff'] }] }];
    expect(discoveryFinishedCheck(doc).ok).toBe(false);
  });
  it('passes with a flow + one complete group', () => {
    const doc = emptyDiscoveryDoc();
    doc.flow = ['step 1', 'step 2'];
    doc.groups = [{ name: 'g', items: [
      { text: 'a', tags: ['diff'] }, { text: 'b', tags: ['risk'] }, { text: 'c', tags: ['option'] },
    ] }];
    doc.agreed = ['flow', 'group:g'];
    const r = discoveryFinishedCheck(doc);
    expect(r.ok).toBe(true);
    expect(r.missing).toEqual([]);
    expect(r.unagreed).toEqual([]);
  });
});

describe('discoveryFinishedCheck — agreement coverage', () => {
  // A doc that satisfies the CONTENT gate (flow + one complete group).
  function contentOkDoc() {
    const doc = emptyDiscoveryDoc();
    doc.flow = ['step 1', 'step 2'];
    doc.groups = [{ name: 'CD pipeline', items: [
      { text: 'a', tags: ['diff'] }, { text: 'b', tags: ['risk'] }, { text: 'c', tags: ['fact'] },
    ] }];
    return doc;
  }

  it('fails when non-empty parts are not agreed, naming each plainly', () => {
    const r = discoveryFinishedCheck(contentOkDoc());
    expect(r.ok).toBe(false);
    expect(r.unagreed).toContain('the end-to-end flow');
    expect(r.unagreed).toContain('the group "CD pipeline"');
  });

  it('passes when every non-empty part is agreed; empty parts need no mark', () => {
    const doc = contentOkDoc(); // problem, lanes, pushback, openQuestions all empty
    doc.agreed = ['flow', 'group:CD pipeline'];
    const r = discoveryFinishedCheck(doc);
    expect(r.ok).toBe(true);
    expect(r.missing).toEqual([]);
    expect(r.unagreed).toEqual([]);
  });

  it('requires agreement on problem, lanes, pushback, and open questions once they have content', () => {
    const doc = contentOkDoc();
    doc.agreed = ['flow', 'group:CD pipeline'];
    doc.problem = 'Move CD to GitHub.';
    doc.lanes.ours = 'the flow shape';
    doc.pushback = ['this is a runbook, not a requirement'];
    doc.openQuestions = ['who owns the runner?'];
    const r = discoveryFinishedCheck(doc);
    expect(r.ok).toBe(false);
    expect(r.unagreed).toContain('the problem');
    expect(r.unagreed).toContain('the lanes');
    expect(r.unagreed).toContain("the list of things we don't accept as-is");
    expect(r.unagreed).toContain('the open questions');
  });

  it('a renamed group is not covered by its old mark', () => {
    const doc = contentOkDoc();
    doc.agreed = ['flow', 'group:Old name'];
    const r = discoveryFinishedCheck(doc);
    expect(r.ok).toBe(false);
    expect(r.unagreed).toContain('the group "CD pipeline"');
  });

  it('dep/mitigation items alone still do not complete a group', () => {
    const doc = emptyDiscoveryDoc();
    doc.flow = ['step 1'];
    doc.groups = [{ name: 'g', items: [
      { text: 'a', tags: ['dep'] }, { text: 'b', tags: ['mitigation'] },
    ] }];
    doc.agreed = ['flow', 'group:g'];
    expect(discoveryFinishedCheck(doc).ok).toBe(false); // no diff/risk/fact-or-option
  });
});

describe('renderDiscoveryMarkdown — pushback + agreed marks', () => {
  it('prints the pushback section only when non-empty, and marks agreed sections', () => {
    const doc = emptyDiscoveryDoc();
    doc.problem = 'Move CD to GitHub.';
    doc.flow = ['step 1'];
    doc.pushback = ['this bundles two features'];
    doc.agreed = ['problem', 'pushback'];
    const md = renderDiscoveryMarkdown(doc, { featureDisplayName: '**F** (#1)' });
    expect(md).toContain("## What we're solving · agreed ✓");
    expect(md).toContain("## What we don't accept as-is · agreed ✓");
    expect(md).toContain('- this bundles two features');
    expect(md).toContain('## The feature end-to-end\n'); // flow not agreed → no mark
    const empty = renderDiscoveryMarkdown(emptyDiscoveryDoc(), { featureDisplayName: 'F' });
    expect(empty).not.toContain("What we don't accept");
  });
});

describe('renderDiscoveryMarkdown', () => {
  it('renders headings, the flow as a numbered list, and tagged items', () => {
    const doc = emptyDiscoveryDoc();
    doc.problem = 'Move CD to GitHub.';
    doc.flow = ['dev merges PR', 'live in dev'];
    doc.groups = [{ name: 'How apps deploy', items: [
      { text: 'double the checkout servers', tags: ['diff', 'fact'] },
      { text: 'more Akuity cost', tags: ['risk'] },
    ] }];
    doc.demo = { status: 'scheduled', shape: 'pipeline', date: '2026-08-01' };
    const md = renderDiscoveryMarkdown(doc, { featureDisplayName: '**Declarative CD** (#100)' });
    expect(md).toContain('# Discovery: **Declarative CD** (#100)');
    expect(md).toContain('## What we\'re solving');
    expect(md).toContain('Move CD to GitHub.');
    expect(md).toContain('1. dev merges PR');
    expect(md).toContain('### How apps deploy');
    expect(md).toContain('double the checkout servers');
    expect(md).toContain('[diff, fact]');
    expect(md).toContain('scheduled');
  });
});

describe('discoveryDayStage', () => {
  const WORKDAYS = new Set([0, 1, 2, 3, 4]); // Sun-Thu
  it('none when there is no first session', () => {
    expect(discoveryDayStage({ firstSessionAt: null, now: new Date('2026-07-22T10:00:00Z') }).stage).toBe('none');
  });
  it('day 1 is ok', () => {
    // Sun 2026-07-19 .. same day
    const r = discoveryDayStage({ firstSessionAt: '2026-07-19T08:00:00Z', now: new Date('2026-07-19T15:00:00Z'), workdays: WORKDAYS });
    expect(r.workday).toBe(1);
    expect(r.stage).toBe('ok');
  });
  it('Fri + Sat do not count as working days', () => {
    // Sun 2026-07-19 (day1) .. through Sat 2026-07-25: working days are Sun,Mon,Tue,Wed,Thu = 5
    const r = discoveryDayStage({ firstSessionAt: '2026-07-19T08:00:00Z', now: new Date('2026-07-25T10:00:00Z'), workdays: WORKDAYS });
    expect(r.workday).toBe(5);
    expect(r.stage).toBe('overrun');
  });
  it('day 2 / day 3 / overrun stages', () => {
    // Sun(19)=1, Mon(20)=2, Tue(21)=3, Wed(22)=4
    expect(discoveryDayStage({ firstSessionAt: '2026-07-19T08:00:00Z', now: new Date('2026-07-20T10:00:00Z'), workdays: WORKDAYS }).stage).toBe('day2');
    expect(discoveryDayStage({ firstSessionAt: '2026-07-19T08:00:00Z', now: new Date('2026-07-21T10:00:00Z'), workdays: WORKDAYS }).stage).toBe('day3');
    expect(discoveryDayStage({ firstSessionAt: '2026-07-19T08:00:00Z', now: new Date('2026-07-22T10:00:00Z'), workdays: WORKDAYS }).stage).toBe('overrun');
  });
});

describe('discoveryDayNudge', () => {
  it('is quiet on none and ok, speaks from day2 on', () => {
    expect(discoveryDayNudge('none')).toBeNull();
    expect(discoveryDayNudge('ok')).toBeNull();
    expect(discoveryDayNudge('day2')).toMatch(/wrap/i);
    expect(discoveryDayNudge('day3')).toMatch(/extra day/i);
    expect(discoveryDayNudge('overrun')).toMatch(/ran past/i);
  });
});

describe('discoveryCloseBlockMessage', () => {
  it('never blocks a non-discovery story', () => {
    expect(discoveryCloseBlockMessage({
      isDiscoveryStory: false, folderPath: null, check: { ok: false, missing: ['x'], unagreed: [] },
    })).toBeNull();
  });
  it('blocks a discovery story with no folder to read', () => {
    const msg = discoveryCloseBlockMessage({
      isDiscoveryStory: true, folderPath: null,
      check: { ok: false, missing: ['a discovery doc (none found)'], unagreed: [] },
    });
    expect(msg).toMatch(/discovery/i);
  });
  it('blocks a discovery story whose doc is unfinished, listing the gaps', () => {
    const msg = discoveryCloseBlockMessage({
      isDiscoveryStory: true, folderPath: '/x', check: { ok: false, missing: ['an end-to-end flow'], unagreed: [] },
    });
    expect(msg).toContain('an end-to-end flow');
  });
  it('lets a finished discovery story close', () => {
    expect(discoveryCloseBlockMessage({
      isDiscoveryStory: true, folderPath: '/x', check: { ok: true, missing: [], unagreed: [] },
    })).toBeNull();
  });

  it('content gaps only: "still needs" shape, ends with "Fill it in, then close the story."', () => {
    const msg = discoveryCloseBlockMessage({
      isDiscoveryStory: true, folderPath: '/x',
      check: { ok: false, missing: ['an end-to-end flow'], unagreed: [] },
    });
    expect(msg).toBe("This discovery isn't finished yet — still needs: an end-to-end flow. Fill it in, then close the story.");
    expect(msg).toMatch(/Fill it in, then close the story\.$/);
  });

  it('agreement gaps only: starts "These parts aren\'t agreed yet:", mentions explaining to the user', () => {
    const msg = discoveryCloseBlockMessage({
      isDiscoveryStory: true, folderPath: '/x',
      check: { ok: false, missing: [], unagreed: ['the end-to-end flow', 'the lanes'] },
    });
    expect(msg).toMatch(/^These parts aren't agreed yet:/);
    expect(msg).toContain('Explain each one to the user');
    expect(msg).not.toContain('pushback');
  });

  it('mixed: both sentences present, content first, only one "close the story" at the end', () => {
    const msg = discoveryCloseBlockMessage({
      isDiscoveryStory: true, folderPath: '/x',
      check: { ok: false, missing: ['an end-to-end flow'], unagreed: ['the lanes'] },
    });
    expect(msg).toBe(
      "This discovery isn't finished yet — still needs: an end-to-end flow. "
      + "These parts aren't agreed yet: the lanes. Explain each one to the user in plain words, get their yes, then close the story.",
    );
    expect(msg!.indexOf('This discovery')).toBeLessThan(msg!.indexOf("These parts aren't agreed"));
    expect(msg!.match(/close the story/g)?.length).toBe(1);
  });
});

describe('discoveryNextStep', () => {
  it('is quiet while discovery is unfinished', () => {
    expect(discoveryNextStep({ finished: false, hasWalkthrough: false, hasDemoHtml: false })).toBeNull();
  });
  it('points to the walkthrough first once finished', () => {
    expect(discoveryNextStep({ finished: true, hasWalkthrough: false, hasDemoHtml: false })).toMatch(/walkthrough/i);
  });
  it('points to the demo once the walkthrough exists', () => {
    const msg = discoveryNextStep({ finished: true, hasWalkthrough: true, hasDemoHtml: false });
    expect(msg).toMatch(/demo/i);
    expect(msg).not.toMatch(/build the walkthrough/i);
  });
  it('points to review + close once both are built', () => {
    expect(discoveryNextStep({ finished: true, hasWalkthrough: true, hasDemoHtml: true })).toMatch(/close/i);
  });
});

describe('discoveryStartNudge', () => {
  it('quiet when discovery is finished', () => {
    expect(discoveryStartNudge({ hasDiscovery: true, finished: true })).toBeNull();
  });
  it('reminds when there is no discovery yet', () => {
    expect(discoveryStartNudge({ hasDiscovery: false, finished: false })).toMatch(/no finished discovery/i);
  });
  it('reminds when discovery exists but is not finished', () => {
    expect(discoveryStartNudge({ hasDiscovery: true, finished: false })).toMatch(/not finished/i);
  });
});

describe('discoveryDayLabel', () => {
  // The list used to build this string inline as `day ${workday} of 2`, which
  // read as "day 3 of 2" on the extra day and "day 5 of 2" past the end. One
  // helper now, so the label and the nudge can't disagree.
  it('counts up to the two-day target', () => {
    expect(discoveryDayLabel('ok', 1)).toBe('day 1 of 2');
    expect(discoveryDayLabel('day2', 2)).toBe('day 2 of 2');
  });

  it('names the third day as the extra one, not "3 of 2"', () => {
    expect(discoveryDayLabel('day3', 3)).toBe('day 3 — the extra day');
  });

  it('says plainly when it has run past the three days', () => {
    expect(discoveryDayLabel('overrun', 6)).toBe('past its 3 days');
  });

  it('has nothing to say when there is no discovery to count', () => {
    expect(discoveryDayLabel('none', 0)).toBeNull();
  });
});
