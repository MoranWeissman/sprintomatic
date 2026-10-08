/**
 * ADO write operations — push local effort to System.CompletedWork and
 * transition state to Done/Closed.
 *
 * Single-user tool, so we don't bother with optimistic concurrency tokens;
 * a GET-then-PATCH race is vanishingly unlikely in practice. If the PATCH
 * fails, the caller queues a pending_changes row for retry.
 */
import { loadAdoConfig } from './config';
import { getAdoClient } from './ado-client';
import { listAllIterations } from './ado';
import { classifyPastSprint, backlogPathForNewFeature } from './iteration-paths';
import { deleteSetting, getSetting, setSetting } from './timers';
import { deriveStoryPoints } from './story-points';
import { getWorkdayHours } from './user-config';
import { isBlockedState } from './states';

/**
 * State buckets the UI exposes (waiting / going / done) → ordered list of
 * candidate ADO state names. Different process templates use different names
 * (Agile = Closed, Scrum = Done, CMMI = Resolved). We try each in order and
 * persist the one that worked per bucket in settings.
 */
export const STATE_BUCKET_CHAIN = {
  waiting: ['New', 'To Do', 'Proposed'],
  going:   ['Active', 'In Progress', 'Doing', 'Committed'],
  blocked: ['Blocked', 'On Hold'],
  done:    ['Closed', 'Done', 'Resolved', 'Completed'],
} as const;
export type StateBucket = keyof typeof STATE_BUCKET_CHAIN;

interface AdoWorkItemSlim {
  id: number;
  rev: number;
  fields: {
    'Microsoft.VSTS.Scheduling.CompletedWork'?: number;
    'Microsoft.VSTS.Scheduling.RemainingWork'?: number;
    'System.State'?: string;
    'System.Tags'?: string;
  };
}

/**
 * Fetch the current completedWork value so we can compute the new total.
 * Cheaper than a full work item read because we limit fields.
 */
async function fetchEffortFields(id: number): Promise<AdoWorkItemSlim> {
  const cfg = await loadAdoConfig();
  const fields = [
    'Microsoft.VSTS.Scheduling.CompletedWork',
    'Microsoft.VSTS.Scheduling.RemainingWork',
    'System.State',
    'System.Tags',
  ].join(',');
  const uri = `${cfg.organization}/${encodeURIComponent(cfg.project)}/_apis/wit/workitems/${id}?fields=${encodeURIComponent(fields)}&api-version=7.1`;
  return getAdoClient().rest<AdoWorkItemSlim>({ method: 'GET', uri });
}

/** Parse ADO's "tag1; tag2; tag3" string into a clean lowercased Set. */
function parseTags(raw: string | undefined): Set<string> {
  if (!raw) return new Set();
  return new Set(
    raw
      .split(';')
      .map(t => t.trim())
      .filter(t => t.length > 0),
  );
}

/**
 * Mutate the System.Tags field. Tags are case-sensitive in ADO display but
 * case-insensitive in dedup. `add` and `remove` may overlap; remove wins.
 * Returns the resulting tag list (in canonical order).
 */
export async function updateTags(
  workItemId: number,
  opts: { add?: string[]; remove?: string[] },
): Promise<string[]> {
  const current = await fetchEffortFields(workItemId);
  const tagSet = parseTags(current.fields['System.Tags']);
  // Case-insensitive lookups so we don't dup "Blocked" + "blocked".
  const lowerToCanonical = new Map<string, string>();
  for (const t of tagSet) lowerToCanonical.set(t.toLowerCase(), t);

  for (const t of opts.add ?? []) {
    const lower = t.trim().toLowerCase();
    if (!lower) continue;
    if (!lowerToCanonical.has(lower)) lowerToCanonical.set(lower, t.trim());
  }
  for (const t of opts.remove ?? []) {
    const lower = t.trim().toLowerCase();
    lowerToCanonical.delete(lower);
  }

  const final = Array.from(lowerToCanonical.values()).sort((a, b) => a.localeCompare(b));
  await applyTagsPatch(workItemId, final);

  // Read-back verify. ADO silently drops `{op:'add', value:''}` against
  // System.Tags on some instances, leaving the previous tag set in place.
  // Without this check we'd return `final` as if the patch landed, and the
  // caller (e.g. workitem_unblock) would report success while the live board
  // still carries the old tag.
  const after = await fetchEffortFields(workItemId);
  const actual = Array.from(parseTags(after.fields['System.Tags'])).sort((a, b) =>
    a.localeCompare(b),
  );
  if (!tagListsEqual(final, actual)) {
    throw new Error(
      `Tag patch did not land on Azure DevOps. Intended: [${final.join(', ') || '(none)'}]. ` +
        `Actual after patch: [${actual.join(', ') || '(none)'}]. ` +
        `The PATCH returned 200 but the field was not updated — known ADO quirk on tag ` +
        `clears. Any state change in the same flow already landed; the tag is stale. ` +
        `Retry, or clear the tag manually on the work item.`,
    );
  }
  return actual;
}

