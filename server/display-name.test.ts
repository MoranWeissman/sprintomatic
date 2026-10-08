import { describe, it, expect } from 'vitest';
import { displayNameFor } from './display-name';

describe('displayNameFor', () => {
  it('puts the title in bold first, then the id in brackets', () => {
    expect(displayNameFor(100001, 'Deploy the checkout service')).toBe('**Deploy the checkout service** (#100001)');
  });

  it('accepts an id that arrives as a string', () => {
    expect(displayNameFor('100002', 'Fix login')).toBe('**Fix login** (#100002)');
  });

  it('drops the name and shows the bare id when the title is missing', () => {
    expect(displayNameFor(100003, null)).toBe('#100003');
    expect(displayNameFor(100003, undefined)).toBe('#100003');
  });

  it('drops the name and shows the bare id when the title is an empty string', () => {
    expect(displayNameFor(100004, '')).toBe('#100004');
  });

  it('drops the name and shows the bare id when the title is only spaces', () => {
    expect(displayNameFor(100005, '   ')).toBe('#100005');
    expect(displayNameFor(100005, '\t\n ')).toBe('#100005');
  });

  it('trims padding around the title so the bold markers still work', () => {
    expect(displayNameFor(100006, '  Fix login  ')).toBe('**Fix login** (#100006)');
  });

  it('keeps the name and drops the brackets when the id is missing', () => {
    expect(displayNameFor(null, 'Fix login')).toBe('**Fix login**');
    expect(displayNameFor(undefined, 'Fix login')).toBe('**Fix login**');
    expect(displayNameFor('', 'Fix login')).toBe('**Fix login**');
  });

  it('returns an empty string when neither the title nor the id is known', () => {
    expect(displayNameFor(null, null)).toBe('');
  });

  it('leaves a title that already has brackets or a hash exactly as it is', () => {
    expect(displayNameFor(100007, 'Rollout (phase 2)')).toBe('**Rollout (phase 2)** (#100007)');
    expect(displayNameFor(100008, 'Follow up on #100001')).toBe(
      '**Follow up on #100001** (#100008)',
    );
  });

  it('leaves markdown characters in the title exactly as the board has them', () => {
    // The board is the source of truth for the title. Escaping or stripping a
    // star would show the user a name their board does not have, so the title
    // goes out verbatim even when the stars render oddly.
    expect(displayNameFor(100009, 'Star * in the middle')).toBe(
      '**Star * in the middle** (#100009)',
    );
    expect(displayNameFor(100010, '_underscored_')).toBe('**_underscored_** (#100010)');
  });
});
