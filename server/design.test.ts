// server/design.test.ts
import { describe, it, expect } from 'vitest';
import { parseDesignDoc, emptyDesignDoc, designAgreementCheck, isDesignStoryTitle, designGate, designGateMessage, renderDesignMarkdown, designProblems, droppedByParse } from './design';

function agreedDoc() {
  const d = emptyDesignDoc();
  d.approach = { lines: ['build a reusable workflow'], diagram: 'architecture.svg' };
  d.flows = [{ name: 'Deploy flow', steps: ['merge', 'deploy'], diagram: '' }];
  d.stories = [
    { title: 'Reusable deploy workflow', covers: 'the shared workflow', estimateHours: 16, why: 'touches the KCL risk from discovery' },
    { title: 'Rollback story', covers: 'auto rollback', estimateHours: 8, why: 'plain work, no risks touched' },
  ];
  d.plan = [{ step: 'workflow first', stories: ['Reusable deploy workflow'], note: '' }];
  d.decisions = [{ question: 'one app or two?', choice: '', decidedInMeeting: '' }];
  d.agreed = ['approach', 'flows', 'plan', 'decisions', 'story:Reusable deploy workflow', 'story:Rollback story'];
  return d;
}

describe('parseDesignDoc', () => {
  it('returns null for unset/garbage input', () => {
    expect(parseDesignDoc(null)).toBeNull();
    expect(parseDesignDoc('not json {')).toBeNull();
    expect(parseDesignDoc('[]')).toBeNull();
  });
  it('parses a full doc and keeps its fields', () => {
    const parsed = parseDesignDoc(JSON.stringify(agreedDoc()));
    expect(parsed!.stories).toHaveLength(2);
    expect(parsed!.stories[0].estimateHours).toBe(16);
    expect(parsed!.approach.diagram).toBe('architecture.svg');
    expect(parsed!.agreed).toContain('story:Rollback story');
  });
  it('defaults every missing field to a safe empty', () => {
    const p = parseDesignDoc('{}')!;
    expect(p.approach).toEqual({ lines: [], diagram: '' });
    expect(p.flows).toEqual([]);
    expect(p.stories).toEqual([]);
    expect(p.plan).toEqual([]);
    expect(p.decisions).toEqual([]);
    expect(p.review).toEqual({ status: 'none', date: '' });
    expect(p.pushed).toEqual({ at: '', storyIds: [] });
    expect(p.agreed).toEqual([]);
  });
  it('keeps stories with unusable hours as 0h; drops the truly malformed', () => {
    const p = parseDesignDoc(JSON.stringify({ stories: [
      { title: 'ok', covers: 'c', estimateHours: 4, why: 'w' },
      { title: 'bad hours', covers: 'c', estimateHours: 'six', why: 'w' },
      'garbage',
    ] }))!;
    expect(p.stories).toHaveLength(2);
    expect(p.stories[0].title).toBe('ok');
    expect(p.stories[1]).toEqual({ title: 'bad hours', covers: 'c', estimateHours: 0, why: 'w' });
  });
});

describe('designAgreementCheck', () => {
  it('passes when every non-empty part and every story is agreed', () => {
    const r = designAgreementCheck(agreedDoc());
    expect(r.ok).toBe(true);
    expect(r.unagreed).toEqual([]);
  });
  it('lists unagreed parts and stories with plain labels', () => {
    const d = agreedDoc();
    d.agreed = ['approach'];
    const r = designAgreementCheck(d);
    expect(r.ok).toBe(false);
    expect(r.unagreed).toContain('the flows');
    expect(r.unagreed).toContain('the working plan');
    expect(r.unagreed).toContain('the open decisions');
    expect(r.unagreed).toContain('the story "Reusable deploy workflow"');
  });
  it('empty parts need no mark', () => {
    const d = emptyDesignDoc();
    expect(designAgreementCheck(d).ok).toBe(true);
  });
  it('a retitled story is not covered by its old mark', () => {
    const d = agreedDoc();
    d.stories[1].title = 'Rollback story v2';
    const r = designAgreementCheck(d);
    expect(r.unagreed).toContain('the story "Rollback story v2"');
  });
});