async function applyTagsPatch(workItemId: number, finalTags: string[]): Promise<void> {
  if (finalTags.length === 0) {
    // ADO drops `{op:'add', value:''}` on System.Tags. `op:'remove'` clears
    // the field reliably across process templates.
    await patchWorkItem(workItemId, [
      { op: 'remove', path: '/fields/System.Tags' },
    ]);
  } else {
    await patchWorkItem(workItemId, [
      { op: 'add', path: '/fields/System.Tags', value: finalTags.join('; ') },
    ]);
  }
}

function tagListsEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const aLower = a.map(t => t.toLowerCase()).sort();
  const bLower = b.map(t => t.toLowerCase()).sort();
  return aLower.every((t, i) => t === bLower[i]);
}

/**
 * Push local-logged seconds to ADO as additional CompletedWork.
 * Decrements RemainingWork by the same amount (floored at 0).
 *
 * Returns the new ADO state so the caller can decide what to do next.
 */
export async function pushCompletedWork(
  workItemId: number,
  addSeconds: number,
): Promise<{ newCompletedHours: number; newRemainingHours: number }> {
  const current = await fetchEffortFields(workItemId);
  const currentCompleted = current.fields['Microsoft.VSTS.Scheduling.CompletedWork'] ?? 0;
  const currentRemaining = current.fields['Microsoft.VSTS.Scheduling.RemainingWork'] ?? 0;

  const addHours = addSeconds / 3600;
  const newCompleted = round2(currentCompleted + addHours);
  const newRemaining = Math.max(0, round2(currentRemaining - addHours));

  const patch = [
    { op: 'add', path: '/fields/Microsoft.VSTS.Scheduling.CompletedWork', value: newCompleted },
    { op: 'add', path: '/fields/Microsoft.VSTS.Scheduling.RemainingWork', value: newRemaining },
  ];
  await patchWorkItem(workItemId, patch);
  return { newCompletedHours: newCompleted, newRemainingHours: newRemaining };
}

const DONE_STATES_LOWER = new Set(STATE_BUCKET_CHAIN.done.map(s => s.toLowerCase()));
function isDoneStateName(state: string): boolean {
  return DONE_STATES_LOWER.has(state.toLowerCase());
}

/**
 * Transition an item to a target bucket (waiting / going / done). Tries the
 * previously-successful state name first, then walks the chain. Persists what
 * worked.
 *
 * Side effect — crossing the done boundary preserves effort fields:
 *   - going → done: capture current RemainingWork into a setting so a future
 *     reopen can restore it. If CompletedWork is empty, default it to that
 *     same RemainingWork ("you used what was left") and remember the auto-fill
 *     amount so the reopen path can roll it back.
 *   - done → going/waiting/blocked: restore the captured RemainingWork and
 *     subtract the auto-fill from CompletedWork.
 *
 * Explicit writes via workitem_edit's remainingWork / completedWork still win
 * because they happen in a separate call — the auto-fill only fires when
 * CompletedWork was 0 at the moment of close.
 */
export async function setStateBucket(
  workItemId: number,
  bucket: StateBucket,
): Promise<string> {
  // Read prior state + effort BEFORE the transition so we can decide whether
  // to preserve. One ADO GET per state change is acceptable.
  let beforeRemaining = 0;
  let beforeCompleted = 0;
  let wasDone = false;
  try {
    const before = await fetchEffortFields(workItemId);
    beforeRemaining = before.fields['Microsoft.VSTS.Scheduling.RemainingWork'] ?? 0;
    beforeCompleted = before.fields['Microsoft.VSTS.Scheduling.CompletedWork'] ?? 0;
    wasDone = isDoneStateName(before.fields['System.State'] ?? '');
  } catch {
    // If the read fails, fall through — state transition is more important
    // than effort preservation. The auto-fill / restore just won't fire.
  }

  const settingKey = `state_${bucket}`;
  const preferred = getSetting(settingKey);
  const chain: string[] = preferred
    ? [preferred, ...STATE_BUCKET_CHAIN[bucket].filter(s => s !== preferred)]
    : [...STATE_BUCKET_CHAIN[bucket]];

  let resolvedState: string | null = null;
  let lastErr: Error | null = null;
  for (const state of chain) {
    try {
      await patchWorkItem(workItemId, [
        { op: 'add', path: '/fields/System.State', value: state },
      ]);
      if (state !== preferred) setSetting(settingKey, state);
      resolvedState = state;
      break;
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
      const msg = lastErr.message.toLowerCase();
      if (
        !msg.includes('valid state') &&
        !msg.includes('transition') &&
        !msg.includes('not allowed') &&
        !msg.includes('invalid')
      ) {
        throw lastErr;
      }
    }
  }
  if (resolvedState == null) {
    throw lastErr ?? new Error(`Could not transition to any ${bucket} state.`);
  }

  const goingToDone = bucket === 'done' && !wasDone;
  const leavingDone = wasDone && bucket !== 'done';

  if (goingToDone) {
    if (beforeRemaining > 0) {
      setSetting(`remaining_prior_to_close_${workItemId}`, String(beforeRemaining));
    }
    if (beforeCompleted === 0 && beforeRemaining > 0) {
      try {
        await setCompletedWork(workItemId, beforeRemaining);
        setSetting(`completed_auto_filled_${workItemId}`, String(beforeRemaining));
      } catch {
        deleteSetting(`completed_auto_filled_${workItemId}`);
      }
    } else {
      deleteSetting(`completed_auto_filled_${workItemId}`);
    }
  }

  if (leavingDone) {
    const restoreR = Number(getSetting(`remaining_prior_to_close_${workItemId}`) ?? '0');
    if (restoreR > 0) {
      try {
        await setRemaining(workItemId, restoreR);
      } catch {
        // Best-effort; leave the setting alone so a retry can restore later.
      }
    }
    deleteSetting(`remaining_prior_to_close_${workItemId}`);
    const filledC = Number(getSetting(`completed_auto_filled_${workItemId}`) ?? '0');
    if (filledC > 0) {
      try {
        const afterFields = await fetchEffortFields(workItemId);
        const currentC = afterFields.fields['Microsoft.VSTS.Scheduling.CompletedWork'] ?? 0;
        const adjusted = Math.max(0, currentC - filledC);
        await setCompletedWork(workItemId, adjusted);
      } catch {
        // Best-effort.
      }
    }
    deleteSetting(`completed_auto_filled_${workItemId}`);
  }

  return resolvedState;
}

