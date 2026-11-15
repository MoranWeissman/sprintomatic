import { describe, expect, it } from 'vitest';
import { fmtSpent, parseHours, undoDoubleEscape, unusualMeta } from './drawerBits';

describe('parseHours', () => {
  it('reads a plain or comma number', () => {
    expect(parseHours('3')).toBe(3);
    expect(parseHours(' 1,5 ')).toBe(1.5);
  });
  it('refuses empty, zero, negative, huge and words', () => {
    for (const bad of ['', '0', '-2', '1000', 'two']) expect(parseHours(bad)).toBeNull();
  });
});

describe('undoDoubleEscape', () => {
  it('turns &amp;lt; back into &lt;, so the page shows <env>', () => {
    expect(undoDoubleEscape('<code>&amp;lt;env&amp;gt;</code>')).toBe('<code>&lt;env&gt;</code>');
  });
  it('leaves single escapes and plain ampersands alone', () => {
    expect(undoDoubleEscape('a &lt;b&gt; &amp; c')).toBe('a &lt;b&gt; &amp; c');
  });
  it('never makes a real tag', () => {
    expect(undoDoubleEscape('&amp;lt;script&amp;gt;')).not.toContain('<script');
  });
});

describe('unusualMeta', () => {
  const base = {
    assignedTo: 'Sam Example',
    createdBy: 'Sam Example',
    areaPath: 'Proj\\Team',
    iterationPath: 'Proj\\Sprint 1',
    priority: 2,
  };
  it('hides everything when it is all the usual', () => {
    expect(unusualMeta(base)).toEqual({});
  });
  it('shows someone else, nobody, another project and a non-default priority', () => {
    expect(unusualMeta({ ...base, assignedTo: 'Alex Example' }).assignedTo).toBe('Alex Example');
    expect(unusualMeta({ ...base, assignedTo: undefined }).assignedTo).toBe('nobody');
    expect(unusualMeta({ ...base, areaPath: 'Other\\Team' }).area).toBe('Team');
    expect(unusualMeta({ ...base, priority: 1 }).priority).toBe(1);
  });
});

describe('fmtSpent', () => {
  it('reads hours and minutes', () => {
    expect(fmtSpent(0)).toBe('0h');
    expect(fmtSpent(45 * 60)).toBe('45m');
    expect(fmtSpent(7 * 3600 + 2 * 60)).toBe('7h 02m');
    expect(fmtSpent(3 * 3600)).toBe('3h');
  });
});
