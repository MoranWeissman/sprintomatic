/**
 * GET /api/chats — the chats waiting for the user, for the Mac app's menu bar.
 *
 * The hooks write the raw state (server/chat-state.ts). This adds what the
 * hook can't know: which story the chat is on (the open session in the same
 * repo) and whether its terminal still exists.
 */
import { execFile, execFileSync } from 'node:child_process';
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
  if (rows.length === 0) return { waiting: [], finished: [], working: [] };

  const sessions = listActiveSessions().filter(s => s.cwd && s.cwd.startsWith('/'));
  const sessionRepo = new Map(sessions.map(s => [s.id, repoRootFor(s.cwd!)]));
  const payload = peekDashboardPayload();
  const items = payload
    ? [...payload.workItems.inProgress, ...payload.workItems.upNext, ...payload.workItems.done]
    : [];
  const byId = new Map(items.map(i => [i.id, i]));

  const storyFor = (cwd: string, tty: string | null): ChatStory => {
    const none = { story: null, task: null, taskId: null, question: null };
    // The session this chat opened itself (same terminal) wins.
    let s = tty ? sessions.find(x => x.tty === tty) : undefined;
    if (!s) {
      const repo = repoRootFor(cwd);
      if (!repo) return none;
      // Old sessions with no terminal: only when one sits in the repo. Two
      // means we can't tell which is this chat's, so say nothing.
      const here = sessions.filter(x => !x.tty && sessionRepo.get(x.id) === repo);
      if (here.length !== 1) return none;
      s = here[0];
    }
    const item = byId.get(String(s.workItemId));
    return {
      story: item?.parent?.title ?? null,
      task: item?.title ?? null,
      taskId: String(s.workItemId),
      question: s.waitingSince && s.waitingNote ? s.waitingNote : null,
    };
  };

  return buildChatsBlock({ rows, now, liveTtys: liveTtys(), storyFor });
}

/**
 * Bring the iTerm tab on this terminal to the front. Mac only. The tty must
 * look like one ("ttys004") since it goes into a script. False when it doesn't.
 */
export function jumpToChat(tty: string): boolean {
  if (process.platform !== 'darwin' || !/^ttys\d{1,4}$/.test(tty)) return false;
  const script = `
    tell application "iTerm2"
      activate
      repeat with w in windows
        repeat with t in tabs of w
          repeat with s in sessions of t
            if tty of s is "/dev/${tty}" then
              select w
              select t
              select s
              return
            end if
          end repeat
        end repeat
      end repeat
    end tell`;
  execFile('osascript', ['-e', script], () => {});
  return true;
}