export interface BlockResult {
  fromState: string;
  toState: string;
  /** True when the item was already blocked and nothing was written. */
  alreadyBlocked: boolean;
  /** Plain English, safe to show the user as-is. */
  message: string;
}

/**
 * Transition to the "blocked" bucket (e.g. ADO "Blocked" or "On Hold" depending
 * on type/process). Remembers the state it came from so unblock can put it back.
 *
 * Blocking something that is already blocked is a no-op, not an error — a
 * person repeating themselves. It keeps the state we remembered the first time
 * (overwriting it with "Blocked" would make unblock put the item back on
 * Blocked, leaving it stuck for good), and it writes nothing to the board, so
 * the caller has nothing to hang a second discussion comment off.
 */
export async function transitionToBlocked(workItemId: number): Promise<BlockResult> {
  const current = await fetchEffortFields(workItemId);
  const fromState = current.fields['System.State'] ?? '';

  if (isBlockedState(fromState)) {
    return {
      fromState,
      toState: fromState,
      alreadyBlocked: true,
      message: 'This one was already marked blocked, so nothing changed on the board.',
    };
  }

  const toState = await setStateBucket(workItemId, 'blocked');
  setSetting(`blocked_prior_state_${workItemId}`, fromState);
  return {
    fromState,
    toState,
    alreadyBlocked: false,
    message: `Marked blocked. It was ${fromState || 'on an unknown state'} before.`,
  };
}

/** What happened when we tried to clear a block. */
export type UnblockOutcome = 'restored' | 'was-not-blocked' | 'prior-state-unknown';

export interface UnblockResult {
  /** The state the item is on now. */
  toState: string;
  /** True only when we put it back on the state it came from. */
  restored: boolean;
  outcome: UnblockOutcome;
  /** Plain English, safe to show the user as-is. */
  message: string;
}

/**
 * Transition out of "blocked" back to the state the item came from.
 *
 * Two cases where we write nothing and say so instead:
 *   - the item is not blocked (someone cleared it on the board, or the user
 *     said it twice) — there is nothing to undo;
 *   - it is blocked but we never wrote down where it came from (blocked before
 *     this feature existed, or the record was lost). We do not put it on a
 *     made-up state; we hand the question back to the caller.
 */
export async function transitionFromBlocked(workItemId: number): Promise<UnblockResult> {
  const current = await fetchEffortFields(workItemId);
  const nowState = current.fields['System.State'] ?? '';

  if (!isBlockedState(nowState)) {
    return {
      toState: nowState,
      restored: false,
      outcome: 'was-not-blocked',
      message: nowState
        ? `This one is not blocked — it is on ${nowState}. Nothing to clear.`
        : 'This one is not blocked. Nothing to clear.',
    };
  }

  const prior = getSetting(`blocked_prior_state_${workItemId}`);
  if (prior && !isBlockedState(prior)) {
    try {
      await patchWorkItem(workItemId, [
        { op: 'add', path: '/fields/System.State', value: prior },
      ]);
      deleteSetting(`blocked_prior_state_${workItemId}`);
      return {
        toState: prior,
        restored: true,
        outcome: 'restored',
        message: `Block cleared. Put back on ${prior}.`,
      };
    } catch {
      // The old state name does not apply anymore (the process changed, the
      // item changed type). We do not guess a replacement.
    }
  }

  return {
    toState: nowState,
    restored: false,
    outcome: 'prior-state-unknown',
    message:
      'It is still marked blocked and we have no record of what it was before, ' +
      'so it was left alone. Tell us which state to put it on.',
  };
}

const WAITING_STATES_LOWER = new Set(STATE_BUCKET_CHAIN.waiting.map(s => s.toLowerCase()));

export { isBlockedState };

/**
 * If the work item is in any "waiting" state (New / To Do / Proposed),
 * transition it to the team's "going" state (Active / In Progress / etc).
 * Called automatically from session_start so opening a session on a New
 * item is the user's declaration that work has started — no manual ADO
 * state flip needed.
 *
 * No-op if the item is already in going/done/unknown.
 */
