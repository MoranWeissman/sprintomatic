/**
 * "Your chats": one row per open AI chat, from the chats' own hooks. The same
 * list the Mac app's menu bar shows, so the two never disagree. A click brings
 * that chat's iTerm tab to the front.
 *
 * Waiting rows come first and carry the one accent. Working and finished rows
 * are quiet. Hidden when no chat is open.
 */
import { jumpToChat, type ApiChat, type ApiChats } from '../lib/api';

function label(c: ApiChat): string {
  return c.task ?? c.story ?? c.repo;
}

function detail(c: ApiChat, kind: 'waiting' | 'finished' | 'working'): string {
  const parts: string[] = [];
  // The repo only adds something when the label isn't already the repo.
  if (c.task || c.story) parts.push(c.repo);
  if (kind === 'waiting') parts.push(c.minutes > 0 ? `waiting ${c.minutes} min` : 'waiting');
  if (kind === 'finished') parts.push(c.minutes > 0 ? `finished ${c.minutes} min ago` : 'just finished');
  return parts.join(' · ');
}

const KIND_WORD = { waiting: 'Needs you', finished: 'Finished', working: 'Working' } as const;

export function ChatsCard({ chats, onOpenItem }: { chats: ApiChats; onOpenItem?: (id: string) => void }) {
  const rows = [
    ...chats.waiting.map(c => ({ c, kind: 'waiting' as const })),
    ...chats.finished.map(c => ({ c, kind: 'finished' as const })),
    ...chats.working.map(c => ({ c, kind: 'working' as const })),
  ];
  if (rows.length === 0) return null;
  const n = chats.waiting.length;

  return (
    <section className={`chats-card ${n > 0 ? 'has-waiting' : ''}`} aria-label="Your chats">
      <header className="chats-head">
        <h2 className="chats-title">Your chats</h2>
        <span className="chats-sum">
          {n > 0 ? `${n} ${n === 1 ? 'needs' : 'need'} you` : `${rows.length} open, none waiting for you`}
        </span>
      </header>
      <ul className="chats-list">
        {rows.map(({ c, kind }) => (
          <li key={c.chatId} className={`chats-row is-${kind}`}>
            <button
              type="button"
              className="chats-row-main"
              disabled={!c.tty}
              onClick={() => { if (c.tty) void jumpToChat(c.tty); }}
              title={c.tty ? 'Go to this chat in iTerm' : "This chat's terminal is not known"}
            >
              <span className="chats-kind">{KIND_WORD[kind]}</span>
              <span className="chats-label">{label(c)}</span>
              <span className="chats-detail">{detail(c, kind)}</span>
              {kind === 'waiting' && c.why && c.why !== 'finished' && (
                <span className="chats-why">{c.why === 'asks for permission' ? 'Asks for permission' : c.why}</span>
              )}
            </button>
            {c.taskId && onOpenItem && (
              <button type="button" className="chats-open" onClick={() => onOpenItem(c.taskId!)} title="Open the task">
                Task
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
