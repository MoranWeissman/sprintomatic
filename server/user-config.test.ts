import { describe, it, expect, beforeEach, vi } from 'vitest';

const h = vi.hoisted(() => ({ settings: new Map<string, string>() }));
vi.mock('./timers', () => ({ getSetting: (k: string) => h.settings.get(k) }));

import {
  configValue,
  daysOffLabel,
  getTentativeWeight,
  getWorkdayEndHour,
  getWorkdayHours,
  getWorkdayStartHour,
  getWorkingDays,
  tentativeLabel,
  workdayWindowLabel,
  workingDaysLabel,
} from './user-config';

const ENV_KEYS = [
  'SPRINTOMATIC_WORKING_DAYS',
  'SPRINTOMATIC_WORKDAY_HOURS',
  'SPRINTOMATIC_WORKDAY_START_HOUR',
  'SPRINTOMATIC_WORKDAY_END_HOUR',
  'SPRINTOMATIC_TENTATIVE_WEIGHT',
];

beforeEach(() => {
  // vitest.setup.ts pins the week through the environment; clear it so these
  // tests see the real lookup order.
  for (const k of ENV_KEYS) delete process.env[k];
  h.settings.clear();
});

describe('configValue', () => {
  it('the environment wins over the stored setting', () => {
    process.env.SPRINTOMATIC_WORKDAY_HOURS = '7';
    h.settings.set('workday_hours', '8');
    expect(configValue('SPRINTOMATIC_WORKDAY_HOURS', 'workday_hours')).toBe('7');
  });

  it('a blank value counts as unset in both places', () => {
    process.env.SPRINTOMATIC_WORKDAY_HOURS = '  ';
    h.settings.set('workday_hours', '');
    expect(configValue('SPRINTOMATIC_WORKDAY_HOURS', 'workday_hours')).toBeUndefined();
  });
});

describe('defaults', () => {
  it('are a Mon-Fri office week when nothing is set', () => {
    expect([...getWorkingDays()].sort()).toEqual([1, 2, 3, 4, 5]);
    expect(getWorkdayHours()).toBe(9);
    expect(getWorkdayStartHour()).toBe(8);
    expect(getWorkdayEndHour()).toBe(18);
    expect(getTentativeWeight()).toBe(0);
  });
});

describe('getWorkingDays', () => {
  it('reads a comma list from the stored setting', () => {
    h.settings.set('working_days', '1,2,3,4,5,');
    expect([...getWorkingDays()].sort()).toEqual([1, 2, 3, 4, 5]);
  });

  it('drops numbers outside 0-6 and falls back when nothing is left', () => {
    h.settings.set('working_days', '7, x, -1');
    expect([...getWorkingDays()].sort()).toEqual([1, 2, 3, 4, 5]);
  });
});

describe('numbers that make no sense fall back to the default', () => {
  it('workday hours of 0 or over 24', () => {
    h.settings.set('workday_hours', '0');
    expect(getWorkdayHours()).toBe(9);
    h.settings.set('workday_hours', '25');
    expect(getWorkdayHours()).toBe(9);
  });

  it('an end hour at or before the start hour', () => {
    h.settings.set('workday_start_hour', '9');
    h.settings.set('workday_end_hour', '9');
    expect(getWorkdayEndHour()).toBe(18);
  });

  it('a tentative weight outside 0-1', () => {
    h.settings.set('tentative_weight', '2');
    expect(getTentativeWeight()).toBe(0);
  });
});

describe('labels', () => {
  it('a run of days reads as a range, other sets as a list', () => {
    expect(workingDaysLabel(new Set([0, 1, 2, 3, 4]))).toBe('Sun-Thu');
    expect(workingDaysLabel(new Set([1, 2, 3, 4, 5]))).toBe('Mon-Fri');
    expect(workingDaysLabel(new Set([1, 3, 5]))).toBe('Mon, Wed, Fri');
  });

  it('days off are the rest of the week', () => {
    expect(daysOffLabel(new Set([0, 1, 2, 3, 4]))).toBe('Fri and Sat');
    expect(daysOffLabel(new Set([1, 2, 3, 4]))).toBe('Sun, Fri and Sat');
  });

  it('the workday window, half hours included', () => {
    h.settings.set('workday_start_hour', '8.5');
    expect(workdayWindowLabel()).toBe('08:30-18:00');
  });

  it('tentative weight in words', () => {
    expect(tentativeLabel(0)).toBe('ignored entirely');
    expect(tentativeLabel(1)).toBe('counted in full');
    expect(tentativeLabel(0.5)).toBe('counted at 50%');
  });
});