export async function ensureActive(workItemId: number): Promise<{
  flipped: boolean;
  fromState: string;
  toState: string;
}> {
  const current = await fetchEffortFields(workItemId);
  const fromState = current.fields['System.State'] ?? '';
  if (!WAITING_STATES_LOWER.has(fromState.toLowerCase())) {
    return { flipped: false, fromState, toState: fromState };
  }
  const toState = await setStateBucket(workItemId, 'going');
  return { flipped: true, fromState, toState };
}

/** Work item types that represent a "story" — the level a task rolls up to. */
const STORY_LEVEL_TYPES = new Set([
  'user story',
  'story',
  'product backlog item',
  'requirement',
  'bug',
  'issue',
]);

/** Light read of just the fields we need (parent link, type, state). */
async function readFields(id: number, fields: string[]): Promise<Record<string, unknown>> {
  const cfg = await loadAdoConfig();
  const list = fields.join(',');
  const uri = `${cfg.organization}/${encodeURIComponent(cfg.project)}/_apis/wit/workitems/${id}?fields=${encodeURIComponent(list)}&api-version=7.1`;
  const w = await getAdoClient().rest<{ fields: Record<string, unknown> }>({ method: 'GET', uri });
  return w.fields ?? {};
}

/**
 * Starting work on a task inside a story should pull the STORY into "going"
 * too — otherwise the board reads the story as untouched ("New") while its
 * tasks are clearly in flight, which is just confusing.
 *
 * Only cascades upward from a Task to its parent Story (waiting → going). No-op
 * when: the item isn't a Task, it has no parent, the parent isn't a story-level
 * type (never auto-activate a Feature/Epic), or the parent is already
 * active/done. Best-effort — any read/write failure returns null rather than
 * derailing session_start.
 */
export async function ensureParentStoryActive(childId: number): Promise<{
  flipped: boolean;
  parentId: number;
  fromState: string;
  toState: string;
} | null> {
  try {
    const child = await readFields(childId, ['System.Parent', 'System.WorkItemType']);
    const childType = String(child['System.WorkItemType'] ?? '').toLowerCase();
    if (childType !== 'task') return null; // only tasks cascade up to their story
    const parentRaw = child['System.Parent'];
    const parentId = typeof parentRaw === 'number' ? parentRaw : null;
    if (parentId == null) return null;

    const parent = await readFields(parentId, ['System.WorkItemType', 'System.State']);
    const parentType = String(parent['System.WorkItemType'] ?? '').toLowerCase();
    if (!STORY_LEVEL_TYPES.has(parentType)) return null; // never auto-activate Feature/Epic
    const fromState = String(parent['System.State'] ?? '');
    if (!WAITING_STATES_LOWER.has(fromState.toLowerCase())) {
      return { flipped: false, parentId, fromState, toState: fromState };
    }
    const toState = await setStateBucket(parentId, 'going');
    return { flipped: true, parentId, fromState, toState };
  } catch {
    return null;
  }
}

async function setEstimate(workItemId: number, hours: number): Promise<void> {
  await patchWorkItem(workItemId, [
    { op: 'add', path: '/fields/Microsoft.VSTS.Scheduling.OriginalEstimate', value: round2(hours) },
  ]);
}

/**
 * Backfill the Original Estimate — but ONLY when it's currently blank. Original
 * Estimate is the baseline the delivery manager compares actual hours against,
 * so once it has a value it's set in stone (rewriting it kills the variance
 * signal — that's why workitem_edit can't change it). The legitimate gap this
 * fills: tasks that already existed with no estimate at all (created outside
 * sprintomatic, or before estimating). "Set once" — just allowed to happen
 * late. See [[feedback-effort-discipline]].
 */
export async function backfillEstimateIfBlank(workItemId: number, hours: number): Promise<void> {
  const f = await readFields(workItemId, [
    'Microsoft.VSTS.Scheduling.OriginalEstimate',
    'System.Title',
  ]);
  const raw = f['Microsoft.VSTS.Scheduling.OriginalEstimate'];
  const existing = typeof raw === 'number' ? raw : Number(raw);
  if (Number.isFinite(existing) && existing > 0) {
    const title = String(f['System.Title'] ?? `#${workItemId}`);
    throw new Error(
      `"${title}" already has an Original Estimate of ${existing}h — that's the baseline the delivery manager compares actual hours against, so it's set once and not rewritten. If the task grew, raise Remaining Work instead.`,
    );
  }
  await setEstimate(workItemId, hours);
}

export async function setRemaining(workItemId: number, hours: number): Promise<void> {
  await patchWorkItem(workItemId, [
    { op: 'add', path: '/fields/Microsoft.VSTS.Scheduling.RemainingWork', value: round2(hours) },
  ]);
}

/**
 * Explicit overwrite of CompletedWork on ADO. Separate from `pushCompletedWork`
 * (delta-based via timer seconds) — this one sets the field to a specific
 * total, derived from the burndown formula (OriginalEstimate − new Remaining,
 * adjusted for overrun) at session_end(done=true).
 */
export async function setCompletedWork(workItemId: number, hours: number): Promise<void> {
  await patchWorkItem(workItemId, [
    { op: 'add', path: '/fields/Microsoft.VSTS.Scheduling.CompletedWork', value: round2(hours) },
  ]);
}

/**
 * Rename a work item — overwrite System.Title. Trimmed; rejects an empty title.
 * Returns the title that was written so the caller can echo it back.
 */
