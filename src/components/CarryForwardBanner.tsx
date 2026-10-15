import { useState } from 'react';
import type { ApiPayload } from '../lib/api';
import { postCarryForward } from '../lib/api';

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
  const noHours =
    info.noHoursCount === 0
      ? ''
      : info.noHoursCount === info.count
        ? ' None of them have hours left filled in.'
        : ` ${info.noHoursCount} of them ${info.noHoursCount === 1 ? 'has' : 'have'} no hours left filled in.`;

  return (
    <section className="r21-carryforward" aria-label="Unfinished work from an earlier sprint">
      <div className="r21-carryforward-head">
        <div className="r21-carryforward-text">
          <strong>{info.count} unfinished {noun} from {info.fromLabel}</strong>
          <span>
            {info.remainingHours > 0 && `About ${hours(info.remainingHours)} left on ${info.count === 1 ? 'it' : 'them'}. `}
            {info.count === 1 ? 'The task moves' : 'The tasks move'} to this sprint;{' '}
            {storyCount === 1 ? 'its story stays' : 'their stories stay'} where{' '}
            {storyCount === 1 ? 'it is' : 'they are'}.
            {noHours}
          </span>
        </div>
        <button type="button" className="r21-carryforward-btn" onClick={pull} disabled={busy}>
          {busy ? 'Pulling…' : `Pull ${info.count === 1 ? 'it' : 'them'} into this sprint`}
        </button>
      </div>

      <ul className="r21-carryforward-groups">
        {info.groups.map(group => (
          <StoryRow key={group.storyId ?? 'no-story'} group={group} onOpenItem={onOpenItem} />
        ))}
      </ul>

      {error && <span className="r21-carryforward-error">{error}</span>}
    </section>
  );
}

type Group = NonNullable<ApiPayload['carryForward']>['groups'][number];

/**
 * One line per story: its name, how many tasks and how many hours. Closed to
 * start with — thirteen task names stacked above the user's day pushed the day
 * off the screen. Opening it lists the tasks with their hours.
 */
function StoryRow({ group, onOpenItem }: { group: Group; onOpenItem: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const n = group.tasks.length;
  const allNoHours = group.tasks.every(t => t.remainingHours == null);
  const size = `${n} ${n === 1 ? 'task' : 'tasks'} · ${allNoHours ? 'no hours yet' : `${hours(group.remainingHours)} left`}`;

  return (
    <li className="r21-carryforward-group">
      <button
        type="button"
        className="r21-carryforward-story-btn"
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
      >
        <span className="r21-carryforward-chev" aria-hidden="true">{open ? '▾' : '▸'}</span>
        <span className="r21-carryforward-story-title">
          {group.storyDisplayName ? storyTitle(group.storyDisplayName) : 'Not under a story'}
        </span>
        <span className="r21-carryforward-size">{size}</span>
      </button>

      {open && (
        <ul className="r21-carryforward-list">
          {group.tasks.map(t => (
            <li key={t.id}>
              <button type="button" className="r21-carryforward-task" onClick={() => onOpenItem(String(t.id))}>
                <span className="r21-carryforward-task-title">{t.title}</span>
                <span className="r21-carryforward-size">
                  {t.remainingHours == null ? 'no hours' : hours(t.remainingHours)}
                </span>
              </button>
            </li>
          ))}
          {group.storyId != null && (
            <li>
              <button
                type="button"
                className="r21-carryforward-task r21-carryforward-open-story"
                onClick={() => onOpenItem(String(group.storyId))}
              >
                Open the story
              </button>
            </li>
          )}
        </ul>
      )}
    </li>
  );
}

/** "3h", "2.5h". */
function hours(h: number): string {
  return `${Math.round(h * 10) / 10}h`;
}

/**
 * The server ships the heading pre-formatted as `**title** (#id)` so nobody
 * rebuilds it. Only the title is shown here — the number is in the drawer,
 * and a column of numbers was most of the noise. When the title couldn't be
 * read the server sends a bare `#id`, which is shown as it is.
 */
function storyTitle(display: string): string {
  const m = display.match(/^\*\*(.+)\*\* \(#(\d+)\)$/);
  return m ? m[1] : display;
}
