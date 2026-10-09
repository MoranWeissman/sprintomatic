/**
 * The user's week: which days are workdays, how long a workday is, the hours
 * it runs, and how much a "maybe" meeting counts. One place, so capacity,
 * standup, ceremonies, days off and the instruction text never disagree.
 *
 * Every value resolves the same way: environment variable → the local
 * settings table → built-in default. The defaults are a common office week
 * (Mon-Fri, 9h, 08:00-18:00, tentative meetings ignored); `npm run setup` or
 * the settings screen changes them. Every knob is listed in
 * docs/configuration.md.
 */
import { getSetting } from './timers';

export const DEFAULT_WORKING_DAYS: ReadonlySet<number> = new Set([1, 2, 3, 4, 5]); // Mon-Fri
export const DEFAULT_WORKDAY_HOURS = 9;
export const DEFAULT_WORKDAY_START_HOUR = 8; // 08:00 local
export const DEFAULT_WORKDAY_END_HOUR = 18; // 18:00 local
export const DEFAULT_TENTATIVE_WEIGHT = 0; // tentative meetings ignored

export const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * The raw value of one knob: the environment variable wins, then the stored
 * setting. Blank counts as unset in both places. The shared rule every
 * config reader in the server uses.
 */
export function configValue(envKey: string, settingKey: string): string | undefined {
  const fromEnv = process.env[envKey];
  if (fromEnv != null && fromEnv.trim() !== '') return fromEnv.trim();
  const fromSetting = getSetting(settingKey);
  if (fromSetting != null && fromSetting.trim() !== '') return fromSetting.trim();
  return undefined;
}

function configNumber(envKey: string, settingKey: string, fallback: number, ok: (n: number) => boolean): number {
  const raw = configValue(envKey, settingKey);
  if (raw == null) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && ok(n) ? n : fallback;
}

/**
 * Working days as weekday numbers (0=Sun … 6=Sat). Set as a comma list, e.g.
 * "1,2,3,4,5" for Mon-Fri. Anything unreadable falls back to the default
 * rather than leaving a week with no workdays in it.
 */
export function getWorkingDays(): Set<number> {
  const raw = configValue('SH_WORKING_DAYS', 'working_days');
  if (raw == null) return new Set(DEFAULT_WORKING_DAYS);
  const days = raw
    .split(',')
    .map(s => s.trim())
    .filter(s => s !== '')
    .map(Number)
    .filter(n => Number.isInteger(n) && n >= 0 && n <= 6);
  return days.length > 0 ? new Set(days) : new Set(DEFAULT_WORKING_DAYS);
}

/** Length of a workday in hours. Also what one story point means. */
export function getWorkdayHours(): number {
  return configNumber('SH_WORKDAY_HOURS', 'workday_hours', DEFAULT_WORKDAY_HOURS, n => n > 0 && n <= 24);
}

/** Hour the workday starts (local). Meetings before it don't count. */
export function getWorkdayStartHour(): number {
  return configNumber('SH_WORKDAY_START_HOUR', 'workday_start_hour', DEFAULT_WORKDAY_START_HOUR, n => n >= 0 && n < 24);
}

/** Hour the workday ends (local). Meetings after it don't count. */
export function getWorkdayEndHour(): number {
  const start = getWorkdayStartHour();
  return configNumber('SH_WORKDAY_END_HOUR', 'workday_end_hour', DEFAULT_WORKDAY_END_HOUR, n => n > start && n <= 24);
}

/** How much a tentative meeting counts against desk time: 0 = not at all, 1 = in full. */
export function getTentativeWeight(): number {
  return configNumber('SH_TENTATIVE_WEIGHT', 'tentative_weight', DEFAULT_TENTATIVE_WEIGHT, n => n >= 0 && n <= 1);
}

/** "Sun-Thu" for a run of days, "Mon, Wed, Fri" otherwise. */
export function workingDaysLabel(days: ReadonlySet<number> = getWorkingDays()): string {
  const sorted = [...days].sort((a, b) => a - b);
  const isRun = sorted.every((d, i) => i === 0 || d === sorted[i - 1] + 1);
  if (isRun && sorted.length > 2) return `${DAY_NAMES[sorted[0]]}-${DAY_NAMES[sorted[sorted.length - 1]]}`;
  return sorted.map(d => DAY_NAMES[d]).join(', ');
}

/** The days that are NOT workdays, e.g. "Fri and Sat". */
export function daysOffLabel(days: ReadonlySet<number> = getWorkingDays()): string {
  const off = DAY_NAMES.filter((_, i) => !days.has(i));
  if (off.length === 0) return 'no days';
  return off.length === 1 ? off[0] : `${off.slice(0, -1).join(', ')} and ${off[off.length - 1]}`;
}

export function hourLabel(h: number): string {
  const whole = Math.floor(h);
  const mins = Math.round((h - whole) * 60);
  return `${String(whole).padStart(2, '0')}:${String(mins).padStart(2, '0')}`;
}

/** "08:00-18:00" */
export function workdayWindowLabel(): string {
  return `${hourLabel(getWorkdayStartHour())}-${hourLabel(getWorkdayEndHour())}`;
}

/** "ignored entirely" / "counted in full" / "counted at 50%" */
export function tentativeLabel(weight: number = getTentativeWeight()): string {
  if (weight === 0) return 'ignored entirely';
  if (weight === 1) return 'counted in full';
  return `counted at ${Math.round(weight * 100)}%`;
}

/**
 * Which halves of the Discovery & Design page the user works with. Not every
 * team runs a discovery before the design, and many run neither, so both are
 * off until the user turns them on (setup asks, Settings → Pages changes it).
 */
export function getPages(): { discovery: boolean; design: boolean } {
  return {
    discovery: configValue('SH_USE_DISCOVERY', 'use_discovery') === 'on',
    design: configValue('SH_USE_DESIGN', 'use_design') === 'on',
  };
}

/** The plain answer a chat tool gives when its half of the page is off. */
export function pageOffMessage(which: 'discovery' | 'design' | 'both'): string {
  const name = which === 'both' ? 'Discovery and Design are' : which === 'discovery' ? 'Discovery is' : 'Design is';
  return `${name} turned off in this sprintomatic. Tell the user plainly, and that they can turn it on in the dashboard under Settings → Pages (then open a new chat). Don't do this step any other way.`;
}