export async function setTitle(workItemId: number, title: string): Promise<string> {
  const trimmed = title.trim();
  if (!trimmed) throw new Error('A work item title cannot be empty.');
  await patchWorkItem(workItemId, [
    { op: 'add', path: '/fields/System.Title', value: trimmed },
  ]);
  return trimmed;
}

/** Overwrite the board description (System.Description). Plain text in;
 *  line breaks kept as <br>. Returns what was written. */
export async function setDescription(workItemId: number, text: string): Promise<string> {
  const trimmed = text.trim();
  if (!trimmed) throw new Error('A work item description cannot be empty — to clear it, say so and we will add a clear step.');
  await patchWorkItem(workItemId, [
    { op: 'add', path: '/fields/System.Description', value: escapeHtml(trimmed) },
  ]);
  return trimmed;
}

/**
 * Story-level effort. Effort (hours) is the source of truth on the user's team —
 * StoryPoints is always derived from it via `deriveStoryPoints`, so the two
 * fields cannot drift. A direct StoryPoints setter is kept for the rare case a
 * caller needs to write only that field (e.g. the sync sweep that fixes legacy
 * drift), but normal write paths must use `setEffortWithDerivedPoints` so
 * both fields land in the same PATCH.
 */
export async function setStoryPoints(workItemId: number, points: number): Promise<void> {
  await patchWorkItem(workItemId, [
    { op: 'add', path: '/fields/Microsoft.VSTS.Scheduling.StoryPoints', value: round2(points) },
  ]);
}

/**
 * Write Effort and the derived StoryPoints in a single PATCH so the two
 * fields can never be observed out of sync between writes. Returns the
 * numbers that were written so callers can echo them back to the user.
 */
export async function setEffortWithDerivedPoints(
  workItemId: number,
  effortHours: number,
): Promise<{ effort: number; storyPoints: number }> {
  const workday = getWorkdayHours();
  const points = deriveStoryPoints(effortHours, workday);
  await patchWorkItem(workItemId, [
    { op: 'add', path: '/fields/Microsoft.VSTS.Scheduling.Effort', value: round2(effortHours) },
    { op: 'add', path: '/fields/Microsoft.VSTS.Scheduling.StoryPoints', value: round2(points) },
  ]);
  return { effort: round2(effortHours), storyPoints: round2(points) };
}

/* ============================================================ */
/*  Create                                                       */
/* ============================================================ */

export interface CreateTaskInput {
  title: string;
  description?: string;
  parentStoryId?: number;
  estimateHours?: number;
  /** Tags applied as a list — ADO stores them semicolon-delimited. */
  tags?: string[];
}

export interface CreatedTask {
  id: number;
  title: string;
  type: string;
  state: string;
  url: string;
  webUrl: string;
  parentId?: number;
}

/**
 * Create a new Task in ADO. Defaults: assignee = current user, area = project
 * default. Iteration: the parent story's own iteration when there is a parent,
 * else the current sprint. If `parentStoryId` is given, links the new task as
 * a child of that work item.
 */
export async function createTask(input: CreateTaskInput): Promise<CreatedTask> {
  const cfg = await loadAdoConfig();
  // A task belongs where its story is — a backlog story gets a backlog task,
  // so it doesn't land on this sprint's Daily. The one exception: a story
  // stuck in a finished sprint sends its new task to the current sprint,
  // because tasks carry forward and stories don't.
  let iteration: string | null = null;
  if (input.parentStoryId) {
    const pf = await readFields(input.parentStoryId, ['System.IterationPath']).catch(() => ({} as Record<string, unknown>));
    const storyPath = String(pf['System.IterationPath'] ?? '');
    if (storyPath) {
      // If the iteration list can't be read we can't tell "finished" from
      // "future" — fall back to the current sprint rather than risk creating
      // the task in a closed sprint where it would never show on Daily.
      const iterations = await listAllIterations().catch(() => null);
      if (iterations && !classifyPastSprint(iterations, storyPath, new Date())) iteration = storyPath;
    }
  }
  if (!iteration) iteration = await getCurrentIterationPath();
  if (!iteration) throw new Error('No active sprint found — cannot place new task.');

  // 0 hours means "not estimated yet": write NEITHER Original Estimate NOR
  // Remaining Work, so both stay blank on the board — that is the honest
  // reading for the missing-estimate check, and a real 0 would look planned.
  const hasEstimate = input.estimateHours != null && input.estimateHours !== 0;
  const patch: Array<Record<string, unknown>> = [
    { op: 'add', path: '/fields/System.Title', value: input.title },
    { op: 'add', path: '/fields/System.AssignedTo', value: cfg.user },
    { op: 'add', path: '/fields/System.IterationPath', value: iteration },
  ];
  if (input.description) {
    patch.push({
      op: 'add',
      path: '/fields/System.Description',
      // ADO accepts plain text in HTML field; escape minimally to be safe.
      value: escapeHtml(input.description),
    });
  }
  if (hasEstimate) {
    patch.push({
      op: 'add',
      path: '/fields/Microsoft.VSTS.Scheduling.OriginalEstimate',
      value: round2(input.estimateHours!),
    });
    patch.push({
      op: 'add',
      path: '/fields/Microsoft.VSTS.Scheduling.RemainingWork',
      value: round2(input.estimateHours!),
    });
  }
  if (input.tags && input.tags.length > 0) {
    patch.push({
      op: 'add',
      path: '/fields/System.Tags',
      value: input.tags.join('; '),
    });
  }
  if (input.parentStoryId) {
    patch.push({
      op: 'add',
      path: '/relations/-',
      value: {
        rel: 'System.LinkTypes.Hierarchy-Reverse',
        url: `${cfg.organization}/_apis/wit/workItems/${input.parentStoryId}`,
      },
    });
  }

  const uri = `${cfg.organization}/${encodeURIComponent(cfg.project)}/_apis/wit/workitems/$Task?api-version=7.1`;
  const created = await getAdoClient().rest<{
    id: number;
    fields: {
      'System.Title': string;
      'System.WorkItemType': string;
      'System.State': string;
    };
    url: string;
    _links?: { html?: { href?: string } };
  }>({ method: 'POST', uri, body: patch, contentKind: 'json-patch' });

  return {
    id: created.id,
    title: created.fields['System.Title'],
    type: created.fields['System.WorkItemType'],
    state: created.fields['System.State'],
    url: created.url,
    webUrl:
      created._links?.html?.href ??
      `${cfg.organization}/${encodeURIComponent(cfg.project)}/_workitems/edit/${created.id}`,
    parentId: input.parentStoryId,
  };
}

