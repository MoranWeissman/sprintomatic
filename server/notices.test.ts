import { describe, expect, it } from 'vitest';
import { dueNotices, type NoticeInput } from './notices';
import type { ChatView } from './chat-state';

const at = (h: number, m = 0) => new Date(2026, 6, 5, h, m, 0);
const base: NoticeInput = {
  now: at(10), on: true, isWorkingDay: true, workdayEndHour: 18,
  dailyStartsAt: null, timersOn: [], waitingChats: [],
};
const chat = (minutes: number): ChatView => ({
  chatId: 'c1', repo: 'web-api', story: null, task: 'Add up the same ingredients', taskId: '100010',
  state: 'waiting', why: 'asks for permission', since: '2026-07-05T07:00:00Z', minutes, tty: 'ttys004',
});

describe('dueNotices', () => {
  it('nothing when turned off', () => {
    expect(dueNotices({ ...base, on: false, waitingChats: [chat(20)] })).toEqual([]);
  });

  it('daily: only in the 15 minutes before it', () => {
    const in10 = at(10, 10).toISOString();
    const in40 = at(10, 40).toISOString();
    expect(dueNotices({ ...base, dailyStartsAt: in10 })[0]).toMatchObject({ key: `daily:${in10}`, title: 'Daily in 10 minutes' });
    expect(dueNotices({ ...base, dailyStartsAt: in40 })).toEqual([]);
  });

  it('end of day: only after the end hour, on a working day, with a timer on', () => {
    const on = { ...base, timersOn: ['Clear message when a page has no recipe'] };
    expect(dueNotices({ ...on, now: at(17, 59) })).toEqual([]);
    expect(dueNotices({ ...on, now: at(18, 5) })[0].body).toContain('Clear message when a page has no recipe');
    expect(dueNotices({ ...on, now: at(18, 5), isWorkingDay: false })).toEqual([]);
    expect(dueNotices({ ...base, now: at(18, 5) })).toEqual([]);
  });

  it('end of day key is the same all evening, so it shows once', () => {
    const on = { ...base, timersOn: ['a'] };
    expect(dueNotices({ ...on, now: at(18, 5) })[0].key).toBe(dueNotices({ ...on, now: at(22, 0) })[0].key);
  });

  it('chat: only after 5 minutes waiting, and the click goes to its terminal', () => {
    expect(dueNotices({ ...base, waitingChats: [chat(4)] })).toEqual([]);
    const [n] = dueNotices({ ...base, waitingChats: [chat(5)] });
    expect(n).toMatchObject({ tty: 'ttys004', body: 'Add up the same ingredients · asks for permission' });
  });
});
