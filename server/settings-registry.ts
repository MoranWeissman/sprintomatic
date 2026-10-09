/**
 * Every setting a person is meant to change, in one list: what it is called,
 * which environment variable can force it, what a good value looks like.
 *
 * The settings screen and `npm run setup` both work from this list, so they
 * can't disagree about what is allowed. The code that USES each value still
 * reads it through ./user-config, ./config and ./ado-client — this file only
 * shows and saves.
 *
 * The checks here match the readers: a value the reader would quietly ignore
 * is refused here with a reason instead, so a save never "works" and then
 * does nothing.
 */
import { getSetting, setSetting } from './timers';
import {
  DAY_NAMES,
  DEFAULT_TENTATIVE_WEIGHT,
  DEFAULT_WORKDAY_END_HOUR,
  DEFAULT_WORKDAY_HOURS,
  DEFAULT_WORKDAY_START_HOUR,
  DEFAULT_WORKING_DAYS,
  configValue,
  hourLabel,
  tentativeLabel,
  workingDaysLabel,
} from './user-config';
import { DEFAULT_MAX_PARALLEL_SESSIONS } from './session-cap';
import { keychainAvailable, readToken, saveToken } from './secrets';

export type SettingGroup = 'week' | 'board' | 'pages' | 'other';
export type SettingKind = 'days' | 'hour' | 'number' | 'text' | 'choice' | 'secret';

interface SettingDef {
  key: string;
  env: string;
  group: SettingGroup;
  label: string;
  help: string;
  kind: SettingKind;
  choices?: { value: string; label: string }[];
  /** What you get when nothing is set, in words. */
  defaultLabel: string;
  /** The same in stored form, when there is one (the screen starts from it). */
  defaultValue?: string;
  /** Turn what was typed into the stored form, or throw with a plain reason. */
  clean?: (raw: string, next: (key: string) => string | undefined) => string;
}

export interface SettingView {
  key: string;
  env: string;
  group: SettingGroup;
  label: string;
  help: string;
  kind: SettingKind;
  choices?: { value: string; label: string }[];
  defaultLabel: string;
  defaultValue?: string;
  /** The value in use. Always null for the token — it is never sent out. */
  value: string | null;
  /** Where the value in use comes from. */
  source: 'env' | 'setting' | 'default' | 'keychain';
  /** True when an environment variable forces it; the screen can't change it. */
  locked: boolean;
}

/** A save that was refused. `key` says which field to point at. */
export class SettingError extends Error {
  constructor(readonly key: string, message: string) {
    super(message);
    this.name = 'SettingError';
  }
}

/**
 * Read a working week typed by a person: "Mon-Fri", "sun-thu", "mon, wed, fri"
 * or "1,2,3,4,5". Returns the stored form ("1,2,3,4,5"), or null when it can't
 * make sense of it.
 */
export function parseWorkingDays(raw: string): string | null {
  const dayNumber = (word: string): number | null => {
    const w = word.trim().toLowerCase();
    if (/^[0-6]$/.test(w)) return Number(w);
    // "mon", "Monday" and "tues" all start with a three-letter day name.
    const i = DAY_NAMES.findIndex(d => w.startsWith(d.toLowerCase()));
    return i >= 0 ? i : null;
  };
  const days = new Set<number>();
  for (const part of raw.split(',').map(p => p.trim()).filter(Boolean)) {
    const range = part.split('-');
    if (range.length === 2) {
      const from = dayNumber(range[0]);
      const to = dayNumber(range[1]);
      if (from == null || to == null) return null;
      // A range can wrap past Saturday, e.g. "Sat-Wed".
      for (let d = from; ; d = (d + 1) % 7) {
        days.add(d);
        if (d === to) break;
      }
    } else if (range.length === 1) {
      const d = dayNumber(part);
      if (d == null) return null;
      days.add(d);
    } else {
      return null;
    }
  }
  if (days.size === 0) return null;
  return [...days].sort((a, b) => a - b).join(',');
}

/** "8", "8.5" or "08:30" → "8.5". */
function parseHour(raw: string): number | null {
  const t = raw.trim();
  const clock = t.match(/^(\d{1,2}):(\d{2})$/);
  const n = clock ? Number(clock[1]) + Number(clock[2]) / 60 : Number(t);
  return Number.isFinite(n) ? n : null;
}

function numberBetween(key: string, raw: string, ok: (n: number) => boolean, why: string): string {
  const n = Number(raw.trim());
  if (!Number.isFinite(n) || !ok(n)) throw new SettingError(key, why);
  return String(n);
}

function onOff(key: string, raw: string): string {
  const v = raw.trim().toLowerCase();
  if (v === 'on' || v === 'off') return v;
  throw new SettingError(key, 'Pick on or off.');
}

