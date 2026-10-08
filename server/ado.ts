/**
 * Azure DevOps reads — work items and iterations.
 *
 * Every Azure DevOps call goes through the one seam in `./ado-client`, so the
 * same reads run two ways (CLI via `az`, or the REST API via a stored token),
 * chosen by config. This module owns the WIQL/field mapping; the client owns
 * auth + transport. See docs/azure-access.md.
 */
import { loadAdoConfig } from './config';
import { getAdoClient, type RawWorkItem } from './ado-client';

export interface Iteration {
  id: string;
  name: string;
  path: string;
  startDate: string; // ISO
  finishDate: string; // ISO
}

export interface WorkItem {
  id: number;
  rev: number;
  type: string;
  title: string;
  state: string;
  description?: string;       // HTML (raw); UI strips to plain-text preview
  areaPath: string;
  parentId?: number;
  parentTitle?: string;
  parentType?: string;
  parentState?: string;
  parentUrl?: string;
  parentDescription?: string;
  parentAreaPath?: string;
  parentOriginalEstimate?: number;
  parentRemainingWork?: number;
  parentStoryPoints?: number;
  parentEffort?: number;
  /** The story's parent — i.e. the Feature / Epic above it. */
  grandparentId?: number;
  grandparentTitle?: string;
  grandparentType?: string;
  assignedTo?: string;
  iterationPath: string;
  originalEstimate?: number;
  remainingWork?: number;
  completedWork?: number;
  /** Story-level: 1 point = 1 day in the user's team. */
  storyPoints?: number;
  /** Story-level: total hours estimate. */
  effort?: number;
  /** Parsed System.Tags. Includes "Blocked" when the item is currently blocked. */
  tags?: string[];
  /** Parent's parsed tags — surfaced so a child task can show that ITS parent story is blocked. */
  parentTags?: string[];
  changedDate: string;
  url: string;
}

const WORK_ITEM_FIELDS = [
  'System.Id',
  'System.Rev',
  'System.WorkItemType',
  'System.Title',
  'System.State',
  'System.Description',
  'System.AreaPath',
  'System.Parent',
  'System.AssignedTo',
  'System.IterationPath',
  'System.ChangedDate',
  'Microsoft.VSTS.Scheduling.OriginalEstimate',
  'Microsoft.VSTS.Scheduling.RemainingWork',
  'Microsoft.VSTS.Scheduling.CompletedWork',
  'Microsoft.VSTS.Scheduling.StoryPoints',
  'Microsoft.VSTS.Scheduling.Effort',
  'System.Tags',
];

/**
 * Iterations rarely change within a session (sprint dates are fixed once a
 * sprint is created), but fetching them costs a round-trip. Cache both the
 * current-iteration lookup and the full list in memory with a short TTL so a
 * dashboard reload / sprint switch doesn't re-pay that on every request. Work
 * items themselves are never cached — only the iteration metadata.
 */
const ITERATION_TTL_MS = 5 * 60 * 1000;
let currentCache: { value: Iteration | null; at: number } | null = null;
let allCache: { value: Iteration[]; at: number } | null = null;

function fresh(at: number): boolean {
  return Date.now() - at < ITERATION_TTL_MS;
}

/** Clear the iteration caches — call after creating/changing iterations. */
export function invalidateIterationCache(): void {
  currentCache = null;
  allCache = null;
}

interface RawIteration {
  id: string;
  name: string;
  path: string;
  attributes: { startDate?: string; finishDate?: string };
}

/** GET the team's iterations (optionally just the current one) via the seam. */
async function fetchIterations(timeframeCurrent: boolean): Promise<RawIteration[]> {
  const cfg = await loadAdoConfig();
  const base = `${cfg.organization}/${encodeURIComponent(cfg.project)}/${encodeURIComponent(cfg.team)}/_apis/work/teamsettings/iterations`;
  const uri = `${base}?${timeframeCurrent ? '$timeframe=current&' : ''}api-version=7.1`;
  const parsed = await getAdoClient().rest<{ value?: RawIteration[] }>({ method: 'GET', uri });
  return parsed.value ?? [];
}

