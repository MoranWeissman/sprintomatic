import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { applyChatChange, buildChatsBlock, chatChangeFor, readChatRows, type ChatRow } from './chat-state';

const t0 = new Date('2026-11-11T10:00:00Z');
const later = (s: number) => new Date(t0.getTime() + s * 1000);
const noStory = () => ({ story: null, task: null, question: null });

function note(db: Database.Database, hook: Parameters<typeof chatChangeFor>[0], at: Date, extra: { message?: string; tty?: string | null; chatId?: string } = {}) {
  applyChatChange(db, {
    chatId: extra.chatId ?? 'chat-1',
    client: 'claude',
    cwd: '/tmp/web-api',
    tty: extra.tty ?? null,
    change: chatChangeFor(hook, extra.message),
    now: at,
  });
}

describe('chatChangeFor', () => {
  it('waits after an answer and on a permission ask, works on a message or a tool', () => {
    expect(chatChangeFor('stop')).toEqual({ kind: 'set', state: 'waiting', reason: 'finished' });
    expect(chatChangeFor('notification', 'Claude needs your permission to use Bash')).toEqual({
      kind: 'set', state: 'waiting', reason: 'permission',
    });
    expect(chatChangeFor('prompt')).toEqual({ kind: 'set', state: 'working', reason: null });
    expect(chatChangeFor('post-tool-use')).toEqual({ kind: 'set', state: 'working', reason: null });
    expect(chatChangeFor('session-end')).toEqual({ kind: 'delete' });
  });

  it('ignores the "waiting for your input" reminder: the chat already waits', () => {
    expect(chatChangeFor('notification', 'Claude is waiting for your input')).toEqual({ kind: 'none' });
  });
});

describe('applyChatChange', () => {
  it('keeps the first wait time while the same state repeats, and the tty once known', () => {
    const db = new Database(':memory:');
    note(db, 'stop', t0, { tty: 'ttys004' });
    note(db, 'stop', later(60));
    const [row] = readChatRows(db, later(120));
    expect(row).toMatchObject({ state: 'waiting', reason: 'finished', since: t0.toISOString(), tty: 'ttys004' });
  });

  it('moves the time when the state changes, and forgets a closed chat', () => {
    const db = new Database(':memory:');
    note(db, 'stop', t0);
    note(db, 'prompt', later(60));
    expect(readChatRows(db, later(61))[0]).toMatchObject({ state: 'working', since: later(60).toISOString() });
    note(db, 'session-end', later(90));
    expect(readChatRows(db, later(91))).toEqual([]);
  });

  it('drops rows nobody touched for 12 hours', () => {
    const db = new Database(':memory:');
    note(db, 'stop', t0);
    expect(readChatRows(db, later(13 * 3600))).toEqual([]);
  });
});

describe('buildChatsBlock', () => {
  const row = (over: Partial<ChatRow>): ChatRow => ({
    chatId: 'chat-1', client: 'claude', cwd: '/tmp/web-api', tty: 'ttys004',
    state: 'waiting', reason: 'finished', since: t0.toISOString(), ...over,
  });

  it('counts a permission ask only after 30 seconds', () => {
    const rows = [row({ reason: 'permission' })];
    expect(buildChatsBlock({ rows, now: later(10), liveTtys: null, storyFor: noStory }).waiting).toEqual([]);
    const b = buildChatsBlock({ rows, now: later(400), liveTtys: null, storyFor: noStory });
    expect(b.waiting).toMatchObject([{ repo: 'web-api', why: 'asks for permission', minutes: 6 }]);
  });

  it('a finished answer is not waiting: shown as finished for 30 minutes, then dropped', () => {
    const rows = [row({ reason: 'finished' })];
    const soon = buildChatsBlock({ rows, now: later(5 * 60), liveTtys: null, storyFor: noStory });
    expect(soon.waiting).toEqual([]);
    expect(soon.finished).toMatchObject([{ why: 'finished', minutes: 5 }]);
    const late = buildChatsBlock({ rows, now: later(31 * 60), liveTtys: null, storyFor: noStory });
    expect([...late.waiting, ...late.finished, ...late.working]).toEqual([]);
  });

  it("a finished answer with the model's own question does count", () => {
    const b = buildChatsBlock({
      rows: [row({ reason: 'finished' })],
      now: later(60 * 60),
      liveTtys: null,
      storyFor: () => ({ story: null, task: null, question: 'Push now?' }),
    });
    expect(b.waiting).toMatchObject([{ why: 'Push now?' }]);
  });

  it('drops a chat whose terminal is gone', () => {
    const b = buildChatsBlock({ rows: [row({})], now: later(400), liveTtys: new Set(['ttys009']), storyFor: noStory });
    expect([...b.waiting, ...b.finished, ...b.working]).toEqual([]);
  });

  it("uses the model's own question and the story when it knows them", () => {
    const b = buildChatsBlock({
      rows: [row({ reason: 'permission' })],
      now: later(60),
      liveTtys: new Set(['ttys004']),
      storyFor: () => ({ story: 'Set up the release pipeline', task: 'Add the deploy step', question: 'Which region?' }),
    });
    expect(b.waiting[0]).toMatchObject({ story: 'Set up the release pipeline', task: 'Add the deploy step', why: 'Which region?' });
  });
});