export interface CreateStoryInput {
  title: string;
  description?: string;
  /**
   * Total hours the user thinks this story is. Story Points are derived from
   * this via `deriveStoryPoints` and written in the same PATCH — callers
   * don't (and can't) pass points independently.
   */
  effortHours: number;
  /** Optional Feature/Epic id to link the story under. */
  parentFeatureId?: number;
  tags?: string[];
}

export interface CreatedStory {
  id: number;
  title: string;
  type: string;
  state: string;
  url: string;
  webUrl: string;
  parentId?: number;
}

/**
 * Shared creator for the two story-level item types sprintomatic makes:
 * User Story and Bug. They differ only by the POST type segment and the noun
 * in the "no active sprint" error — everything else (assignee, current sprint,
 * Effort + derived StoryPoints, optional description / tags / parent link) is
 * identical. `createTask` stays separate: tasks carry OriginalEstimate /
 * RemainingWork, not Effort / StoryPoints.
 */
async function createStoryLevel(
  typeSegment: string,
  noun: string,
  input: CreateStoryInput,
): Promise<CreatedStory> {
  const cfg = await loadAdoConfig();
  const iteration = await getCurrentIterationPath();
  if (!iteration) throw new Error(`No active sprint found — cannot place new ${noun}.`);

  const workday = getWorkdayHours();
  const derivedPoints = deriveStoryPoints(input.effortHours, workday);
  const patch: Array<Record<string, unknown>> = [
    { op: 'add', path: '/fields/System.Title', value: input.title },
    { op: 'add', path: '/fields/System.AssignedTo', value: cfg.user },
    { op: 'add', path: '/fields/System.IterationPath', value: iteration },
    // SMOKE-TEST SUSPECT: a User Story takes Effort in this tenant, but whether
    // the Bug type accepts it is unverified (process-dependent). If a real
    // bug_create is rejected on this field, drop this one line for bugs.
    { op: 'add', path: '/fields/Microsoft.VSTS.Scheduling.Effort', value: round2(input.effortHours) },
    { op: 'add', path: '/fields/Microsoft.VSTS.Scheduling.StoryPoints', value: round2(derivedPoints) },
  ];
  if (input.description) {
    patch.push({ op: 'add', path: '/fields/System.Description', value: escapeHtml(input.description) });
  }
  if (input.tags && input.tags.length > 0) {
    patch.push({ op: 'add', path: '/fields/System.Tags', value: input.tags.join('; ') });
  }
  if (input.parentFeatureId) {
    patch.push({
      op: 'add',
      path: '/relations/-',
      value: {
        rel: 'System.LinkTypes.Hierarchy-Reverse',
        url: `${cfg.organization}/_apis/wit/workItems/${input.parentFeatureId}`,
      },
    });
  }

  const uri = `${cfg.organization}/${encodeURIComponent(cfg.project)}/_apis/wit/workitems/${typeSegment}?api-version=7.1`;
  const created = await getAdoClient().rest<{
    id: number;
    fields: { 'System.Title': string; 'System.WorkItemType': string; 'System.State': string };
    url: string;
    _links?: { html?: { href?: string } };
  }>({ method: 'POST', uri, body: patch, contentKind: 'json-patch' });

  return {
    id: created.id,
    title: created.fields['System.Title'],
    type: created.fields['System.WorkItemType'],
    state: created.fields['System.State'],
    url: created.url,
    webUrl:
      created._links?.html?.href ??
      `${cfg.organization}/${encodeURIComponent(cfg.project)}/_workitems/edit/${created.id}`,
    parentId: input.parentFeatureId,
  };
}

/**
 * Create a new User Story in ADO. Defaults: assignee = current user, iteration =
 * current sprint. Always sets StoryPoints + Effort so the delivery manager
 * never sees blank planning fields.
 */
export async function createStory(input: CreateStoryInput): Promise<CreatedStory> {
  return createStoryLevel('$User%20Story', 'story', input);
}