export async function getCurrentIteration(): Promise<Iteration | null> {
  if (currentCache && fresh(currentCache.at)) return currentCache.value;
  const arr = await fetchIterations(true);
  const first = arr[0];
  const value: Iteration | null = first
    ? {
        id: first.id,
        name: first.name,
        path: first.path,
        startDate: first.attributes.startDate ?? '',
        finishDate: first.attributes.finishDate ?? '',
      }
    : null;
  currentCache = { value, at: Date.now() };
  return value;
}

/** All iterations the team has — for sprint picker (browse previous/upcoming). */
export async function listAllIterations(): Promise<Iteration[]> {
  if (allCache && fresh(allCache.at)) return allCache.value;
  const arr = await fetchIterations(false);
  const value = arr
    .filter(it => it.attributes.startDate && it.attributes.finishDate)
    .map(it => ({
      id: it.id,
      name: it.name,
      path: it.path,
      startDate: it.attributes.startDate!,
      finishDate: it.attributes.finishDate!,
    }))
    .sort((a, b) => a.startDate.localeCompare(b.startDate));
  allCache = { value, at: Date.now() };
  return value;
}

/** Find a specific iteration by name. */
export async function getIterationByName(name: string): Promise<Iteration | null> {
  const all = await listAllIterations();
  return all.find(it => it.name === name) ?? null;
}

/* ============================================================ */
/*  Single work item — full read-only details                    */
/* ============================================================ */

export interface WorkItemDetail {
  id: number;
  rev: number;
  type: string;
  title: string;
  state: string;
  assignedTo?: string;
  iterationPath: string;
  areaPath: string;
  description?: string;       // HTML
  acceptanceCriteria?: string; // HTML
  reproSteps?: string;        // HTML, for bugs
  tags?: string;
  priority?: number;
  createdDate: string;
  createdBy?: string;
  changedDate: string;
  changedBy?: string;
  originalEstimate?: number;
  remainingWork?: number;
  completedWork?: number;
  parent?: { id: number; title: string; type: string; state: string; url: string };
  children: Array<{ id: number; title: string; type: string; state: string; url: string }>;
  related: Array<{ id: number; title: string; type: string; state: string; url: string; rel: string }>;
  url: string;
  webUrl: string;
}

export interface WorkItemComment {
  id: number;
  text: string; // HTML
  createdBy?: string;
  createdDate: string;
}

