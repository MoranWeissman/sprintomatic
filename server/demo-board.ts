/**
 * A pretend Azure DevOps board for demo mode (SPRINTOMATIC_DEMO=1).
 *
 * It sits behind the same AdoClient doorway as the real board, so the rest
 * of sprintomatic can't tell the difference. It lives in memory, starts from
 * the made-up recipe app in server/demo-data.ts, and every write changes it
 * the way the real board would: a state move, new Remaining hours, a new
 * task, a new parent. A restart puts the board back to how it started.
 *
 * It only answers the requests sprintomatic really makes. Anything else
 * fails with an error that names the request, so a missing route is easy to
 * spot instead of quietly returning nothing.
 */
import type { AdoClient, AdoQuery, AdoRestRequest, RawWorkItem } from './ado-client';
import {
  DEMO_ORG,
  DEMO_PROJECT,
  DEMO_USER,
  DEMO_USER_NAME,
  demoItems,
  demoIterations,
  type DemoItem,
  type DemoIteration,
} from './demo-data';

const PARENT_REL = 'System.LinkTypes.Hierarchy-Reverse';
const CHILD_REL = 'System.LinkTypes.Hierarchy-Forward';

/** The states every type allows on the demo board. */
const STATES: { name: string; category: string }[] = [
  { name: 'New', category: 'Proposed' },
  { name: 'Active', category: 'InProgress' },
  { name: 'Blocked', category: 'InProgress' },
  { name: 'Closed', category: 'Completed' },
  { name: 'Removed', category: 'Removed' },
];
const STATE_NAMES = new Set(STATES.map(s => s.name));

const ME = { displayName: DEMO_USER_NAME, uniqueName: DEMO_USER };

interface PatchOp {
  op: string;
  path: string;
  value?: unknown;
}

export class DemoAdoClient implements AdoClient {
  private items = new Map<number, DemoItem>();
  private iterations: DemoIteration[];
  private nextId: number;
  private nextCommentId = 1;
  private readonly now: () => Date;

  constructor(now: () => Date = () => new Date()) {
    this.now = now;
    const start = now();
    for (const item of demoItems(start)) {
      if (item.parent) item.fields['System.Parent'] = item.parent;
      this.items.set(item.id, item);
    }
    this.iterations = demoIterations(start);
    this.nextId = Math.max(...this.items.keys()) + 1;
  }

  async rest<T = unknown>(req: AdoRestRequest): Promise<T> {
    return this.route(req) as T;
  }

  async queryWorkItems(q: AdoQuery): Promise<RawWorkItem[]> {
    const where = parseWiql(q.wiql);
    const hits = [...this.items.values()].filter(item => where.every(c => c(item, this.now())));
    hits.sort((a, b) => String(b.fields['System.ChangedDate']).localeCompare(String(a.fields['System.ChangedDate'])));
    return hits.map(item => this.raw(item));
  }

  private route(req: AdoRestRequest): unknown {
    const url = new URL(req.uri);
    const path = decodeURIComponent(url.pathname);
    let m: RegExpMatchArray | null;

    if (req.method === 'GET' && /\/_apis\/work\/teamsettings\/iterations$/i.test(path)) {
      const current = url.searchParams.get('$timeframe') === 'current';
      return { value: this.iterations.filter(i => !current || i.attributes.timeFrame === 'current') };
    }
    if (req.method === 'GET' && (m = path.match(/\/_apis\/wit\/workitemtypes\/[^/]+\/states$/i))) {
      return { value: STATES.map(s => ({ ...s, color: '000000' })) };
    }
    if (req.method === 'POST' && /\/_apis\/wit\/workitemsbatch$/i.test(path)) {
      const body = (req.body ?? {}) as { ids?: number[]; errorPolicy?: string };
      const out: RawWorkItem[] = [];
      for (const id of body.ids ?? []) {
        const item = this.items.get(Number(id));
        if (item) out.push(this.raw(item));
        else if (body.errorPolicy !== 'omit') throw new Error(`TF401232: Work item ${id} does not exist.`);
      }
      return { count: out.length, value: out };
    }
    if ((m = path.match(/\/_apis\/wit\/workitems\/(\d+)\/comments$/i))) {
      const item = this.get(Number(m[1]));
      if (req.method === 'GET') return { totalCount: item.comments.length, comments: item.comments.map(c => this.comment(c)) };
      if (req.method === 'POST') {
        const text = String((req.body as { text?: unknown })?.text ?? '');
        const c = { id: this.nextCommentId++, text, createdDate: this.now().toISOString() };
        item.comments.unshift(c);
        return this.comment(c);
      }
    }
    if (req.method === 'POST' && (m = path.match(/\/_apis\/wit\/workitems\/\$([^/]+)$/i))) {
      return this.create(m[1], (req.body ?? []) as PatchOp[]);
    }
    if ((m = path.match(/\/_apis\/wit\/workitems\/(\d+)$/i))) {
      const item = this.get(Number(m[1]));
      if (req.method === 'GET') {
        const expand = url.searchParams.get('$expand')?.toLowerCase();
        const only = url.searchParams.get('fields');
        return this.full(item, expand === 'all' || expand === 'relations', only ? only.split(',') : null);
      }
      if (req.method === 'PATCH') {
        this.applyPatch(item, (req.body ?? []) as PatchOp[]);
        return this.full(item, true, null);
      }
    }
    throw new Error(`The demo board doesn't know this request: ${req.method} ${path}${url.search}`);
  }

