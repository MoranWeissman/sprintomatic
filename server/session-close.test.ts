import { describe, expect, it } from 'vitest';
import { catchUpLogRequired } from './session-close';

const THRESHOLD = 45;

describe('catchUpLogRequired', () => {
  it('requires a log when the session ran long with no substantive log', () => {
    expect(
      catchUpLogRequired({ minutesOpen: 60, hadSubstantiveLog: false, thresholdMinutes: THRESHOLD }),
    ).toBe(true);
  });

  it('does not require a log when a substantive log already exists', () => {
    expect(
      catchUpLogRequired({ minutesOpen: 60, hadSubstantiveLog: true, thresholdMinutes: THRESHOLD }),
    ).toBe(false);
  });

  it('does not require a log for a short session with no log', () => {
    expect(
      catchUpLogRequired({ minutesOpen: 10, hadSubstantiveLog: false, thresholdMinutes: THRESHOLD }),
    ).toBe(false);
  });

  it('requires a log exactly at the threshold', () => {
    expect(
      catchUpLogRequired({ minutesOpen: 45, hadSubstantiveLog: false, thresholdMinutes: THRESHOLD }),
    ).toBe(true);
  });
});