export async function getWorkItem(id: number): Promise<WorkItemDetail> {
  const cfg = await loadAdoConfig();
  const uri = `${cfg.organization}/${encodeURIComponent(cfg.project)}/_apis/wit/workitems/${id}?$expand=all&api-version=7.1`;
  const w = await getAdoClient().rest<{
    id: number;
    rev: number;
    url: string;
    fields: Record<string, unknown>;
    relations?: Array<{ rel: string; url: string; attributes?: { name?: string } }>;
    _links?: { html?: { href?: string } };
  }>({ method: 'GET', uri });
  const f = w.fields;

  const childIds: number[] = [];
  const parentIds: number[] = [];
  const relatedIds: Array<{ id: number; rel: string }> = [];

  if (w.relations) {
    for (const rel of w.relations) {
      const m = rel.url.match(/\/workItems\/(\d+)$/i);
      if (!m) continue;
      const wid = Number(m[1]);
      if (rel.rel === 'System.LinkTypes.Hierarchy-Forward') childIds.push(wid);
      else if (rel.rel === 'System.LinkTypes.Hierarchy-Reverse') parentIds.push(wid);
      else if (rel.rel.startsWith('System.LinkTypes')) relatedIds.push({ id: wid, rel: rel.rel });
    }
  }

  // Resolve titles for parent, children, and related links — best-effort batch.
  const allRefs = [...parentIds, ...childIds, ...relatedIds.map(r => r.id)];
  const refDetails = allRefs.length > 0 ? await getWorkItemBatch(allRefs) : [];
  const refMap = new Map(refDetails.map(r => [r.id, r]));

  const parent =
    parentIds[0] != null && refMap.has(parentIds[0])
      ? mapRef(refMap.get(parentIds[0])!)
      : undefined;

  const children = childIds
    .filter(cid => refMap.has(cid))
    .map(cid => mapRef(refMap.get(cid)!));

  const related = relatedIds
    .filter(r => refMap.has(r.id))
    .map(r => ({ ...mapRef(refMap.get(r.id)!), rel: r.rel }));

  return {
    id: w.id,
    rev: w.rev,
    type: String(f['System.WorkItemType'] ?? ''),
    title: String(f['System.Title'] ?? ''),
    state: String(f['System.State'] ?? ''),
    assignedTo: extractAssignedTo(f['System.AssignedTo']),
    iterationPath: String(f['System.IterationPath'] ?? ''),
    areaPath: String(f['System.AreaPath'] ?? ''),
    description: strOrUndef(f['System.Description']),
    acceptanceCriteria: strOrUndef(f['Microsoft.VSTS.Common.AcceptanceCriteria']),
    reproSteps: strOrUndef(f['Microsoft.VSTS.TCM.ReproSteps']),
    tags: strOrUndef(f['System.Tags']),
    priority: numOrUndef(f['Microsoft.VSTS.Common.Priority']),
    createdDate: String(f['System.CreatedDate'] ?? ''),
    createdBy: extractAssignedTo(f['System.CreatedBy']),
    changedDate: String(f['System.ChangedDate'] ?? ''),
    changedBy: extractAssignedTo(f['System.ChangedBy']),
    originalEstimate: numOrUndef(f['Microsoft.VSTS.Scheduling.OriginalEstimate']),
    remainingWork: numOrUndef(f['Microsoft.VSTS.Scheduling.RemainingWork']),
    completedWork: numOrUndef(f['Microsoft.VSTS.Scheduling.CompletedWork']),
    parent,
    children,
    related,
    url: w.url,
    webUrl: w._links?.html?.href ?? `${cfg.organization}/${encodeURIComponent(cfg.project)}/_workitems/edit/${w.id}`,
  };
}

export async function getWorkItemComments(id: number): Promise<WorkItemComment[]> {
  const cfg = await loadAdoConfig();
  const uri = `${cfg.organization}/${encodeURIComponent(cfg.project)}/_apis/wit/workItems/${id}/comments?api-version=7.1-preview.4&$top=200`;
  const parsed = await getAdoClient().rest<{
    comments?: Array<{
      id: number;
      text: string;
      createdBy?: { displayName?: string };
      createdDate: string;
    }>;
  }>({ method: 'GET', uri });
  return (parsed.comments ?? []).map(c => ({
    id: c.id,
    text: c.text,
    createdBy: c.createdBy?.displayName,
    createdDate: c.createdDate,
  }));
}

/**
 * Post a comment to a work item's Discussion. ADO writes this to the same
 * Discussion stream the delivery manager sees on the board, and bumps
 * CommentCount by one.
 */
export async function addWorkItemComment(id: number, text: string): Promise<void> {
  const cfg = await loadAdoConfig();
  const uri = `${cfg.organization}/${encodeURIComponent(cfg.project)}/_apis/wit/workItems/${id}/comments?api-version=7.1-preview.4`;
  await getAdoClient().rest({ method: 'POST', uri, body: { text }, contentKind: 'json' });
}

function mapRef(w: WorkItem) {
  return {
    id: w.id,
    title: w.title,
    type: w.type,
    state: w.state,
    url: humanWorkItemUrl(w.url, w.id),
  };
}

function strOrUndef(v: unknown): string | undefined {
  const s = typeof v === 'string' ? v : undefined;
  return s && s.trim() ? s : undefined;
}

function extractAssignedTo(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  if (typeof v === 'object' && v !== null) {
    const obj = v as { displayName?: string; uniqueName?: string };
    return obj.displayName ?? obj.uniqueName;
  }
  return undefined;
}