  private get(id: number): DemoItem {
    const item = this.items.get(id);
    if (!item) throw new Error(`TF401232: Work item ${id} does not exist, or you do not have permissions to read it.`);
    return item;
  }

  private apiUrl(id: number): string {
    return `${DEMO_ORG}/_apis/wit/workItems/${id}`;
  }

  private raw(item: DemoItem): RawWorkItem {
    return { id: item.id, rev: item.rev, url: this.apiUrl(item.id), fields: { ...item.fields } };
  }

  private full(item: DemoItem, withRelations: boolean, only: string[] | null) {
    const fields = only
      ? Object.fromEntries(only.filter(f => f in item.fields).map(f => [f, item.fields[f]]))
      : { ...item.fields };
    const out: Record<string, unknown> = {
      id: item.id,
      rev: item.rev,
      url: this.apiUrl(item.id),
      fields,
      _links: { html: { href: `${DEMO_ORG}/${encodeURIComponent(DEMO_PROJECT)}/_workitems/edit/${item.id}` } },
    };
    if (withRelations) out.relations = this.relations(item);
    return out;
  }

  /** Parent first, then children — built fresh from the parent ids. */
  private relations(item: DemoItem) {
    const rels: { rel: string; url: string; attributes: { isLocked: boolean; name: string } }[] = [];
    if (item.parent) rels.push({ rel: PARENT_REL, url: this.apiUrl(item.parent), attributes: { isLocked: false, name: 'Parent' } });
    for (const child of this.items.values()) {
      if (child.parent === item.id) rels.push({ rel: CHILD_REL, url: this.apiUrl(child.id), attributes: { isLocked: false, name: 'Child' } });
    }
    return rels;
  }

  private comment(c: DemoItem['comments'][number]) {
    return { id: c.id, text: c.text, createdBy: ME, createdDate: c.createdDate };
  }

  private create(typeSegment: string, ops: PatchOp[]) {
    const type = decodeURIComponent(typeSegment);
    const now = this.now().toISOString();
    const item: DemoItem = {
      id: this.nextId++,
      rev: 0,
      fields: {
        'System.WorkItemType': type,
        'System.State': 'New',
        'System.AreaPath': DEMO_PROJECT,
        'System.IterationPath': DEMO_PROJECT,
        'System.CreatedDate': now,
        'System.CreatedBy': ME,
      },
      comments: [],
    };
    item.fields['System.Id'] = item.id;
    this.applyPatch(item, ops);
    this.items.set(item.id, item);
    return this.full(item, true, null);
  }

