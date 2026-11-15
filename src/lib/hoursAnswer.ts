import { overEstimate } from '../../server/over-estimate';

/** "3h 10m", "45m", "0m". */
function hm(seconds: number): string {
  const min = Math.round(seconds / 60);
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

function num(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1).replace(/\.0$/, '');
}

/**
 * The one line that answers "am I nearly done, or over?" for a task, so the
 * user doesn't have to work it out from three numbers.
 *
 * - "7h spent of an 8h guess · about 1h left"
 * - "2h spent · no guess yet"
 * - Past the guess, the "left" half is dropped: the over-estimate line under
 *   it already says so.
 */
export function hoursAnswer(opts: {
  loggedSeconds: number;
  guessHours: number | null | undefined;
  leftHours: number | null | undefined;
  /** The board's Completed Work, so "past the guess" matches the over-estimate line. */
  completedHours?: number | null;
}): string {
  const spent = `${hm(opts.loggedSeconds)} spent`;
  const guess = opts.guessHours != null && opts.guessHours > 0 ? opts.guessHours : null;
  if (guess == null) {
    return opts.leftHours != null ? `${spent} · about ${num(opts.leftHours)}h left` : `${spent} · no guess yet`;
  }
  // "an 8h", "an 11h", "an 18h"; "a 6h" for the rest.
  const intPart = String(Math.floor(guess));
  const article = intPart.startsWith('8') || intPart === '11' || intPart === '18' ? 'an' : 'a';
  const head = `${spent} of ${article} ${num(guess)}h guess`;
  const over = overEstimate({ originalEstimate: guess, completedWork: opts.completedHours, loggedSeconds: opts.loggedSeconds });
  if (over) return head;
  if (opts.leftHours == null) return head;
  return `${head} · about ${num(opts.leftHours)}h left`;
}