export async function getMyWorkItems(iterationPath: string): Promise<WorkItem[]> {
  // 1) WIQL: work items assigned to @Me in this iteration. The doorway returns
  //    them already hydrated (CLI via `az boards query`; API via wiql + batch).
  const cfg = await loadAdoConfig();
  const fieldList = WORK_ITEM_FIELDS.map(f => `[${f}]`).join(', ');
  const wiql = [
    `SELECT ${fieldList} FROM WorkItems`,
    `WHERE [System.AssignedTo] = @Me`,
    `  AND [System.IterationPath] = '${escapeWiql(iterationPath)}'`,
    'ORDER BY [System.ChangedDate] DESC',
  ].join(' ');

  const raw = await getAdoClient().queryWorkItems({
    wiql,
    fields: WORK_ITEM_FIELDS,
    organization: cfg.organization,
    project: cfg.project,
  });
  if (raw.length === 0) return [];
  const items = raw.map(w => mapWorkItem(w));

  // 2) Resolve parent details in one extra batch (for parent story chip in the UI)
  const parentIds = [...new Set(items.map(i => i.parentId).filter((x): x is number => !!x))];
  const parents = parentIds.length > 0 ? await getWorkItemBatch(parentIds) : [];
  const parentMap = new Map(parents.map(p => [p.id, p]));

  // 3) Second hop: resolve the *grandparent* of each task (i.e. the Feature / Epic
  //    above the user story) so the daily view can group stories by feature.
  const grandparentIds = [...new Set(parents.map(p => p.parentId).filter((x): x is number => !!x))];
  const grandparents = grandparentIds.length > 0 ? await getWorkItemBatch(grandparentIds) : [];
  const grandparentMap = new Map(grandparents.map(g => [g.id, g]));

  for (const i of items) {
    if (i.parentId) {
      const p = parentMap.get(i.parentId);
      if (p) {
        i.parentTitle = p.title;
        i.parentType = p.type;
        i.parentState = p.state;
        i.parentUrl = humanWorkItemUrl(p.url, p.id);
        i.parentDescription = p.description;
        i.parentAreaPath = p.areaPath;
        i.parentOriginalEstimate = p.originalEstimate;
        i.parentRemainingWork = p.remainingWork;
        i.parentStoryPoints = p.storyPoints;
        i.parentEffort = p.effort;
        i.parentTags = p.tags;
        if (p.parentId) {
          const g = grandparentMap.get(p.parentId);
          if (g) {
            i.grandparentId = g.id;
            i.grandparentTitle = g.title;
            i.grandparentType = g.type;
          }
        }
      }
    }
  }
  return items;
}

function humanWorkItemUrl(restUrl: string, id: number): string {
  const m = restUrl.match(/^(https:\/\/dev\.azure\.com\/[^/]+)\/_apis\/wit\/workItems\/\d+/);
  if (!m) return restUrl;
  return `${m[1]}/_workitems/edit/${id}`;
}

async function getWorkItemBatch(ids: number[], options?: { errorPolicy?: 'fail' | 'omit' }): Promise<WorkItem[]> {
  const cfg = await loadAdoConfig();
  const uri = `${cfg.organization}/${encodeURIComponent(cfg.project)}/_apis/wit/workitemsbatch?api-version=7.1`;
  const body: any = { ids, fields: WORK_ITEM_FIELDS };
  if (options?.errorPolicy) body.errorPolicy = options.errorPolicy;
  const parsed = await getAdoClient().rest<{ value: RawWorkItem[] }>({
    method: 'POST',
    uri,
    body,
    contentKind: 'json',
  });
  return (parsed.value ?? []).map(w => mapWorkItem(w));
}

/**
 * Fetch specific work items by id, with their parent's title/type/state filled
 * in (one extra batch hop) — the same parent-enrichment `getMyWorkItems` does,
 * but for an arbitrary id list instead of a whole sprint. Used by the dashboard
 * to resolve titles for items worked in a PREVIOUS sprint (which the
 * current-sprint query never returns), so the morning recap shows real names
 * instead of bare `#id`s. Returns [] for an empty id list.
 */
