/**
 * Iteration-path classification — pure, dependency-free.
 *
 * Lives in its own leaf module (no imports) so any module can classify an
 * Azure DevOps iteration path without pulling in the planning cockpit or the
 * dashboard. Keeping it here avoids a module cycle: both `planning-cockpit`
 * and `dashboard` need these rules, and `planning-cockpit` is downstream of
 * `dashboard-cache` which is downstream of `dashboard`.
 */

export type BacklogLevel = 'year' | 'quarter' | 'backlog';

/**
 * Classify a work item's iteration path as backlog vs sprint.
 *
 * the user's tree shape (verified 2026-06-03 from the iteration picker):
 *   MyProject                       → backlog (area root, no year)
 *   MyProject\Backlog               → backlog (literal segment)
 *   MyProject\2026                  → year
 *   MyProject\2026\Q1               → quarter
 *   MyProject\2026\Q1\26_03         → sprint (anything below quarter)
 *
 * Returns null if the path is empty/unparseable.
 */
export function classifyIterationLevel(path: string): BacklogLevel | 'sprint' | null {
  if (!path) return null;
  const segments = path.split('\\').filter(Boolean);
  if (segments.length === 0) return null;

  // Any segment literally named "Backlog" → backlog (top wins).
  if (segments.some(s => /^backlog$/i.test(s))) return 'backlog';

  // Single segment = just the area root, no year/quarter chosen → backlog.
  if (segments.length === 1) return 'backlog';

  const last = segments[segments.length - 1];

  // Last segment is a 4-digit year → year-level bucket.
  if (/^\d{4}$/.test(last)) return 'year';

  // Last segment is Q1..Q4 → quarter-level bucket.
  if (/^Q\d+$/i.test(last)) return 'quarter';

  // Anything else (a named sprint like 26_11) is a concrete sprint.
  return 'sprint';
}

export function isSprintLevel(path: string): boolean {
  return classifyIterationLevel(path) === 'sprint';
}

/**
 * Where a NEW Feature goes: the backlog level sitting above the current sprint.
 *
 * A Feature spans sprints, so pinning it to one is misleading — and moving it
 * out later is awkward, because a started item can't leave a finished sprint.
 * Read off the real board on 2026-08-11: of the 15 most recently changed
 * Features, 11 sit at quarter, year, or project-root level and only 4 are in a
 * named sprint. So climbing one level from the sprint (`...\2026\Q3\26_16` →
 * `...\2026\Q3`) matches how the board is actually used.
 *
 * Falls back to `projectRoot` whenever we can't be sure: no current sprint, no
 * parent to climb to, or a parent that still doesn't classify as a backlog
 * level. Guessing a path is worse than putting the Feature somewhere plainly
 * correct.
 */
export function backlogPathForNewFeature(
  currentSprintPath: string | null,
  projectRoot: string,
): string {
  if (!currentSprintPath) return projectRoot;
  const segments = currentSprintPath.split('\\').filter(Boolean);
  if (segments.length < 2) return projectRoot;
  const parent = segments.slice(0, -1).join('\\');
  const level = classifyIterationLevel(parent);
  return level === 'year' || level === 'quarter' || level === 'backlog' ? parent : projectRoot;
}

export interface IterationLite {
  path: string;
  finishDate: string;
}

/**
 * True when `iterationPath` is a sprint-level path whose finish date is
 * strictly before the start of `now`'s day — i.e. a sprint that has already
 * ended. Backlog/year/quarter paths and paths not found in the list return
 * false (they aren't a finished sprint). Pure — the caller supplies the
 * iteration list, so this is testable without ADO.
 *
 * Used to protect a finished sprint's planned-vs-completed record: a started
 * story can't be moved OUT of a past sprint (only its tasks carry forward),
 * but it can move freely out of the backlog, the current, or a future sprint.
 */
export function classifyPastSprint(
  iterations: IterationLite[],
  iterationPath: string,
  now: Date,
): boolean {
  if (!isSprintLevel(iterationPath)) return false;
  const match = iterations.find(it => it.path === iterationPath);
  if (!match) return false;
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  return new Date(match.finishDate).getTime() < startOfToday.getTime();
}