describe('isDesignStoryTitle', () => {
  it('matches titles that start with design', () => {
    expect(isDesignStoryTitle('Design: CD pipeline')).toBe(true);
    expect(isDesignStoryTitle('  design work')).toBe(true);
    expect(isDesignStoryTitle('Redesign the flow')).toBe(false);
  });
});

describe('designGateMessage — names only the FIRST unmet gate', () => {
  it('null for non-design stories and for a fully done design', () => {
    expect(designGateMessage({ isDesignStory: false, doc: null, meetingCount: 0 })).toBeNull();
    const d = agreedDoc();
    d.review = { status: 'done', date: '2026-08-02' };
    d.pushed = { at: '2026-08-02T10:00:00Z', storyIds: [1, 2] };
    expect(designGateMessage({ isDesignStory: true, doc: d, meetingCount: 1 })).toBeNull();
  });
  it('gate 1: unagreed parts block first, listing them', () => {
    const d = agreedDoc();
    d.agreed = [];
    const msg = designGateMessage({ isDesignStory: true, doc: d, meetingCount: 0 })!;
    expect(msg).toContain("aren't agreed yet");
    expect(msg).toContain('the approach');
    expect(msg).toContain('Explain each one to the user in plain words');
    expect(msg).not.toContain('review');
  });
  it('gate 2: agreed but not reviewed', () => {
    const msg = designGateMessage({ isDesignStory: true, doc: agreedDoc(), meetingCount: 0 })!;
    expect(msg).toContain('design review');
    expect(msg).not.toContain('push');
  });
  it('review status done without a recorded meeting still blocks at gate 2', () => {
    const d = agreedDoc();
    d.review = { status: 'done', date: '2026-08-02' };
    const msg = designGateMessage({ isDesignStory: true, doc: d, meetingCount: 0 })!;
    expect(msg).toContain('design review');
  });
  it('gate 3: agreed + reviewed but not pushed', () => {
    const d = agreedDoc();
    d.review = { status: 'done', date: '2026-08-02' };
    const msg = designGateMessage({ isDesignStory: true, doc: d, meetingCount: 1 })!;
    expect(msg).toContain('push');
  });
  it('a missing doc blocks with a plain start message', () => {
    const msg = designGateMessage({ isDesignStory: true, doc: null, meetingCount: 0 })!;
    expect(msg).toContain('no design');
  });
});

describe('designGate — structured step', () => {
  it('a story titled with the word push does not fool the agree gate', () => {
    const d = emptyDesignDoc();
    d.stories = [{ title: 'Add push notifications', covers: 'c', estimateHours: 4, why: 'w' }];
    const g = designGate({ isDesignStory: true, doc: d, meetingCount: 0 });
    expect(g.step).toBe('agree');
    expect(g.message).toContain('the story "Add push notifications"');
  });
  it('steps walk start → agree → review → push → none', () => {
    expect(designGate({ isDesignStory: true, doc: null, meetingCount: 0 }).step).toBe('start');
    const d = emptyDesignDoc();
    d.stories = [{ title: 'S', covers: 'c', estimateHours: 4, why: 'w' }];
    expect(designGate({ isDesignStory: true, doc: d, meetingCount: 0 }).step).toBe('agree');
    d.agreed = ['story:S'];
    expect(designGate({ isDesignStory: true, doc: d, meetingCount: 0 }).step).toBe('review');
    d.review = { status: 'done', date: '2026-08-02' };
    expect(designGate({ isDesignStory: true, doc: d, meetingCount: 1 }).step).toBe('push');
    d.pushed = { at: 'x', storyIds: [1] };
    expect(designGate({ isDesignStory: true, doc: d, meetingCount: 1 }).step).toBe('none');
  });
});

