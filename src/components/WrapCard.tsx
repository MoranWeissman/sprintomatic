import { useState } from 'react';
import type { ApiStandupEntry, ApiWrap } from '../lib/api';

/** The card never shows before this local hour. */
const QUIET_AFTER_HOUR = 14;
/** Minutes without session activity that count as "work went quiet". */
const QUIET_GAP_MINUTES = 60;

const DISMISS_KEY = 'sh.wrap.dismissed';

/**
 * The quiet rule. Lives on the client because the payload is cached — the
 * server ships facts (isWorkingDay, lastActivityAt) and the always-fresh
 * client clock decides, so the card appears on time, not up to a cache
 * interval late.
 */
export function wrapVisible(opts: {
  now: Date;
  isWorkingDay: boolean;
  lastActivityAt: string | null;
  workedToday: boolean;
}): boolean {
  if (!opts.isWorkingDay || !opts.workedToday || opts.lastActivityAt == null) return false;
  if (opts.now.getHours() < QUIET_AFTER_HOUR) return false;
  const gapMinutes = (opts.now.getTime() - Date.parse(opts.lastActivityAt)) / 60_000;
  return gapMinutes >= QUIET_GAP_MINUTES;
}

function localISODate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** `**title** (#id)` → `title`; bare `#id` stays as-is. */
function plainTitle(displayName: string): string {
  const m = /^\*\*(.+)\*\* \(#\d+\)$/.exec(displayName);
  return m ? m[1] : displayName;
}

function minutesLabel(min: number): string {
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  const rest = min % 60;
  return rest === 0 ? `${h}h` : `${h}h ${rest}m`;
}

function runningFor(startedAt: string, now: Date): string {
  return minutesLabel(Math.max(0, Math.round((now.getTime() - Date.parse(startedAt)) / 60_000)));
}

export function WrapCard({
  wrap,
  standupToday,
  now,
  onOpenItem,
}: {
  wrap: ApiWrap | undefined;
  standupToday: ApiStandupEntry[];
  now: Date;
  onOpenItem: (id: string) => void;
}) {
  const [dismissedOn, setDismissedOn] = useState<string | null>(() => {
    try {
      return localStorage.getItem(DISMISS_KEY);
    } catch {
      return null;
    }
  });

  // Older server payloads don't carry the wrap block — render nothing, never crash.
  if (!wrap) return null;

  const todayKey = localISODate(now);
  if (dismissedOn === todayKey) return null;
  if (
    !wrapVisible({
      now,
      isWorkingDay: wrap.isWorkingDay,
      lastActivityAt: wrap.lastActivityAt,
      workedToday: standupToday.length > 0,
    })
  ) {
    return null;
  }

  const dismiss = () => {
    try {
      localStorage.setItem(DISMISS_KEY, todayKey);
    } catch {
      /* private-mode storage failure — dismiss still works for this render */
    }
    setDismissedOn(todayKey);
  };

  return (
    <section className="wrap-card" aria-label="End of day">
      <div className="wrap-head">
        <h2 className="wrap-title">Wrapping up the day</h2>
        <button type="button" className="wrap-dismiss" onClick={dismiss} title="Hide until tomorrow">
          ✕
        </button>
      </div>

      <h3 className="wrap-sec-h">What today gave</h3>
      <ul className="wrap-list">
        {standupToday.map(e => (
          <li key={e.workItemId} className="wrap-row">
            <span className="wrap-row-title">{plainTitle(e.displayName)}</span>
            {e.minutesInWindow != null && (
              <span className="wrap-row-meta">{minutesLabel(e.minutesInWindow)}</span>
            )}
            {e.summary && <p className="wrap-row-summary">{e.summary}</p>}
          </li>
        ))}
      </ul>

      <h3 className="wrap-sec-h">Still open</h3>
      {wrap.stillOpen.length === 0 ? (
        <p className="wrap-clean">Everything closed. Clean end.</p>
      ) : (
        <ul className="wrap-list">
          {wrap.stillOpen.map(s => (
            <li key={s.workItemId} className="wrap-row is-open">
              <button
                type="button"
                className="wrap-row-link"
                onClick={() => onOpenItem(String(s.workItemId))}
              >
                {plainTitle(s.displayName)}
              </button>
              <span className="wrap-row-meta">running {runningFor(s.startedAt, now)}</span>
            </li>
          ))}
        </ul>
      )}

      <h3 className="wrap-sec-h">Tomorrow's first move</h3>
      {wrap.firstMove == null ? (
        <p className="wrap-clean">Nothing carried over — pick fresh tomorrow.</p>
      ) : (
        <p className="wrap-first">
          Pick up{' '}
          <button
            type="button"
            className="wrap-row-link"
            onClick={() => onOpenItem(String(wrap.firstMove!.workItemId))}
          >
            {plainTitle(wrap.firstMove.displayName)}
          </button>
          {wrap.firstMove.remainingHours != null && <> — about {wrap.firstMove.remainingHours}h left</>}
          .
        </p>
      )}
    </section>
  );
}
