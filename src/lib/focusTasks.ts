/**
 * The task rows one Focus panel works with.
 *
 * A panel is built from two things: the live task (from the open session) and
 * the parent story group (from the sprint query). Those two can disagree — a
 * story can sit in the sprint while its tasks sit in the backlog, and then the
 * story group arrives with a `tasks` list that doesn't contain the live task
 * at all.
 *
 * When that happened, clicking "Currently running" set the drill-in id, the
 * panel looked the task up inside `story.tasks`, found nothing, and re-rendered
 * exactly the same screen. A dead click with no message.
 *
 * So the live task is always in this list. Ids are compared as strings because
 * the two sources don't agree on number vs string.
 */
export function focusPanelTasks<T extends { id: string }>(liveTask: T, storyTasks: T[]): T[] {
  const liveId = String(liveTask.id);
  if (storyTasks.some(t => String(t.id) === liveId)) return storyTasks;
  return [liveTask, ...storyTasks];
}