describe('renderDesignMarkdown', () => {
  it('renders all parts with agreed marks and hours', () => {
    const d = agreedDoc();
    const md = renderDesignMarkdown(d, { featureDisplayName: '**F** (#1)' });
    expect(md).toContain('## The approach · agreed ✓');
    expect(md).toContain('Reusable deploy workflow');
    expect(md).toContain('16h');
    expect(md).toContain('## The working plan · agreed ✓');
    expect(md).toContain('not decided yet');
  });
});

describe('boardDescription — the text the board shows', () => {
  it('parses it when the story has one, and leaves it undefined when it does not', () => {
    const p = parseDesignDoc(JSON.stringify({ stories: [
      { title: 'with board text', covers: 'c', estimateHours: 4, why: 'w', boardDescription: 'Given a push\nWhen it lands\nThen it deploys' },
      { title: 'without', covers: 'c', estimateHours: 4, why: 'w' },
      { title: 'empty string', covers: 'c', estimateHours: 4, why: 'w', boardDescription: '' },
    ] }))!;
    expect(p.stories[0].boardDescription).toBe('Given a push\nWhen it lands\nThen it deploys');
    expect(p.stories[1].boardDescription).toBeUndefined();
    expect(p.stories[2].boardDescription).toBeUndefined();
  });

  it('shows "On the board:" in the markdown only when a story has one', () => {
    const d = agreedDoc();
    d.stories[0].boardDescription = 'Given a push, When it lands, Then it deploys';
    const md = renderDesignMarkdown(d, { featureDisplayName: '**F** (#1)' });
    expect(md).toContain('_On the board:_');
    expect(md).toContain('Given a push, When it lands, Then it deploys');
    const none = renderDesignMarkdown(agreedDoc(), { featureDisplayName: '**F** (#1)' });
    expect(none).not.toContain('_On the board:_');
  });
});

describe('outOfScope — the "not in this design" list', () => {
  it('parses the list; missing field stays an empty list (old files valid)', () => {
    const withIt = parseDesignDoc(JSON.stringify({ outOfScope: ['helm chart layout', 7, 'app configuration'] }));
    expect(withIt?.outOfScope).toEqual(['helm chart layout', 'app configuration']);
    const without = parseDesignDoc(JSON.stringify({ approach: { lines: ['x'] } }));
    expect(without?.outOfScope).toEqual([]);
  });

  it('a non-empty list needs its agreed key; empty needs nothing', () => {
    const d = agreedDoc();
    d.outOfScope = ['helm chart layout'];
    const missing = designAgreementCheck(d);
    expect(missing.ok).toBe(false);
    expect(missing.unagreed).toContain('the "not in this design" list');
    d.agreed.push('outOfScope');
    expect(designAgreementCheck(d).ok).toBe(true);
    const empty = agreedDoc();
    expect(designAgreementCheck(empty).ok).toBe(true);
  });

  it('renders its own markdown section, marked when agreed', () => {
    const d = agreedDoc();
    d.outOfScope = ['helm chart layout'];
    d.agreed.push('outOfScope');
    const md = renderDesignMarkdown(d, { featureDisplayName: '**F** (#1)' });
    expect(md).toContain('## Not in this design · agreed ✓');
    expect(md).toContain('- helm chart layout');
    const none = renderDesignMarkdown(agreedDoc(), { featureDisplayName: '**F** (#1)' });
    expect(none).toContain('_(nothing cut)_');
  });
});