/**
 * Create a new Bug in ADO. Same defaults and planning fields as a story (a Bug
 * is a story-level item here). NOTE: this tenant's Bug type has no Blocked
 * state — blocking a bug falls back to a tag elsewhere in this file.
 */
export async function createBug(input: CreateStoryInput): Promise<CreatedStory> {
  return createStoryLevel('$Bug', 'bug', input);
}

export interface CreateFeatureInput {
  title: string;
  description?: string;
  /** Optional Epic id to link the Feature under. */
  parentEpicId?: number;
}

/**
 * Create a new Feature in ADO — the container the user makes when the user wants to group
 * stories the user already wrote. Assigned to them, state left at the type's default
 * (New in this tenant).
 *
 * Deliberately NOT built on `createStoryLevel`: they disagree on most of the
 * patch. A Feature carries no Effort and no StoryPoints (this tenant doesn't ask
 * for them on a Feature, and nothing flags one for missing them), it goes to the
 * backlog level above the current sprint rather than into the sprint, and a
 * missing sprint is fine here rather than fatal — a Feature doesn't belong to a
 * sprint in the first place. Threading three flags through the shared function
 * would read worse than this short one.
 *
 * Linking existing stories under the result is a separate step: `reparent`.
 */
export async function createFeature(input: CreateFeatureInput): Promise<CreatedStory> {
  const cfg = await loadAdoConfig();
  const iteration = backlogPathForNewFeature(await getCurrentIterationPath(), cfg.project);

  const patch: Array<Record<string, unknown>> = [
    { op: 'add', path: '/fields/System.Title', value: input.title },
    { op: 'add', path: '/fields/System.AssignedTo', value: cfg.user },
    { op: 'add', path: '/fields/System.IterationPath', value: iteration },
  ];
  if (input.description) {
    patch.push({ op: 'add', path: '/fields/System.Description', value: escapeHtml(input.description) });
  }
  if (input.parentEpicId) {
    patch.push({
      op: 'add',
      path: '/relations/-',
      value: {
        rel: 'System.LinkTypes.Hierarchy-Reverse',
        url: `${cfg.organization}/_apis/wit/workItems/${input.parentEpicId}`,
      },
    });
  }

  const uri = `${cfg.organization}/${encodeURIComponent(cfg.project)}/_apis/wit/workitems/$Feature?api-version=7.1`;
  const created = await getAdoClient().rest<{
    id: number;
    fields: { 'System.Title': string; 'System.WorkItemType': string; 'System.State': string };
    url: string;
    _links?: { html?: { href?: string } };
  }>({ method: 'POST', uri, body: patch, contentKind: 'json-patch' });

  return {
    id: created.id,
    title: created.fields['System.Title'],
    type: created.fields['System.WorkItemType'],
    state: created.fields['System.State'],
    url: created.url,
    webUrl:
      created._links?.html?.href ??
      `${cfg.organization}/${encodeURIComponent(cfg.project)}/_workitems/edit/${created.id}`,
    parentId: input.parentEpicId,
  };
}

const TYPE_NAME: Record<'story' | 'bug', string> = {
  story: 'User Story',
  bug: 'Bug',
};

export interface ChangedType {
  id: number;
  title: string;
  type: string;
  state: string;
}

/**
 * Change a work item's type between User Story and Bug. Reads the current type
 * first: refuses anything that isn't a Story↔Bug flip (Task / Feature / Epic
 * carry hierarchy meaning a type swap would corrupt) and refuses a no-op.
 * Azure carries the State across because Story and Bug share the states this
 * tenant uses (New / Active / Closed).
 */
export async function changeWorkItemType(
  workItemId: number,
  toType: 'story' | 'bug',
): Promise<ChangedType> {
  const target = TYPE_NAME[toType];
  const current = await readFields(workItemId, [
    'System.WorkItemType',
    'System.State',
    'System.Title',
  ]);
  const currentType = String(current['System.WorkItemType'] ?? '');

  if (currentType !== 'User Story' && currentType !== 'Bug') {
    throw new Error(
      `#${workItemId} is a ${currentType || 'unknown type'} — changing type only works between User Story and Bug.`,
    );
  }
  if (currentType === target) {
    throw new Error(`#${workItemId} is already a ${target}.`);
  }

  const cfg = await loadAdoConfig();
  const uri = `${cfg.organization}/${encodeURIComponent(cfg.project)}/_apis/wit/workitems/${workItemId}?api-version=7.1`;
  const updated = await getAdoClient().rest<{
    id: number;
    fields: { 'System.WorkItemType': string; 'System.State': string; 'System.Title': string };
  }>({
    method: 'PATCH',
    uri,
    body: [{ op: 'add', path: '/fields/System.WorkItemType', value: target }],
    contentKind: 'json-patch',
  });

  // Read back from the response, but fall back to the pre-change values (or the
  // target we just set) so the ChangedType contract never silently returns
  // undefined if a real Azure response omits a default field.
  return {
    id: updated.id,
    title: String(updated.fields['System.Title'] ?? current['System.Title'] ?? ''),
    type: String(updated.fields['System.WorkItemType'] ?? target),
    state: String(updated.fields['System.State'] ?? current['System.State'] ?? ''),
  };
}

