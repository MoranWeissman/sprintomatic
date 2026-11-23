/**
 * When every task of a story is closed, the story closes too. The user's
 * rule, no asking.
 *
 * Two doors use this: closing a task (session_end done, task_close, the
 * dashboard) checks the task's parent, and orient sweeps the user's open
 * stories for ones whose tasks were all closed some other way (by hand on the
 * board). Each closed story comes back as one sentence for the chat to echo.
 *
 * A story closes only when it is a User Story or Bug, is not started or in
 * work (never Blocked, never a testing state the team uses after the tasks),
 * has no open tasks, and at least one task was really done. Removed tasks
 * don't count either way. A failed close never fails the task close: it
 * comes back as a sentence that says the story is still open and why.
 */
import { getWorkItem, getWorkItemsByIds, listMyOpenStoriesEverywhere, type WorkItemRef } from './ado';
import { invalidateDashboardCache } from './dashboard-cache';
import { listDesignMeetings, readDesignDoc } from './design-store';
import { designGateMessage, isDesignStoryTitle } from './design';
import { discoveryCloseBlockMessage, discoveryFinishedCheck, isDiscoveryStoryTitle } from './discovery';
import { readDiscoveryDoc } from './discovery-store';
import { displayNameFor } from './display-name';
import { classifyBoardState, isDoneState, isRemovedState } from './states';
import { getActiveFeature } from './workspace';
import { setStateBucket } from './writes';

type Child = Pick<WorkItemRef, 'type' | 'state'>;

export interface StoryLike {
  id: number;
  title: string;
  type: string;
  state: string;
  parent?: { id: number } | null;
  children: Child[];
}

/** Whether this story should close now. Pure. */
export function shouldAutoClose(story: Pick<StoryLike, 'type' | 'state' | 'children'>): boolean {
  const type = story.type.toLowerCase();
  if (type !== 'user story' && type !== 'bug') return false;
  const kind = classifyBoardState(story.state);
  if (kind !== 'active' && kind !== 'waiting') return false;
  const tasks = story.children.filter(c => c.type.toLowerCase() === 'task');
  if (tasks.some(c => !isDoneState(c.state))) return false;
  return tasks.some(c => isDoneState(c.state) && !isRemovedState(c.state));
}

/**
 * The discovery and design stories have their own rules before they close
 * (a finished discovery; an agreed, reviewed and pushed design). Null when
 * the story may close. story_close uses the same check.
 */
export function storyCloseGate(story: Pick<StoryLike, 'title' | 'parent'>): string | null {
  const active = getActiveFeature();
  if (!active || story.parent?.id !== active.id) return null;
  if (isDiscoveryStoryTitle(story.title)) {
    return discoveryCloseBlockMessage({
      isDiscoveryStory: true,
      folderPath: active.folderPath,
      check: discoveryFinishedCheck(readDiscoveryDoc(active.folderPath)),
    });
  }
  if (isDesignStoryTitle(story.title)) {
    return designGateMessage({
      isDesignStory: true,
      doc: readDesignDoc(active.folderPath),
      meetingCount: listDesignMeetings(active.folderPath).length,
    });
  }
  return null;
}

export interface AutoCloseDeps {
  getItem: (id: number) => Promise<StoryLike>;
  closeStory: (id: number) => Promise<unknown>;
  gate: (story: StoryLike) => string | null;
  /** The user's open stories in any sprint, with their tasks. Only for orient's sweep. */
  listOpenStories: () => Promise<StoryLike[]>;
}

/** Every open story of the user's, anywhere, with each child's type and state.
 *  A story whose children the board didn't all return is left out: a missing
 *  child could be an open task, and we don't guess. */
async function listOpenStories(): Promise<StoryLike[]> {
  const stories = await listMyOpenStoriesEverywhere();
  const kids = await getWorkItemsByIds([...new Set(stories.flatMap(s => s.childIds))]);
  const byId = new Map(kids.map(k => [Number(k.id), k]));
  return stories.flatMap(s => {
    const children = s.childIds.flatMap(id => {
      const k = byId.get(id);
      return k ? [{ type: k.type, state: k.state }] : [];
    });
    if (children.length !== s.childIds.length) return [];
    return [{
      id: Number(s.id), title: s.title, type: s.type, state: s.state,
      parent: s.parentId != null ? { id: s.parentId } : null,
      children,
    }];
  });
}

const realDeps: AutoCloseDeps = {
  getItem: id => getWorkItem(id),
  closeStory: id => setStateBucket(id, 'done'),
  gate: storyCloseGate,
  listOpenStories,
};

/** Close one story that passed shouldAutoClose. Returns the sentence. */
async function closeOne(story: StoryLike, deps: AutoCloseDeps, closedLine: string): Promise<string> {
  const name = displayNameFor(story.id, story.title);
  const gate = deps.gate(story);
  if (gate) return `All tasks of ${name} are done, but it stays open: ${gate}`;
  try {
    await deps.closeStory(story.id);
    invalidateDashboardCache();
    return closedLine.replace('<name>', name);
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    return `All tasks of ${name} are done, but closing it on the board failed, so it is still open: ${why}`;
  }
}

/**
 * After a task closed: close its parent story when that was the last open
 * task. Returns the sentence to echo, or null when there is nothing to say.
 * Never throws.
 */
export async function autoCloseParentStory(taskId: number, deps: AutoCloseDeps = realDeps): Promise<string | null> {
  try {
    const task = await deps.getItem(taskId);
    const parentId = task.parent?.id;
    if (parentId == null) return null;
    const story = await deps.getItem(parentId);
    if (!shouldAutoClose(story)) return null;
    return await closeOne(story, deps, 'All tasks are done, so I closed <name> too.');
  } catch {
    return null;
  }
}

/**
 * Orient's sweep: the user's open stories anywhere whose tasks are all
 * closed already (often by hand on the board). One sentence per story.
 * Never throws; a failed read means no lines.
 */
export async function sweepFinishedStories(deps: AutoCloseDeps = realDeps): Promise<string[]> {
  try {
    const lines: string[] = [];
    for (const story of await deps.listOpenStories()) {
      if (!shouldAutoClose(story)) continue;
      // A discovery or design story held open by its own rules is not news
      // at every greeting; its own tools say what is missing.
      if (deps.gate(story)) continue;
      lines.push(await closeOne(story, deps, 'All tasks of <name> were done, so I closed it.'));
    }
    return lines;
  } catch {
    return [];
  }
}