  private applyPatch(item: DemoItem, ops: PatchOp[]): void {
    // Check everything first, so a bad op leaves the item untouched — the
    // real board takes a whole patch or none of it.
    const next = { ...item.fields };
    let parent = item.parent;
    const rels = this.relations(item);
    for (const op of ops) {
      const field = op.path.match(/^\/fields\/(.+)$/);
      if (field) {
        const name = field[1];
        if (op.op === 'remove') {
          delete next[name];
          continue;
        }
        if (op.op !== 'add' && op.op !== 'replace') throw new Error(`The demo board doesn't know the patch op ${op.op} on ${op.path}`);
        let value = op.value;
        if (name === 'System.State' && !STATE_NAMES.has(String(value))) {
          throw new Error(`TF401320: '${String(value)}' is not a valid state for ${String(next['System.WorkItemType'])}.`);
        }
        if (name === 'System.AssignedTo' && typeof value === 'string') value = { displayName: DEMO_USER_NAME, uniqueName: value };
        next[name] = value;
        continue;
      }
      const rel = op.path.match(/^\/relations\/(\d+|-)$/);
      if (rel && op.op === 'remove' && rel[1] !== '-') {
        const r = rels[Number(rel[1])];
        if (r?.rel === PARENT_REL) parent = undefined;
        continue;
      }
      if (rel && op.op === 'add' && rel[1] === '-') {
        const v = op.value as { rel?: string; url?: string };
        const id = Number(v?.url?.match(/\/workItems\/(\d+)$/i)?.[1]);
        if (v?.rel !== PARENT_REL || !this.items.has(id)) {
          throw new Error(`The demo board can only add a parent link to an item it has (got ${JSON.stringify(op.value)})`);
        }
        parent = id;
        continue;
      }
      throw new Error(`The demo board doesn't know the patch op ${op.op} on ${op.path}`);
    }
    item.fields = next;
    item.parent = parent;
    if (parent) item.fields['System.Parent'] = parent;
    else delete item.fields['System.Parent'];
    if (!item.fields['System.AssignedTo']) item.fields['System.AssignedTo'] = ME;
    item.fields['System.ChangedDate'] = this.now().toISOString();
    item.fields['System.ChangedBy'] = ME;
    item.rev++;
    item.fields['System.Rev'] = item.rev;
  }
}

/* ============================================================ */
/*  WIQL — just the part sprintomatic writes                     */
/* ============================================================ */

type Clause = (item: DemoItem, now: Date) => boolean;

/** Pull the quoted strings out of `('a', 'b')`; `''` is a quote inside one. */
function quotedList(s: string): string[] {
  return [...s.matchAll(/'((?:[^']|'')*)'/g)].map(m => m[1].replace(/''/g, "'"));
}

function field(item: DemoItem, name: string): unknown {
  return item.fields[name];
}

function isMe(v: unknown): boolean {
  if (typeof v === 'string') return v === DEMO_USER;
  return typeof v === 'object' && v !== null && (v as { uniqueName?: string }).uniqueName === DEMO_USER;
}

/**
 * Turn the WHERE part of a WIQL statement into checks. Only AND is used by
 * sprintomatic, so only AND is understood; anything else is an error.
 */
export function parseWiql(wiql: string): Clause[] {
  const flat = wiql.replace(/\s+/g, ' ');
  const where = flat.match(/\bWHERE (.*?)(?: ORDER BY .*)?$/i)?.[1];
  if (!where) return [];
  const parts = where.split(/ AND (?=\[)/i).map(p => p.trim());
  return parts.map(part => {
    let m: RegExpMatchArray | null;
    if ((m = part.match(/^\[([^\]]+)\] = @Me$/i))) {
      const name = m[1];
      return item => isMe(field(item, name));
    }
    if ((m = part.match(/^\[([^\]]+)\] (NOT IN|IN) \((.*)\)$/i))) {
      const [, name, how, list] = m;
      const values = new Set(quotedList(list).map(v => v.toLowerCase()));
      const not = how.toUpperCase() === 'NOT IN';
      return item => values.has(String(field(item, name) ?? '').toLowerCase()) !== not;
    }
    if ((m = part.match(/^\[([^\]]+)\] (=|<>) '((?:[^']|'')*)'$/))) {
      const [, name, how, raw] = m;
      const value = raw.replace(/''/g, "'").toLowerCase();
      return item => (String(field(item, name) ?? '').toLowerCase() === value) === (how === '=');
    }
    if ((m = part.match(/^\[([^\]]+)\] (=|>|<|>=|<=) (-?\d+(?:\.\d+)?)$/))) {
      const [, name, how, raw] = m;
      const n = Number(raw);
      return item => {
        const v = field(item, name);
        if (typeof v !== 'number') return false;
        return how === '=' ? v === n : how === '>' ? v > n : how === '<' ? v < n : how === '>=' ? v >= n : v <= n;
      };
    }
    if ((m = part.match(/^\[([^\]]+)\] >= @Today(?: - (\d+))?$/i))) {
      const [, name, back] = m;
      return (item, now) => {
        const since = new Date(now.getFullYear(), now.getMonth(), now.getDate() - Number(back ?? 0));
        const v = field(item, name);
        return typeof v === 'string' && new Date(v) >= since;
      };
    }
    throw new Error(`The demo board doesn't understand this WIQL condition: ${part}`);
  });
}
