/**
 * GET /api/chats — the chats waiting for the user, for the Mac app's menu bar.
 *
 * The hooks write the raw state (server/chat-state.ts). This adds what the
 * hook can't know: which story the chat is on (the open session in the same
 * repo) and whether its terminal still exists.
 */
import { execFileSync } from 'node:child_process';
import { getDb } from './db';
import { buildChatsBlock, readChatRows, type ChatStory, type ChatsBlock } from './chat-state';
import { listActiveSessions } from './sessions';
import { repoRootFor } from './session-guard';
import { peekDashboardPayload } from './dashboard-cache';

/** Every terminal that still has a process on it; null when ps fails. */
function liveTtys(): Set<string> | null {
  try {
    const out = execFileSync('ps', ['-A', '-o', 'tty='], { encoding: 'utf8', timeout: 2000 });
    return new Set(out.split('\n').map(l => l.trim()).filter(Boolean));
  } catch {
    return null;
  }
}

export function chatsNow(now = new Date()): ChatsBlock {
  const rows = readChatRows(getDb(), now);
  if (rows.length === 0) return { waiting: [], working: [] };

  const sessions = listActiveSessions().filter(s => s.cwd && s.cwd.startsWith('/'));
  const sessionRepo = new Map(sessions.map(s => [s.id, repoRootFor(s.cwd!)]));
  const payload = peekDashboardPayload();
  const items = payload
    ? [...payload.workItems.inProgress, ...payload.workItems.upNext, ...payload.workItems.done]
    : [];
  const byId = new Map(items.map(i => [i.id, i]));

  const storyFor = (cwd: string): ChatStory => {
    const none = { story: null, task: null, question: null };
    const repo = repoRootFor(cwd);
    if (!repo) return none;
    const here = sessions.filter(s => sessionRepo.get(s.id) === repo);
    // Two open sessions in one repo: can't tell which is this chat's. Say
    // nothing rather than guess.
    if (here.length !== 1) return none;
    const s = here[0];
    const item = byId.get(String(s.workItemId));
    return {
      story: item?.parent?.title ?? null,
      task: item?.title ?? null,
      question: s.waitingSince && s.waitingNote ? s.waitingNote : null,
    };
  };

  return buildChatsBlock({ rows, now, liveTtys: liveTtys(), storyFor });
}
