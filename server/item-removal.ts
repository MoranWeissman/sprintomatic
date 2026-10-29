/**
 * Taking work off the board without pretending it was done.
 *
 * Closing says "finished" and fills in the hours. Some work is never going to
 * happen, or stopped halfway on purpose, and closing it would put hours on
 * the board nobody spent. Removing is the honest way out: state Removed, no
 * hours left, and the hours really spent stay as they were.
 *
 * Everything here is pure; the board writes live in ./writes.
 */
import { isDoneState, isRemovedState } from './states';

export interface ChildLike {
  id: number;
  type: string;
  state: string;
  remainingWork?: number;
}

export interface TaskCounts {
  open: number;
  done: number;
  removed: number;
  /** Hours left on the open tasks. */
  remainingHours: number;
}

/** How a story's tasks stand. Only Tasks count; other children are left out. */
export function countTasks(children: ChildLike[]): TaskCounts {
  const out: TaskCounts = { open: 0, done: 0, removed: 0, remainingHours: 0 };
  for (const c of children) {
    if (c.type.toLowerCase() !== 'task') continue;
    if (isRemovedState(c.state)) out.removed++;
    else if (isDoneState(c.state)) out.done++;
    else {
      out.open++;
      out.remainingHours += c.remainingWork ?? 0;
    }
  }
  return out;
}

/** The child tasks a story close would drop: the ones still open. */
export function openTasks<T extends ChildLike>(children: T[]): T[] {
  return children.filter(c => c.type.toLowerCase() === 'task' && !isDoneState(c.state));
}

/** Why this item can't be removed, or null when it can. */
export function removalRefusal(args: {
  id: number;
  type: string;
  state: string;
  /** Ids with a sprintomatic session open right now. */
  openSessionIds: number[];
}): string | null {
  const { id, type, state, openSessionIds } = args;
  const t = type.toLowerCase();
  if (t === 'feature' || t === 'epic') {
    return `#${id} is a ${type}. Only Tasks, User Stories and Bugs can be removed here — a ${type} holds other people's work too.`;
  }
  if (isRemovedState(state)) return `#${id} is already ${state}. Nothing to do.`;
  if (isDoneState(state)) {
    return `#${id} is already ${state}, so it was finished. Removing it would hide work that was done.`;
  }
  if (openSessionIds.includes(id)) {
    return `#${id} has a work session open right now. End it with session_end first, then remove it.`;
  }
  return null;
}

/** The comment left on each removed item, so the board says why. */
export function removalComment(reason: string): string {
  const why = reason.trim();
  return why
    ? `Removed from the board by sprintomatic, not done: ${why}`
    : 'Removed from the board by sprintomatic, not done.';
}