export async function getWorkItemsWithParents(ids: number[], options?: { errorPolicy?: 'fail' | 'omit' }): Promise<WorkItem[]> {
  if (ids.length === 0) return [];
  const items = await getWorkItemBatch(ids, options);
  const parentIds = [...new Set(items.map(i => i.parentId).filter((x): x is number => !!x))];
  const parents = parentIds.length > 0 ? await getWorkItemBatch(parentIds, options) : [];
  const parentMap = new Map(parents.map(p => [p.id, p]));
  for (const i of items) {
    if (i.parentId == null) continue;
    const p = parentMap.get(i.parentId);
    if (!p) continue;
    i.parentTitle = p.title;
    i.parentType = p.type;
    i.parentState = p.state;
  }
  return items;
}

/**
 * Closed tasks (assigned to @Me) under a given parent — sorted newest first.
 * Used by the estimate-anchor flow to find "what did similar past tasks
 * under this story actually take?" Includes only items where both
 * OriginalEstimate AND CompletedWork are populated so the ratio is meaningful.
 */
export async function listClosedSiblings(parentId: number): Promise<WorkItem[]> {
  const cfg = await loadAdoConfig();
  const fieldList = WORK_ITEM_FIELDS.map(f => `[${f}]`).join(', ');
  const wiql = [
    `SELECT ${fieldList} FROM WorkItems`,
    `WHERE [System.AssignedTo] = @Me`,
    `  AND [System.Parent] = ${parentId}`,
    `  AND [System.State] IN ('Done', 'Closed', 'Resolved', 'Completed')`,
    `  AND [Microsoft.VSTS.Scheduling.OriginalEstimate] > 0`,
    `  AND [Microsoft.VSTS.Scheduling.CompletedWork] > 0`,
    'ORDER BY [System.ChangedDate] DESC',
  ].join(' ');
  const raw = await getAdoClient().queryWorkItems({
    wiql,
    fields: WORK_ITEM_FIELDS,
    organization: cfg.organization,
    project: cfg.project,
  });
  return raw.map(w => mapWorkItem(w));
}

/**
 * All open User Stories assigned to @Me that are NOT in the given sprint
 * iteration path. Used by the Plan cockpit's backlog section.
 *
 * One query, no per-iteration enumeration. Year-level, quarter-level,
 * Backlog literal, and even area-root (no year set at all) all come back
 * because we just ask ADO for "everything assigned to me, open, not in
 * this sprint" and classify the iteration path on the TS side.
 */
export async function listMyOpenStoriesNotInSprint(currentSprintPath: string): Promise<WorkItem[]> {
  const cfg = await loadAdoConfig();
  const fieldList = WORK_ITEM_FIELDS.map(f => `[${f}]`).join(', ');
  const wiql = [
    `SELECT ${fieldList} FROM WorkItems`,
    `WHERE [System.AssignedTo] = @Me`,
    `  AND [System.WorkItemType] = 'User Story'`,
    `  AND [System.State] NOT IN ('Done', 'Closed', 'Resolved', 'Completed', 'Removed', 'Canceled', 'Cancelled', 'Cut')`,
    `  AND [System.IterationPath] <> '${escapeWiql(currentSprintPath)}'`,
    'ORDER BY [System.IterationPath], [System.ChangedDate] DESC',
  ].join(' ');
  const raw = await getAdoClient().queryWorkItems({
    wiql,
    fields: WORK_ITEM_FIELDS,
    organization: cfg.organization,
    project: cfg.project,
  });
  return raw.map(w => mapWorkItem(w));
}

/**
 * All open Tasks assigned to @Me that are NOT in the given sprint iteration
 * path. Used by the Daily carry-forward banner to find tasks left behind in a
 * previous sprint. Mirrors listMyOpenStoriesNotInSprint but for Task type.
 * Caller classifies the iteration path (a task in backlog/year/quarter is not
 * carry-over) — this just returns every open out-of-sprint task.
 */
