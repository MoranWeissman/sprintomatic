import { useState } from 'react';
import type { ApiPayload } from '../lib/api';
import { postCarryForward } from '../lib/api';
import { Mono } from './Mono';

/**
 * Unfinished tasks left behind in an earlier sprint, with a one-tap offer to
 * pull them into the current one.
 *
 * Three things this has to be clear about, because a flat list of task names
 * was not:
 *  - WHICH STORY each task belongs to. Everywhere else in the dashboard tasks
 *    sit under their story; reading six loose sentences and working out the
 *    grouping by hand is the confusing part.
 *  - WHERE they came from. "26_16" on its own says nothing — the sprint has to
 *    be placed in time ("last sprint", "3 sprints back").
 *  - WHAT the button does. The tasks move to this sprint; their story stays
 *    where it is. That's the house rule, and it has to be on screen.
 */
export function CarryForwardBanner({
  info,
  onOpenItem,
  onDone,
}: {
  info: NonNullable<ApiPayload['carryForward']>;
  onOpenItem: (id: string) => void;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pull = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await postCarryForward(info.taskIds);
      if (r.failed.length > 0) {
        setError(`Couldn't move ${r.failed.length} — open them in Azure DevOps.`);
      }
      onDone();
    } catch {
      setError('Something went wrong — try again, or use the Plan page.');
    } finally {
      setBusy(false);
    }
  };

  const noun = info.count === 1 ? 'task' : 'tasks';
  const storyCount = info.groups.filter(g => g.storyId != null).length;

  return (
    <section className="r21-carryforward" aria-label="Unfinished work from an earlier sprint">
      <div className="r21-carryforward-head">
        <div className="r21-carryforward-text">
          <strong>{info.count} unfinished {noun} from {info.fromLabel}</strong>
          <span>
            {info.count === 1 ? 'This task moves' : 'These tasks move'} to this sprint.{' '}
            {storyCount === 1 ? 'Its story stays' : 'Their stories stay'} where{' '}
            {storyCount === 1 ? 'it is' : 'they are'}.
          </span>
        </div>
        <button type="button" className="r21-carryforward-btn" onClick={pull} disabled={busy}>
          {busy ? 'Pulling…' : `Pull ${info.count === 1 ? 'it' : 'them'} into this sprint`}
        </button>
      </div>

      {info.groups.map(group => (
        <div className="r21-carryforward-group" key={group.storyId ?? 'no-story'}>
          <div className="r21-carryforward-story">
            {group.storyDisplayName ? (
              <StoryHeading display={group.storyDisplayName} storyId={group.storyId} onOpenItem={onOpenItem} />
            ) : (
              <span className="r21-carryforward-story-none">Not under a story</span>
            )}
          </div>
          <ul className="r21-carryforward-list">
            {group.tasks.map(t => (
              <li key={t.id}>
                <button
                  type="button"
                  className="r21-carryforward-task"
                  onClick={() => onOpenItem(String(t.id))}
                >
                  <span className="r21-carryforward-task-title">{t.title}</span>
                  <Mono className="r21-carryforward-task-id">#{t.id}</Mono>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ))}

      {error && <span className="r21-carryforward-error">{error}</span>}
    </section>
  );
}

/**
 * The server ships the heading pre-formatted as `**title** (#id)` so nobody
 * rebuilds it. Split it back apart only to style the two halves — the title
 * leads, the id trails in mono. When the title couldn't be read the server
 * sends a bare `#id`, which falls through as the whole label.
 */
function StoryHeading({
  display,
  storyId,
  onOpenItem,
}: {
  display: string;
  storyId: number | null;
  onOpenItem: (id: string) => void;
}) {
  const m = display.match(/^\*\*(.+)\*\* \(#(\d+)\)$/);
  return (
    <button
      type="button"
      className="r21-carryforward-story-btn"
      onClick={() => storyId != null && onOpenItem(String(storyId))}
      title="Open the story"
    >
      <span className="r21-carryforward-story-title">{m ? m[1] : display}</span>
      {m && <Mono className="r21-carryforward-story-id">#{m[2]}</Mono>}
    </button>
  );
}
