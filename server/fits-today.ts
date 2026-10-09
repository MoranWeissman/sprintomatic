/**
 * "What fits today?" — from today's free desk time and the open tasks'
 * remaining hours, pick what can really be finished today.
 *
 * Simple on purpose: tasks already going come first (finishing beats
 * starting), then the ones waiting, in board order. A task fits when its
 * remaining hours fit in what is still free; a task that is too big is
 * skipped and the next one is tried.
 */
import { displayNameFor } from './display-name';

export interface FitsTask {
  id: number;
  title: string;
  remainingHours: number;
}

export interface FitsToday {
  freeHours: number;
  /** Tasks that can be finished today, in the order to do them. */
  fits: (FitsTask & { displayName: string })[];
  /** One plain sentence for the chat and the Day page. Echo it. */
  summary: string;
}

/** Below this, there is no real desk time left to plan with. */
const MIN_FREE_HOURS = 0.5;

export function buildFitsToday(opts: {
  freeHours: number;
  /** False on a day off or a non-working day. */
  isWorkToday: boolean;
  going: FitsTask[];
  waiting: FitsTask[];
  /** False when no calendar is connected, so meetings are not counted. */
  hasCalendar: boolean;
}): FitsToday {
  const freeHours = roundHalf(opts.freeHours);
  const fits: FitsToday['fits'] = [];
  let left = opts.freeHours;
  for (const t of [...opts.going, ...opts.waiting]) {
    if (t.remainingHours <= 0 || t.remainingHours > left) continue;
    fits.push({ ...t, displayName: displayNameFor(t.id, t.title) });
    left -= t.remainingHours;
  }
  const noCal = opts.hasCalendar ? '' : ' No calendar is connected, so meetings are not counted.';

  if (!opts.isWorkToday) {
    return { freeHours, fits: [], summary: 'Today is not one of your working days, so there is nothing to fit in.' };
  }
  if (opts.freeHours < MIN_FREE_HOURS) {
    return { freeHours, fits: [], summary: 'No free desk time left today.' };
  }
  const free = `You have about ${hours(freeHours)} free today.`;
  if (fits.length === 0) {
    return {
      freeHours,
      fits,
      summary: `${free} None of your open tasks can be finished in that, so pick one and get part of it done.${noCal}`,
    };
  }
  const list = fits.map(f => `${f.displayName} (${hours(f.remainingHours)} left)`).join(', ');
  const used = roundHalf(opts.freeHours - left);
  return {
    freeHours,
    fits,
    summary: `${free} You can finish ${fits.length === 1 ? 'this one' : `these ${fits.length}`}: ${list}. That is about ${hours(used)}.${noCal}`,
  };
}

function roundHalf(n: number): number {
  return Math.round(n * 2) / 2;
}

function hours(n: number): string {
  return `${n} hour${n === 1 ? '' : 's'}`;
}