const DEFS: SettingDef[] = [
  // ---- the week ----
  {
    key: 'working_days', env: 'SH_WORKING_DAYS', group: 'week', kind: 'days',
    label: 'Working days',
    help: 'The days you work. Capacity, the Daily and the sprint strip all count only these.',
    defaultLabel: workingDaysLabel(DEFAULT_WORKING_DAYS),
    defaultValue: [...DEFAULT_WORKING_DAYS].sort((a, b) => a - b).join(','),
    clean: raw => {
      const days = parseWorkingDays(raw);
      if (!days) throw new SettingError('working_days', 'Pick at least one day, like "Mon-Fri" or "Sun-Thu".');
      return days;
    },
  },
  {
    key: 'workday_hours', env: 'SH_WORKDAY_HOURS', group: 'week', kind: 'number',
    label: 'Hours in a workday',
    help: 'How long a normal day is. One story point counts as one of these days.',
    defaultLabel: String(DEFAULT_WORKDAY_HOURS),
    defaultValue: String(DEFAULT_WORKDAY_HOURS),
    clean: raw => numberBetween('workday_hours', raw, n => n > 0 && n <= 24, 'A workday is more than 0 and at most 24 hours.'),
  },
  {
    key: 'workday_start_hour', env: 'SH_WORKDAY_START_HOUR', group: 'week', kind: 'hour',
    label: 'Day starts at',
    help: 'Meetings before this time don\'t take away from your desk time.',
    defaultLabel: hourLabel(DEFAULT_WORKDAY_START_HOUR),
    defaultValue: String(DEFAULT_WORKDAY_START_HOUR),
    clean: raw => {
      const n = parseHour(raw);
      if (n == null || n < 0 || n >= 24) throw new SettingError('workday_start_hour', 'Use a time like 08:00.');
      return String(n);
    },
  },
  {
    key: 'workday_end_hour', env: 'SH_WORKDAY_END_HOUR', group: 'week', kind: 'hour',
    label: 'Day ends at',
    help: 'Meetings after this time don\'t take away from your desk time.',
    defaultLabel: hourLabel(DEFAULT_WORKDAY_END_HOUR),
    defaultValue: String(DEFAULT_WORKDAY_END_HOUR),
    clean: (raw, next) => {
      const n = parseHour(raw);
      if (n == null || n <= 0 || n > 24) throw new SettingError('workday_end_hour', 'Use a time like 18:00.');
      const start = Number(next('workday_start_hour') ?? DEFAULT_WORKDAY_START_HOUR);
      if (n <= start) throw new SettingError('workday_end_hour', 'The day has to end after it starts.');
      return String(n);
    },
  },
  {
    key: 'tentative_weight', env: 'SH_TENTATIVE_WEIGHT', group: 'week', kind: 'choice',
    label: 'Meetings you said "maybe" to',
    help: 'How much a tentative meeting takes away from your desk time.',
    choices: [
      { value: '0', label: 'Ignore them' },
      { value: '0.5', label: 'Count half' },
      { value: '1', label: 'Count in full' },
    ],
    defaultLabel: tentativeLabel(DEFAULT_TENTATIVE_WEIGHT),
    defaultValue: String(DEFAULT_TENTATIVE_WEIGHT),
    clean: raw => numberBetween('tentative_weight', raw, n => n >= 0 && n <= 1, 'Use a number from 0 (ignore) to 1 (count in full).'),
  },

  // ---- the board ----
  {
    key: 'ado_access_mode', env: 'SH_ADO_ACCESS_MODE', group: 'board', kind: 'choice',
    label: 'How to reach the board',
    help: 'The az command uses your existing az login. A token works without the Azure CLI.',
    choices: [
      { value: 'cli', label: 'The az command' },
      { value: 'api', label: 'A personal access token' },
    ],
    defaultLabel: 'The az command',
    defaultValue: 'cli',
    clean: raw => {
      const v = raw.trim().toLowerCase();
      if (v !== 'cli' && v !== 'api') throw new SettingError('ado_access_mode', 'Pick the az command or a token.');
      return v;
    },
  },
  {
    key: 'ado_org', env: 'SH_ADO_ORG', group: 'board', kind: 'text',
    label: 'Organization',
    help: 'The address of your Azure DevOps organization.',
    defaultLabel: 'what az devops configure has',
    clean: raw => {
      const v = raw.trim().replace(/\/+$/, '');
      if (!/^https:\/\/\S+$/.test(v)) throw new SettingError('ado_org', 'Use the full address, like https://dev.azure.com/your-org.');
      return v;
    },
  },
  {
    key: 'ado_project', env: 'SH_ADO_PROJECT', group: 'board', kind: 'text',
    label: 'Project',
    help: 'The Azure DevOps project your board lives in.',
    defaultLabel: 'what az devops configure has',
  },
  {
    key: 'ado_team', env: 'SH_ADO_TEAM', group: 'board', kind: 'text',
    label: 'Team',
    help: 'The team you plan sprints with.',
    defaultLabel: 'the only team, if there is just one',
  },
  {
    key: 'ado_user', env: 'SH_ADO_USER', group: 'board', kind: 'text',
    label: 'You',
    help: 'The email you sign in to Azure DevOps with. New tasks get assigned to it.',
    defaultLabel: 'the account az is signed in with',
  },
  {
    key: 'ado_pat', env: 'SH_ADO_PAT', group: 'board', kind: 'secret',
    label: 'Personal access token',
    help: 'Only used when you reach the board with a token. Needs work item read and write.',
    defaultLabel: 'not saved',
  },

  // ---- pages ----
  {
    key: 'use_discovery', env: 'SH_USE_DISCOVERY', group: 'pages', kind: 'choice',
    label: 'Discovery',
    help: 'Working out a problem before anyone designs it: questions, meetings, a small demo. Turn on if your sprints have a discovery step.',
    choices: [{ value: 'on', label: 'On' }, { value: 'off', label: 'Off' }],
    defaultLabel: 'Off',
    defaultValue: 'off',
    clean: raw => onOff('use_discovery', raw),
  },
  {
    key: 'use_design', env: 'SH_USE_DESIGN', group: 'pages', kind: 'choice',
    label: 'Design',
    help: 'Writing a design and turning it into stories on the board. Turn on if you design features before you build them.',
    choices: [{ value: 'on', label: 'On' }, { value: 'off', label: 'Off' }],
    defaultLabel: 'Off',
    defaultValue: 'off',
    clean: raw => onOff('use_design', raw),
  },

  // ---- other ----
  {
    key: 'max_parallel_sessions', env: 'SH_MAX_PARALLEL_SESSIONS', group: 'other', kind: 'number',
    label: 'Most tasks open at once',
    help: 'How many work sessions can run at the same time before a new one is refused.',
    defaultLabel: String(DEFAULT_MAX_PARALLEL_SESSIONS),
    defaultValue: String(DEFAULT_MAX_PARALLEL_SESSIONS),
    clean: raw => {
      const n = Number(raw.trim());
      if (!Number.isInteger(n) || n < 1) throw new SettingError('max_parallel_sessions', 'Use a whole number, 1 or more.');
      return String(n);
    },
  },
];