export async function listMyOpenTasksNotInSprint(currentSprintPath: string): Promise<WorkItem[]> {
  const cfg = await loadAdoConfig();
  const fieldList = WORK_ITEM_FIELDS.map(f => `[${f}]`).join(', ');
  const wiql = [
    `SELECT ${fieldList} FROM WorkItems`,
    `WHERE [System.AssignedTo] = @Me`,
    `  AND [System.WorkItemType] = 'Task'`,
    `  AND [System.State] NOT IN ('Done', 'Closed', 'Resolved', 'Completed', 'Removed', 'Canceled', 'Cancelled', 'Cut')`,
    `  AND [System.IterationPath] <> '${escapeWiql(currentSprintPath)}'`,
    'ORDER BY [System.IterationPath], [System.ChangedDate] DESC',
  ].join(' ');
  const raw = await getAdoClient().queryWorkItems({
    wiql,
    fields: WORK_ITEM_FIELDS,
    organization: cfg.organization,
    project: cfg.project,
  });
  return raw.map(w => mapWorkItem(w));
}

/**
 * Recently-closed tasks (assigned to @Me) across the whole project, for
 * computing a personal calibration ratio (actual / estimate). Includes only
 * items where both OriginalEstimate AND CompletedWork are populated.
 */
export async function listClosedCalibration(daysBack = 90, limit = 100): Promise<WorkItem[]> {
  const cfg = await loadAdoConfig();
  const fieldList = WORK_ITEM_FIELDS.map(f => `[${f}]`).join(', ');
  const wiql = [
    `SELECT ${fieldList} FROM WorkItems`,
    `WHERE [System.AssignedTo] = @Me`,
    `  AND [System.State] IN ('Done', 'Closed', 'Resolved', 'Completed')`,
    `  AND [System.ChangedDate] >= @Today - ${daysBack}`,
    `  AND [Microsoft.VSTS.Scheduling.OriginalEstimate] > 0`,
    `  AND [Microsoft.VSTS.Scheduling.CompletedWork] > 0`,
    'ORDER BY [System.ChangedDate] DESC',
  ].join(' ');
  const raw = await getAdoClient().queryWorkItems({
    wiql,
    fields: WORK_ITEM_FIELDS,
    organization: cfg.organization,
    project: cfg.project,
  });
  return raw.slice(0, limit).map(w => mapWorkItem(w));
}

function mapWorkItem(w: RawWorkItem): WorkItem {
  const f = w.fields;
  const assignedToRaw = f['System.AssignedTo'];
  const assignedTo =
    typeof assignedToRaw === 'object' && assignedToRaw !== null && 'uniqueName' in assignedToRaw
      ? String((assignedToRaw as { uniqueName: string }).uniqueName)
      : typeof assignedToRaw === 'string'
        ? assignedToRaw
        : undefined;

  return {
    id: w.id,
    rev: w.rev,
    type: String(f['System.WorkItemType'] ?? ''),
    title: String(f['System.Title'] ?? ''),
    state: String(f['System.State'] ?? ''),
    description: typeof f['System.Description'] === 'string' ? (f['System.Description'] as string) : undefined,
    areaPath: String(f['System.AreaPath'] ?? ''),
    parentId: typeof f['System.Parent'] === 'number' ? (f['System.Parent'] as number) : undefined,
    assignedTo,
    iterationPath: String(f['System.IterationPath'] ?? ''),
    originalEstimate: numOrUndef(f['Microsoft.VSTS.Scheduling.OriginalEstimate']),
    remainingWork: numOrUndef(f['Microsoft.VSTS.Scheduling.RemainingWork']),
    completedWork: numOrUndef(f['Microsoft.VSTS.Scheduling.CompletedWork']),
    storyPoints: numOrUndef(f['Microsoft.VSTS.Scheduling.StoryPoints']),
    effort: numOrUndef(f['Microsoft.VSTS.Scheduling.Effort']),
    tags: parseTags(f['System.Tags']),
    changedDate: String(f['System.ChangedDate'] ?? ''),
    url: w.url,
  };
}

function parseTags(raw: unknown): string[] | undefined {
  if (typeof raw !== 'string') return undefined;
  const list = raw
    .split(';')
    .map(t => t.trim())
    .filter(t => t.length > 0);
  return list.length > 0 ? list : undefined;
}

function numOrUndef(v: unknown): number | undefined {
  return typeof v === 'number' ? v : undefined;
}

function escapeWiql(s: string): string {
  return s.replace(/'/g, "''");
}
