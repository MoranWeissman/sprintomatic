/**
 * The speed bump for working on a task that is not in the current sprint.
 *
 * Work and closes on a task that sits somewhere else (an old sprint, a
 * quarter like "Q3", the backlog) land where no sprint board shows them. So
 * session_start and the closing session_end stop and ask first, unless the
 * caller says the user is fine with it. Pure — the caller reads the board.
 */
import { iterationShortName, sameIterationPath } from './iteration-paths';

export function outsideSprintRefusal(args: {
  displayName: string;
  itemPath: string;
  /** The current sprint, or null when the board didn't say — then never refuse. */
  sprint: { name: string; path: string } | null;
  action: 'start' | 'close';
}): string | null {
  const { displayName, itemPath, sprint, action } = args;
  if (!sprint || !itemPath || sameIterationPath(itemPath, sprint.path)) return null;
  const where = iterationShortName(itemPath);
  const move = `move the task into this sprint first (workitem_edit with iterationPath "${sprint.name}")`;
  if (action === 'start') {
    return `${displayName} sits in ${where} (${itemPath}), not in the current sprint ${sprint.name}. Work logged on it won't show on this sprint's board. Ask the user which they want: ${move}, or work on it where it is (call session_start again with outsideSprintOk: true). Nothing was started.`;
  }
  return `${displayName} sits in ${where} (${itemPath}), not in the current sprint ${sprint.name}. Closing it there puts its hours where this sprint's board won't show them. Ask the user which they want: ${move} and then close it, or close it where it is (call session_end again with outsideSprintOk: true). Nothing was written to Azure DevOps and the session is still open.`;
}
