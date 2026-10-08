/**
 * The "Needs you" block for the dashboard's right rail: which live chats are
 * waiting on the user's answer, and which tasks other chats finished recently.
 * Pure — all inputs injected, no DB or clock access here.
 */
import { displayNameFor } from './display-name';
import type { Session } from './sessions';

/** How long a finished task stays on the card before aging out. */
export const RECENTLY_FINISHED_HOURS = 4;

export interface NeedsYouWaiting {
  workItemId: number;
  /** Pre-formatted `**title** (#id)`, or `#id` when the title is unknown. */
  displayName: string;
  question: string;
  waitingSince: string;
}

export interface NeedsYouFinished {
  workItemId: number;
  displayName: string;
  summary: string | null;
  endedAt: string;
}

export interface NeedsYouBlock {
  waiting: NeedsYouWaiting[];
  recentlyFinished: NeedsYouFinished[];
}

export function buildNeedsYou(opts: {
  activeSessions: Session[];
  /** Sessions ended within the window (see listRecentlyEnded). */
  recentlyEnded: Session[];
  titleFor: (workItemId: number) => string | null;
  /** True when the work item's REAL state is a done state right now. */
  isDone: (workItemId: number) => boolean;
}): NeedsYouBlock {
  const displayName = (id: number) => displayNameFor(id, opts.titleFor(id));

  const waiting = opts.activeSessions
    .filter(s => s.waitingSince != null && s.waitingNote != null)
    .map(s => ({
      workItemId: s.workItemId,
      displayName: displayName(s.workItemId),
      question: s.waitingNote as string,
      waitingSince: s.waitingSince as string,
    }));

  // A pause also ends a session — only tasks that are REALLY done now count
  // as finished. Everything else ages out silently.
  const finishedRows = opts.recentlyEnded
    .filter(s => s.endedAt != null && opts.isDone(s.workItemId))
    .map(s => ({
      workItemId: s.workItemId,
      displayName: displayName(s.workItemId),
      summary: s.summary,
      endedAt: s.endedAt as string,
    }));

  // A task can end more than one session in the window (e.g. a lunch pause
  // then the real finish). Only the newest ended session per work item
  // should show — otherwise the same task appears twice, and an older
  // pause's summary can display as if it were the finish.
  const newestByWorkItem = new Map<number, (typeof finishedRows)[number]>();
  for (const row of finishedRows) {
    const current = newestByWorkItem.get(row.workItemId);
    if (!current || row.endedAt > current.endedAt) {
      newestByWorkItem.set(row.workItemId, row);
    }
  }
  const recentlyFinished = [...newestByWorkItem.values()].sort((a, b) =>
    a.endedAt < b.endedAt ? 1 : a.endedAt > b.endedAt ? -1 : 0,
  );

  return { waiting, recentlyFinished };
}
