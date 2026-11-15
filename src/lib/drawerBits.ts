/**
 * Small pure helpers for the work item drawer and the Plan page's buttons.
 */

/** Hours typed into a box → a number in (0, 999], or null when it isn't one. */
export function parseHours(raw: string): number | null {
  const t = raw.trim();
  if (t === '') return null;
  const h = Number(t.replace(',', '.'));
  if (!Number.isFinite(h) || h <= 0 || h > 999) return null;
  return h;
}

/**
 * Board text is sometimes escaped twice, so the page shows `&lt;env&gt;`
 * instead of `<env>`. Undo the second escape only: the result is still an
 * escaped entity, so no new tags can appear.
 */
export function undoDoubleEscape(html: string): string {
  return html.replace(/&amp;(lt|gt|amp|quot|apos|nbsp|#\d+|#x[0-9a-f]+);/gi, '&$1;');
}

/**
 * Which of Assigned to / Area / Priority are worth showing. Most of the time
 * they say the same thing on every item (it's the user's, in the usual area,
 * normal priority), so they only show when they are unusual.
 */
export function unusualMeta(item: {
  assignedTo?: string;
  createdBy?: string;
  areaPath: string;
  iterationPath: string;
  priority?: number;
}): { assignedTo?: string; area?: string; priority?: number } {
  const out: { assignedTo?: string; area?: string; priority?: number } = {};
  if (!item.assignedTo) out.assignedTo = 'nobody';
  else if (item.createdBy && item.assignedTo !== item.createdBy) out.assignedTo = item.assignedTo;
  const project = (p: string) => p.split('\\')[0];
  if (item.areaPath && project(item.areaPath) !== project(item.iterationPath)) {
    out.area = item.areaPath.split('\\').pop() ?? item.areaPath;
  }
  // 2 is the board's default priority.
  if (item.priority != null && item.priority !== 2) out.priority = item.priority;
  return out;
}

/** Seconds → "7h 02m", "45m", "0h". */
export function fmtSpent(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h === 0 && m === 0) return '0h';
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${String(m).padStart(2, '0')}m`;
}