describe('designProblems', () => {
  it('finds nothing wrong with a clean design', () => {
    const d = agreedDoc();
    d.stories.forEach(s => { s.estimateHours = 8; });
    expect(designProblems(d, ['architecture.svg'])).toEqual([]);
  });

  it('names a picture that is in the design but not on disk', () => {
    const d = agreedDoc();
    d.flows[0].diagram = 'deploy-flow.svg';
    const p = designProblems(d, ['architecture.svg']);
    expect(p).toHaveLength(1);
    expect(p[0]).toContain('deploy-flow.svg');
    expect(p[0]).toContain('The flow "Deploy flow"');
  });

  it('says nothing about a part with no picture named', () => {
    const d = agreedDoc();
    d.approach.diagram = '';
    d.flows[0].diagram = '';
    expect(designProblems(d, [])).toEqual([]);
  });

  it('catches a colour standing in for a state, and says where', () => {
    const d = agreedDoc();
    d.flows[0].steps = ['deploy', 'wait until everything is green'];
    const p = designProblems(d, ['architecture.svg']);
    expect(p).toHaveLength(1);
    expect(p[0]).toContain('say passed or failed');
    expect(p[0]).toContain('the flow "Deploy flow"');
  });

  it('leaves an honest use of a colour alone', () => {
    const d = agreedDoc();
    d.approach.lines = ['the green card shows what an option buys'];
    expect(designProblems(d, ['architecture.svg'])).toEqual([]);
  });

  it('flags a story with no hours', () => {
    const d = agreedDoc();
    d.stories[1].estimateHours = 0;
    const p = designProblems(d, ['architecture.svg']);
    expect(p).toHaveLength(1);
    expect(p[0]).toContain('"Rollback story" has no hours');
  });

  it('flags an agreed mark left behind when a story was retitled', () => {
    const d = agreedDoc();
    d.stories[1].title = 'Auto version PR to dev';
    const p = designProblems(d, ['architecture.svg']);
    expect(p.some(x => x.includes('"Rollback story"') && x.includes('fresh yes'))).toBe(true);
  });
});

describe('droppedByParse', () => {
  it('says nothing when every entry survived', () => {
    const raw = JSON.stringify(agreedDoc());
    expect(droppedByParse(raw, parseDesignDoc(raw)!)).toEqual([]);
  });

  it('reports decisions the reader had to skip', () => {
    const d = agreedDoc();
    const raw = JSON.stringify({ ...d, decisions: [d.decisions[0], 'oops', 42] });
    const p = droppedByParse(raw, parseDesignDoc(raw)!);
    expect(p).toHaveLength(1);
    expect(p[0]).toContain('2 of the 3 decisions');
  });

  it('reports a story dropped for having no title', () => {
    const d = agreedDoc();
    const raw = JSON.stringify({ ...d, stories: [...d.stories, { covers: 'no title here' }] });
    const p = droppedByParse(raw, parseDesignDoc(raw)!);
    expect(p[0]).toContain('1 of the 3 stories');
  });

  it('says nothing when the file is not JSON at all', () => {
    expect(droppedByParse('{not json', emptyDesignDoc())).toEqual([]);
  });
});

describe('the free note at the top', () => {
  it('is empty on a fresh design and reads back what was written', () => {
    expect(emptyDesignDoc().note).toBe('');
    expect(parseDesignDoc('{"note":"Reworked 2026-08-04."}')!.note).toBe('Reworked 2026-08-04.');
    expect(parseDesignDoc('{"note":42}')!.note).toBe('');
  });

  it('renders as a quote block under the title, keeping its blank lines', () => {
    const d = emptyDesignDoc();
    d.note = 'Working draft.\n\nReworked 2026-08-04 — earlier yes-marks are off.';
    const md = renderDesignMarkdown(d, { featureDisplayName: '**F** (#1)' });
    expect(md).toContain('> Working draft.');
    expect(md).toContain('> Reworked 2026-08-04 — earlier yes-marks are off.');
    expect(md.indexOf('> Working draft.')).toBeLessThan(md.indexOf('## The approach'));
  });

  it('adds nothing when there is no note', () => {
    expect(renderDesignMarkdown(emptyDesignDoc(), { featureDisplayName: '**F** (#1)' })).not.toContain('\n> ');
  });
});