async function getCurrentIterationPath(): Promise<string | null> {
  const cfg = await loadAdoConfig();
  const uri = `${cfg.organization}/${encodeURIComponent(cfg.project)}/${encodeURIComponent(cfg.team)}/_apis/work/teamsettings/iterations?$timeframe=current&api-version=7.1`;
  try {
    const parsed = await getAdoClient().rest<{ value?: Array<{ path: string }> }>({ method: 'GET', uri });
    return parsed.value?.[0]?.path ?? null;
  } catch {
    return null;
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n/g, '<br>');
}

/**
 * States that mean a story-level item has NOT been started yet. Only these may
 * have their sprint iteration changed wholesale. Mirrors the ADO "Proposed"
 * state category across the work-item types in the user's tenant (User Story adds
 * Approved / Ready For Dev; Bug adds Accepted).
 */
const NEVER_STARTED_STATES_LOWER = new Set([
  'new', 'to do', 'proposed', 'approved', 'ready for dev', 'accepted',
]);

/**
 * Move a work item to a different iteration (e.g. from sprint 26_11 to the
 * 2026 year-level node). `iterationPath` is the full ADO path string
 * (backslash-separated), like 'MyProject\\2026' or 'MyProject\\2026\\Q2\\26_11'.
 *
 * Planning rule (the user, 2026-06-08, relaxed 2026-06-25): the guard exists to
 * keep a FINISHED sprint's planned-vs-completed record honest. So this refuses
 * to move a story-level item ONLY when it's started AND currently sitting in a
 * past (already-ended) sprint — moving it would silently drop it from that
 * sprint's numbers. A started story in the backlog / current / a future sprint
 * moves freely, as does a never-started (New) story from anywhere, and any
 * task. See [[carryover-convention]].
 */
export async function setIterationPath(workItemId: number, iterationPath: string): Promise<void> {
  const f = await readFields(workItemId, ['System.WorkItemType', 'System.State', 'System.Title', 'System.IterationPath']);
  const type = String(f['System.WorkItemType'] ?? '').toLowerCase();
  const state = String(f['System.State'] ?? '');
  if (STORY_LEVEL_TYPES.has(type) && !NEVER_STARTED_STATES_LOWER.has(state.toLowerCase())) {
    const currentPath = String(f['System.IterationPath'] ?? '');
    const iterations = await listAllIterations().catch(() => []);
    if (classifyPastSprint(iterations, currentPath, new Date())) {
      const title = String(f['System.Title'] ?? `#${workItemId}`);
      throw new Error(
        `Won't move "${title}" out of a finished sprint — that would drop it from that sprint's record. A started story stays in the sprint it ran in; only its open tasks carry forward. Move the tasks instead, or close the story.`,
      );
    }
  }
  await patchWorkItem(workItemId, [
    { op: 'add', path: '/fields/System.IterationPath', value: iterationPath },
  ]);
}

/**
 * Reparent a work item under a different parent. Removes any existing
 * Hierarchy-Reverse relations (typical ADO items have exactly one parent),
 * then adds a single new one pointing at `newParentId`. Returns the parent
 * ids that were removed so the caller can surface what changed.
 */
export async function reparent(
  childId: number,
  newParentId: number,
): Promise<{ removedParents: number[]; newParent: number }> {
  const cfg = await loadAdoConfig();
  // Read current relations.
  const readUri = `${cfg.organization}/${encodeURIComponent(cfg.project)}/_apis/wit/workitems/${childId}?$expand=relations&api-version=7.1`;
  const w = await getAdoClient().rest<{ relations?: Array<{ rel: string; url: string }> }>({ method: 'GET', uri: readUri });
  const relations = w.relations ?? [];

  const parentIndices: number[] = [];
  const removedParents: number[] = [];
  for (let i = 0; i < relations.length; i++) {
    if (relations[i].rel === 'System.LinkTypes.Hierarchy-Reverse') {
      parentIndices.push(i);
      const m = relations[i].url.match(/\/workItems\/(\d+)$/i);
      if (m) removedParents.push(Number(m[1]));
    }
  }
  if (removedParents.includes(newParentId) && removedParents.length === 1) {
    // Already parented under that exact id — no-op.
    return { removedParents: [], newParent: newParentId };
  }

  const patch: Array<Record<string, unknown>> = [];
  // Remove in reverse index order so earlier indices stay valid.
  for (const idx of [...parentIndices].sort((a, b) => b - a)) {
    patch.push({ op: 'remove', path: `/relations/${idx}` });
  }
  patch.push({
    op: 'add',
    path: '/relations/-',
    value: {
      rel: 'System.LinkTypes.Hierarchy-Reverse',
      url: `${cfg.organization}/_apis/wit/workItems/${newParentId}`,
    },
  });
  await patchWorkItem(childId, patch);
  return { removedParents, newParent: newParentId };
}

/* ============================================================ */
/*  Low-level                                                    */
/* ============================================================ */

async function patchWorkItem(id: number, patch: Array<Record<string, unknown>>): Promise<void> {
  const cfg = await loadAdoConfig();
  const uri = `${cfg.organization}/${encodeURIComponent(cfg.project)}/_apis/wit/workitems/${id}?api-version=7.1`;
  await getAdoClient().rest({ method: 'PATCH', uri, body: patch, contentKind: 'json-patch' });
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
