import { describe, it, expect, beforeEach, vi } from 'vitest';

const h = vi.hoisted(() => ({ settings: new Map<string, string>() }));
vi.mock('./timers', () => ({
  getSetting: (k: string) => h.settings.get(k),
  setSetting: (k: string, v: string) => void h.settings.set(k, v),
}));

import { listSettings, parseWorkingDays, saveSettings, SettingError } from './settings-registry';
import { getPages } from './user-config';

const ENV_KEYS = [
  'SPRINTOMATIC_WORKING_DAYS', 'SPRINTOMATIC_WORKDAY_HOURS', 'SPRINTOMATIC_WORKDAY_START_HOUR', 'SPRINTOMATIC_WORKDAY_END_HOUR',
  'SPRINTOMATIC_TENTATIVE_WEIGHT', 'SPRINTOMATIC_ADO_ACCESS_MODE', 'SPRINTOMATIC_ADO_ORG', 'SPRINTOMATIC_ADO_PAT', 'SPRINTOMATIC_ADO_TEAM',
  'SPRINTOMATIC_USE_DISCOVERY', 'SPRINTOMATIC_USE_DESIGN',
];

beforeEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
  h.settings.clear();
});

const view = (key: string) => listSettings().find(s => s.key === key)!;

describe('parseWorkingDays', () => {
  it('reads ranges, lists, full names and numbers', () => {
    expect(parseWorkingDays('Mon-Fri')).toBe('1,2,3,4,5');
    expect(parseWorkingDays('sun-thu')).toBe('0,1,2,3,4');
    expect(parseWorkingDays('Monday, Wednesday, fri')).toBe('1,3,5');
    expect(parseWorkingDays('1,2,3,4,5')).toBe('1,2,3,4,5');
  });

  it('wraps a range past Saturday', () => {
    expect(parseWorkingDays('Sat-Mon')).toBe('0,1,6');
  });

  it('gives up on anything it cannot read', () => {
    expect(parseWorkingDays('')).toBeNull();
    expect(parseWorkingDays('weekdays')).toBeNull();
    expect(parseWorkingDays('7')).toBeNull();
  });
});

describe('listSettings', () => {
  it('says where each value comes from', () => {
    h.settings.set('workday_hours', '8');
    process.env.SPRINTOMATIC_ADO_ORG = 'https://dev.azure.com/from-env';
    expect(view('workday_hours')).toMatchObject({ value: '8', source: 'setting', locked: false });
    expect(view('ado_org')).toMatchObject({ value: 'https://dev.azure.com/from-env', source: 'env', locked: true });
    expect(view('ado_project')).toMatchObject({ value: null, source: 'default' });
  });

  it('never sends the token out, only where it is kept', () => {
    h.settings.set('ado_pat', 'a'.repeat(52));
    expect(view('ado_pat')).toMatchObject({ value: null, source: 'setting' });
  });
});

describe('saveSettings', () => {
  it('stores the cleaned form of what was typed', () => {
    saveSettings({ working_days: 'Mon-Fri', workday_start_hour: '08:30', ado_org: 'https://dev.azure.com/x/' });
    expect(h.settings.get('working_days')).toBe('1,2,3,4,5');
    expect(h.settings.get('workday_start_hour')).toBe('8.5');
    expect(h.settings.get('ado_org')).toBe('https://dev.azure.com/x');
  });

  it('a blank value clears the setting', () => {
    h.settings.set('ado_team', 'Team One');
    saveSettings({ ado_team: '  ' });
    expect(h.settings.get('ado_team')).toBe('');
  });

  it('refuses a value the reader would ignore, and writes nothing else', () => {
    expect(() => saveSettings({ workday_hours: '7', working_days: 'Mon-Fri', workday_end_hour: '30' }))
      .toThrow(SettingError);
    expect(h.settings.size).toBe(0);
  });

  it('checks the end of the day against the new start in the same save', () => {
    expect(() => saveSettings({ workday_start_hour: '10', workday_end_hour: '09:00' })).toThrow(/end after it starts/);
    saveSettings({ workday_start_hour: '7', workday_end_hour: '16' });
    expect(h.settings.get('workday_end_hour')).toBe('16');
  });

  it('refuses to change a value an environment variable forces', () => {
    process.env.SPRINTOMATIC_ADO_TEAM = 'Env Team';
    expect(() => saveSettings({ ado_team: 'Other Team' })).toThrow(/SPRINTOMATIC_ADO_TEAM/);
    // Sending the forced value back unchanged is fine — the screen sends the whole form.
    expect(() => saveSettings({ ado_team: 'Env Team' })).not.toThrow();
    expect(h.settings.has('ado_team')).toBe(false);
  });

  it('a blank token keeps the one already saved', () => {
    h.settings.set('ado_pat', 'b'.repeat(52));
    saveSettings({ ado_pat: '' });
    expect(h.settings.get('ado_pat')).toBe('b'.repeat(52));
  });

  it('saves a new token (to the settings file when there is no Keychain)', () => {
    saveSettings({ ado_pat: 'c'.repeat(52) });
    expect(h.settings.get('ado_pat')).toBe('c'.repeat(52));
  });

  it('refuses a token that is clearly a paste mistake', () => {
    expect(() => saveSettings({ ado_pat: 'not a token' })).toThrow(/doesn't look like a token/);
  });

  it('refuses a setting it does not know', () => {
    expect(() => saveSettings({ state_done: 'Closed' })).toThrow(/no setting called/);
  });
});

describe('the Discovery and Design switches', () => {
  it('are both off for a new install', () => {
    expect(view('use_discovery').value).toBeNull();
    expect(view('use_discovery').defaultValue).toBe('off');
    expect(getPages()).toEqual({ discovery: false, design: false });
  });

  it('turn on one at a time', () => {
    saveSettings({ use_design: 'On' });
    expect(getPages()).toEqual({ discovery: false, design: true });
  });

  it('refuse anything but on or off', () => {
    expect(() => saveSettings({ use_discovery: 'yes' })).toThrow(SettingError);
  });
});