const BY_KEY = new Map(DEFS.map(d => [d.key, d]));

function viewOf(def: SettingDef): SettingView {
  const base = {
    key: def.key, env: def.env, group: def.group, label: def.label, help: def.help,
    kind: def.kind, choices: def.choices, defaultLabel: def.defaultLabel, defaultValue: def.defaultValue,
  };
  if (def.kind === 'secret') {
    const { source } = readToken();
    return { ...base, value: null, source: source === 'none' ? 'default' : source, locked: source === 'env' };
  }
  const fromEnv = process.env[def.env]?.trim();
  if (fromEnv) return { ...base, value: fromEnv, source: 'env', locked: true };
  const value = configValue(def.env, def.key);
  return { ...base, value: value ?? null, source: value == null ? 'default' : 'setting', locked: false };
}

/** Every setting, with the value in use and where it comes from. */
export function listSettings(): SettingView[] {
  return DEFS.map(viewOf);
}

/** True when the token is kept in plain text but the Keychain is right there. */
export function tokenCanMoveToKeychain(): boolean {
  return keychainAvailable() && readToken().source === 'setting';
}

/**
 * Save several settings at once. Every value is checked before anything is
 * written, so a refused value leaves all the others untouched too.
 *
 * - A blank value clears the setting (back to the default).
 * - A blank token means "keep the one I have" — it is never sent back to the
 *   screen, so the box is always empty.
 * - A setting forced by an environment variable is refused, never quietly
 *   saved where it would have no effect.
 */
export function saveSettings(values: Record<string, string>): void {
  const cleaned: [string, string][] = [];
  let token: string | null = null;
  const next = (key: string): string | undefined => {
    if (key in values && values[key].trim() !== '') return values[key].trim();
    return configValue(BY_KEY.get(key)?.env ?? '', key);
  };
  for (const [key, raw] of Object.entries(values)) {
    const def = BY_KEY.get(key);
    if (!def) throw new SettingError(key, `There is no setting called "${key}".`);
    const typed = String(raw ?? '').trim();
    if (process.env[def.env]?.trim()) {
      // Unchanged is fine (the screen sends the whole form back); a change is not.
      if (def.kind === 'secret' ? typed === '' : typed === process.env[def.env]!.trim()) continue;
      throw new SettingError(key, `${def.label} is set by the ${def.env} environment variable, so it can't be changed here.`);
    }
    if (def.kind === 'secret') {
      if (typed !== '') token = typed;
      continue;
    }
    if (typed === '') {
      cleaned.push([key, '']);
      continue;
    }
    cleaned.push([key, def.clean ? def.clean(typed, next) : typed]);
  }
  if (token != null) {
    try {
      saveToken(token);
    } catch (err) {
      throw new SettingError('ado_pat', err instanceof Error ? err.message : String(err));
    }
  }
  for (const [key, value] of cleaned) {
    if ((getSetting(key) ?? '') !== value) setSetting(key, value);
  }
}
