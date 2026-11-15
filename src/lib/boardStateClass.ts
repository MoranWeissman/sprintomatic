import { classifyBoardState } from '../../server/states';

/** The four words the dashboard's CSS and copy use for a board state. */
export type BoardStateClass = 'going' | 'waiting' | 'done' | 'blocked';

/**
 * Turn a raw Azure DevOps state name into the word the screen uses for it.
 *
 * The rule itself lives in one place, `server/states.ts`. This is only the
 * translation into the front end's vocabulary: the shared module says
 * `'active'`, every stylesheet and label here says `'going'`.
 *
 * Blocked wins over done, because the shared module checks blocked first. An
 * item sitting in `Blocked` must never read as finished.
 *
 * The `'unknown'` fallback: a state name we have never seen comes back here as
 * `'waiting'`. That is on purpose, and it is what the screen has always done.
 * It is also a small lie — the board did not say the item is waiting, we just
 * had nowhere else to put it. Fixing it properly means giving the UI a fifth
 * look for "we don't know", which is a design call, not a cleanup. Until then
 * the fallback stays, written down here once instead of guessed at three
 * times.
 */
export function boardStateClass(state: string | null | undefined): BoardStateClass {
  const kind = classifyBoardState(state);
  if (kind === 'active') return 'going';
  if (kind === 'unknown') return 'waiting';
  return kind;
}

/** The plain word Daily shows for each state, so D&D says the same thing. */
const STATE_WORD: Record<BoardStateClass, string> = {
  going: 'in work',
  waiting: 'not started',
  blocked: 'stuck',
  done: 'done',
};

/**
 * A raw board state as the plain word the screens use, e.g. 'Closed' → 'done'.
 * A state we have never seen keeps the board's own word: saying 'not started'
 * there would be a status the board never gave.
 */
export function boardStateWord(state: string | null | undefined): string {
  if (classifyBoardState(state) === 'unknown' && state && state.trim()) return state;
  return STATE_WORD[boardStateClass(state)];
}
