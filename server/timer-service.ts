/**
 * Timer service — the local stopwatch plus the "close this task on the board"
 * move. The Vite API endpoints and the MCP server both call into this layer.
 */
import {
  getTimerSnapshot,
  pauseTimer,
  recordFailedSync,
  startTimer,
  type TimerSnapshot,
} from './timers';
import { setCompletedWork, setRemaining, setStateBucket } from './writes';

export interface TimerActionResult {
  snapshot: TimerSnapshot;
  /** What we just did, for the client to render confirmation. */
  action: 'started' | 'already_running' | 'paused' | 'not_running';
}

export function start(workItemId: number): TimerActionResult {
  const before = getTimerSnapshot(workItemId);
  if (before.running) return { snapshot: before, action: 'already_running' };
  startTimer(workItemId);
  return { snapshot: getTimerSnapshot(workItemId), action: 'started' };
}

export function pause(workItemId: number): TimerActionResult {
  const before = getTimerSnapshot(workItemId);
  if (!before.running) return { snapshot: before, action: 'not_running' };
  pauseTimer(workItemId);
  return { snapshot: getTimerSnapshot(workItemId), action: 'paused' };
}

/* ============================================================ */
/*  Closing a task on the board                                  */
/* ============================================================ */

/**
 * The three writes that finish a task, in the order they run. Each one is a
 * separate call to Azure DevOps, so they can't be undone as a group — if one
 * fails we stop there and say exactly which ones got through.
 */
export type BoardCloseStep = 'completedHours' | 'remainingHours' | 'state';

/** How each write reads out loud, for the message the user hears. */
const STEP_WORDS: Record<BoardCloseStep, string> = {
  completedHours: 'the hours you spent',
  remainingHours: 'the hours left',
  state: "the task's state",
};

const STEP_ORDER: BoardCloseStep[] = ['completedHours', 'remainingHours', 'state'];

/** Which queue a failed write belongs to. */
const STEP_KIND: Record<BoardCloseStep, 'effort' | 'state'> = {
  completedHours: 'effort',
  remainingHours: 'effort',
  state: 'state',
};

export interface BoardCloseDeps {
  setCompletedWork: (workItemId: number, hours: number) => Promise<void>;
  setRemaining: (workItemId: number, hours: number) => Promise<void>;
  setStateBucket: (workItemId: number, bucket: 'done') => Promise<string>;
  /** Note a write that never got through, so it can be counted later. */
  recordFailure: (
    workItemId: number,
    kind: 'effort' | 'state',
    payload: unknown,
    error: string,
  ) => void;
}

export interface BoardCloseResult {
  /** True only when all three writes got through. */
  ok: boolean;
  landed: BoardCloseStep[];
  /** The write that failed, when one did. */
  failedStep?: BoardCloseStep;
  /** What the board said when it refused. */
  error?: string;
  /** The state name the board reports after a good close. */
  newState?: string;
  /** Plain-English read-out, set only when something failed. */
  message?: string;
}

function joinWords(parts: string[]): string {
  if (parts.length === 1) return parts[0];
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

function buildFailureMessage(
  landed: BoardCloseStep[],
  failedStep: BoardCloseStep,
  error: string,
): string {
  const missing = STEP_ORDER.filter(s => !landed.includes(s));
  const missingWords = joinWords(missing.map(s => STEP_WORDS[s]));
  const opening =
    landed.length === 0
      ? `Nothing reached the board: ${missingWords} were all left as they were.`
      : `On the board, ${joinWords(landed.map(s => STEP_WORDS[s]))} went through, but ${missingWords} did not.`;
  return [
    'The task was NOT closed.',
    opening,
    `What went wrong on "${STEP_WORDS[failedStep]}": ${error}`,
    'Nothing was lost here — the session is still open and the clock is still running, so you can try again.',
    'Tell the user in plain words which parts went through and which did not, and name the task by its title rather than its number.',
    'When he says go, call session_end again with the same numbers. Running it again is safe: the parts that already went through are simply written again with the same values.',
  ].join(' ');
}

/**
 * Push the three "this task is finished" values to the board, in order, and
 * stop at the first one that fails.
 *
 * The board writes deliberately run BEFORE the local session is closed. If
 * something goes wrong halfway, the session stays open and the user can just
 * ask to close it again — much better than a closed session with a board that
 * only half agrees.
 */
export async function closeTaskOnBoard(
  { workItemId, completedHours }: { workItemId: number; completedHours: number },
  deps: Partial<BoardCloseDeps> = {},
): Promise<BoardCloseResult> {
  const d: BoardCloseDeps = {
    setCompletedWork,
    setRemaining,
    setStateBucket,
    recordFailure: recordFailedSync,
    ...deps,
  };

  const landed: BoardCloseStep[] = [];
  let newState: string | undefined;

  const run = async (step: BoardCloseStep): Promise<BoardCloseResult | null> => {
    try {
      if (step === 'completedHours') await d.setCompletedWork(workItemId, completedHours);
      else if (step === 'remainingHours') await d.setRemaining(workItemId, 0);
      else newState = await d.setStateBucket(workItemId, 'done');
      landed.push(step);
      return null;
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      const payload =
        step === 'completedHours'
          ? { completedHours }
          : step === 'remainingHours'
            ? { remainingHours: 0 }
            : { target: 'done' };
      d.recordFailure(workItemId, STEP_KIND[step], payload, error);
      return {
        ok: false,
        landed,
        failedStep: step,
        error,
        message: buildFailureMessage(landed, step, error),
      };
    }
  };

  for (const step of STEP_ORDER) {
    const failure = await run(step);
    if (failure) return failure;
  }
  return { ok: true, landed, newState };
}

/* ============================================================ */
/*  Closing the local session                                    */
/* ============================================================ */

export type CloseAttempt = 'not-found' | 'already-closed' | 'go';

/**
 * Should we try to close this session? Asked before anything is written, so
 * that asking twice never pushes the same hours to the board twice.
 *
 * A close that failed halfway leaves the session OPEN, so 'go' is still the
 * answer on a retry — which is exactly what makes the retry work.
 */
export function decideCloseAttempt(session: { endedAt: string | null } | null): CloseAttempt {
  if (!session) return 'not-found';
  return session.endedAt == null ? 'go' : 'already-closed';
}
