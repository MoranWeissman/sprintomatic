/**
 * Tasks waiting for a pull request to merge.
 *
 * The chat records the PR when it opens one for a task (task_pr_set). The
 * task gets a "Waiting for PR" tag so the board shows it, and the link is
 * kept here. When a chat opens, `checkTaskPrs` asks GitHub (through the `gh`
 * command) whether each PR merged, so a task doesn't sit open for days after
 * its PR went in.
 */
import { execFile } from 'node:child_process';
import { getDb } from './db';
import { displayNameFor } from './display-name';

export const WAITING_PR_TAG = 'Waiting for PR';

/** Don't ask GitHub about the same open PR more often than this. */
const RECHECK_MS = 10 * 60 * 1000;

export type PrState = 'OPEN' | 'MERGED' | 'CLOSED';

interface Row {
  work_item_id: number;
  pr_url: string;
  title: string;
  checked_at: string | null;
  pr_state: string | null;
}

/** A GitHub pull request link, cleaned up; null when it isn't one. */
export function cleanPrUrl(url: string): string | null {
  const m = url.trim().match(/^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)\b/);
  return m ? `https://github.com/${m[1]}/${m[2]}/pull/${m[3]}` : null;
}

export function addTaskPr(workItemId: number, title: string, prUrl: string, now = new Date()): void {
  getDb()
    .prepare(
      `INSERT INTO task_prs (work_item_id, pr_url, title, added_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (work_item_id, pr_url) DO UPDATE SET title = excluded.title`,
    )
    .run(workItemId, prUrl, title, now.toISOString());
}

/** Forget one PR (or every PR) of a task. Returns how many PRs it still has. */
export function removeTaskPrs(workItemId: number, prUrl?: string): number {
  const db = getDb();
  if (prUrl) db.prepare(`DELETE FROM task_prs WHERE work_item_id = ? AND pr_url = ?`).run(workItemId, prUrl);
  else db.prepare(`DELETE FROM task_prs WHERE work_item_id = ?`).run(workItemId);
  return taskPrCount(workItemId);
}

export function taskPrCount(workItemId: number): number {
  return getDb()
    .prepare<[number], { n: number }>(`SELECT COUNT(*) AS n FROM task_prs WHERE work_item_id = ?`)
    .get(workItemId)!.n;
}

/** Ask GitHub for a PR's state. Throws with gh's own words when it can't. */
export function ghPrState(prUrl: string): Promise<PrState> {
  return new Promise((resolve, reject) => {
    execFile('gh', ['pr', 'view', prUrl, '--json', 'state', '--jq', '.state'], { timeout: 8000 }, (err, out, stderr) => {
      if (err) {
        const code = (err as { code?: string }).code;
        reject(new Error(code === 'ENOENT' ? 'the gh command is not installed' : String(stderr || err.message).trim().split('\n')[0]));
        return;
      }
      const state = String(out).trim().toUpperCase();
      if (state === 'OPEN' || state === 'MERGED' || state === 'CLOSED') resolve(state);
      else reject(new Error(`gh gave an answer it doesn't usually give: ${state || 'nothing'}`));
    });
  });
}

export interface PrCheck {
  /** One sentence per task whose PR merged, ready to echo. */
  merged: { workItemId: number; prUrl: string; line: string }[];
  /** PRs closed without merging. */
  closed: { workItemId: number; prUrl: string; line: string }[];
  /** Set when GitHub couldn't be asked. Nothing is said about those PRs then. */
  checkError: string | null;
}

/**
 * Bring every recorded PR's state up to date (open ones at most every ten
 * minutes) and say which tasks have a merged or closed PR.
 */
export async function checkTaskPrs(
  { now = new Date(), getState = ghPrState }: { now?: Date; getState?: (url: string) => Promise<PrState> } = {},
): Promise<PrCheck> {
  const db = getDb();
  const rows = db.prepare<[], Row>(`SELECT work_item_id, pr_url, title, checked_at, pr_state FROM task_prs`).all();
  let checkError: string | null = null;
  await Promise.all(rows.map(async r => {
    if (r.pr_state === 'MERGED' || r.pr_state === 'CLOSED') return;
    if (r.checked_at && now.getTime() - Date.parse(r.checked_at) < RECHECK_MS) return;
    try {
      r.pr_state = await getState(r.pr_url);
      db.prepare(`UPDATE task_prs SET pr_state = ?, checked_at = ? WHERE work_item_id = ? AND pr_url = ?`)
        .run(r.pr_state, now.toISOString(), r.work_item_id, r.pr_url);
    } catch (e) {
      checkError ??= `Couldn't check a PR on GitHub (${e instanceof Error ? e.message : String(e)}). Is \`gh\` signed in to the account that can see it?`;
    }
  }));
  const line = (r: Row, what: string) => ({
    workItemId: r.work_item_id,
    prUrl: r.pr_url,
    line: `The PR for ${displayNameFor(r.work_item_id, r.title)} ${what}`,
  });
  return {
    merged: rows.filter(r => r.pr_state === 'MERGED').map(r => line(r, 'merged. Close the task?')),
    closed: rows.filter(r => r.pr_state === 'CLOSED').map(r => line(r, 'was closed without merging.')),
    checkError,
  };
}
