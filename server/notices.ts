/**
 * GET /api/notices — the few things worth a Mac notice, for the Mac app.
 *
 * Only three, on purpose:
 *   - the daily meeting starts in 15 minutes or less;
 *   - the workday is over and a timer is still on;
 *   - a chat has waited for the user for 5 minutes or more.
 *
 * Each notice has a key. The Mac app shows each key once and never again,
 * so a notice can't nag. Settings → "Mac notices" turns them all off.
 */
import type { ChatView } from './chat-state';

export const DAILY_NOTICE_MINUTES = 15;
export const CHAT_NOTICE_MINUTES = 5;

export interface Notice {
  /** Shown once per key, ever. */
  key: string;
  title: string;
  body: string;
  /** Click brings this chat's terminal forward. Null opens the dashboard. */
  tty: string | null;
}

export interface NoticeInput {
  now: Date;
  on: boolean;
  isWorkingDay: boolean;
  workdayEndHour: number;
  /** The daily meeting's next start, ISO, when there is one. */
  dailyStartsAt: string | null;
  /** Titles of the tasks with a timer on. */
  timersOn: string[];
  waitingChats: ChatView[];
}

const localDate = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export function dueNotices(i: NoticeInput): Notice[] {
  if (!i.on) return [];
  const out: Notice[] = [];

  if (i.dailyStartsAt) {
    const mins = Math.round((Date.parse(i.dailyStartsAt) - i.now.getTime()) / 60_000);
    if (mins >= 0 && mins <= DAILY_NOTICE_MINUTES) {
      out.push({
        key: `daily:${i.dailyStartsAt}`,
        title: mins <= 1 ? 'Daily starts now' : `Daily in ${mins} minutes`,
        body: 'Your Daily page is ready.',
        tty: null,
      });
    }
  }

  if (i.isWorkingDay && i.timersOn.length > 0 && i.now.getHours() >= i.workdayEndHour) {
    const n = i.timersOn.length;
    out.push({
      key: `end-of-day:${localDate(i.now)}`,
      title: 'Your workday is over',
      body:
        n === 1
          ? `A timer is still on: ${i.timersOn[0]}. Close it in its chat if you're done.`
          : `${n} timers are still on. Close them in their chats if you're done.`,
      tty: null,
    });
  }

  for (const c of i.waitingChats) {
    if (c.minutes < CHAT_NOTICE_MINUTES) continue;
    out.push({
      key: `chat:${c.chatId}:${c.since}`,
      title: 'A chat is waiting for you',
      body: [c.task ?? c.story ?? c.repo, c.why].filter(Boolean).join(' · '),
      tty: c.tty,
    });
  }

  return out;
}

/** Gathers the live inputs. Kept apart from dueNotices so the rules can be tested. */
export async function noticesNow(now = new Date()): Promise<Notice[]> {
  const { configValue, getWorkdayEndHour } = await import('./user-config');
  if (configValue('SPRINTOMATIC_MAC_NOTICES', 'mac_notices') === 'off') return [];
  const { chatsNow } = await import('./chats');
  const { listActiveSessions } = await import('./sessions');
  const { peekDashboardPayload } = await import('./dashboard-cache');
  const { isWorkingDayFor } = await import('./wrap');
  const { computeUpcomingCeremonies } = await import('./ceremony');

  const payload = peekDashboardPayload();
  const items = payload
    ? [...payload.workItems.inProgress, ...payload.workItems.upNext, ...payload.workItems.done]
    : [];
  const titleOf = new Map(items.map(i => [i.id, i.title]));
  const timersOn = listActiveSessions().map(s => titleOf.get(String(s.workItemId)) ?? `task #${s.workItemId}`);

  // Recompute from the sprint dates so the time is live, not from the cache.
  let dailyStartsAt: string | null = null;
  if (payload?.sprint) {
    const upcoming = computeUpcomingCeremonies({
      sprintStart: new Date(payload.sprint.startDate),
      sprintFinish: new Date(payload.sprint.finishDate),
      now,
    });
    dailyStartsAt = upcoming.find(u => u.id === 'daily' && u.minutesUntil >= 0)?.startsAt ?? null;
  }

  return dueNotices({
    now,
    on: true,
    isWorkingDay: isWorkingDayFor(now),
    workdayEndHour: getWorkdayEndHour(),
    dailyStartsAt,
    timersOn,
    waitingChats: chatsNow(now).waiting,
  });
}
