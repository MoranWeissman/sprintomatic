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

  const others = rows.filter(r => r.kind !== 'waiting');
  const go = (c: ApiChat) => { if (c.tty) void jumpToChat(c.tty); };
  const goTitle = (c: ApiChat) => (c.tty ? 'Go to this chat in iTerm' : "This chat's terminal is not known");

  return (
    <section className={`chats-card ${n > 0 ? 'has-waiting' : ''}`} aria-label="Your chats">
      <header className="chats-head">
        <h2 className="chats-title">Your chats</h2>
        <span className="chats-sum">
          {n > 0 ? `${rows.length} open · ${n} ${n === 1 ? 'needs' : 'need'} you` : `${rows.length} open, none waiting for you`}
        </span>
      </header>
      <div className={`chats-grid ${n > 0 ? 'has-big' : ''}`}>
        {n > 0 && (
          <div className="chats-big-col">
            {chats.waiting.map(c => (
              <article key={c.chatId} className="chats-big">
                <div className="chats-big-top">
                  <span className="chats-ask"><i aria-hidden="true" />needs you</span>
                  <span className="chats-repo">{c.repo}</span>
                  <span className="chats-grow" />
                  <span className="chats-wait">waiting <b>{c.minutes > 0 ? `${c.minutes} min` : 'now'}</b></span>
                </div>
                <h3 className="chats-big-title">{label(c)}</h3>
                {c.why && c.why !== 'finished' && (
                  <p className="chats-big-why">
                    {c.why === 'asks for permission' ? 'It asks for permission to run a command.' : c.why}
                  </p>
                )}
                <div className="chats-big-act">
                  <button type="button" className="chats-go" disabled={!c.tty} onClick={() => go(c)} title={goTitle(c)}>
                    Open the chat
                  </button>
                  {c.story && c.task && <span className="chats-in">in <b>{c.story}</b></span>}
                  {c.taskId && onOpenItem && (
                    <button type="button" className="chats-open" onClick={() => onOpenItem(c.taskId!)} title="Open the task">
                      Task
                    </button>
                  )}
                </div>
              </article>
            ))}
          </div>
        )}
        {others.length > 0 && (
          <ul className="chats-list">
            {others.map(({ c, kind }) => (
              <li key={c.chatId} className={`chats-row is-${kind}`}>
                <button type="button" className="chats-row-main" disabled={!c.tty} onClick={() => go(c)} title={goTitle(c)}>
                  <span className="chats-dot" aria-hidden="true" />
                  <span className="chats-row-text">
                    <span className="chats-kind">{KIND_WORD[kind]}</span>
                    <span className="chats-label">{label(c)}</span>
                    <span className="chats-detail">{detail(c, kind)}</span>
                  </span>
                </button>
                {c.taskId && onOpenItem && (
                  <button type="button" className="chats-open" onClick={() => onOpenItem(c.taskId!)} title="Open the task">
                    Task
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
