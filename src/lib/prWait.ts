/**
 * The word a task's state chip shows. A task marked "Waiting for PR" that is
 * still in work reads "waiting for PR", so the user can see it without
 * opening the task. Done and stuck tasks keep their own word.
 */
export const WAITING_PR_TAG = 'Waiting for PR';

export function chipWord(state: 'work' | 'wait' | 'stuck' | 'done', usual: string, tags?: string[]): string {
  if (state === 'done' || state === 'stuck') return usual;
  const waiting = (tags ?? []).some(t => t.trim().toLowerCase() === WAITING_PR_TAG.toLowerCase());
  return waiting ? 'waiting for PR' : usual;
}
