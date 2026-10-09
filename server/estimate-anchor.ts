/**
 * Estimate anchor — pull real "estimate vs actual" data from the user's closed
 * tasks so the AI proposes hour estimates anchored to history instead of pure
 * gut. Two layers:
 *
 *  - siblings: closed tasks under the SAME parent (User Story). Highest signal.
 *  - calibration: The user's recent closed tasks across the project. Yields a
 *    personal "things actually take ~Nx my estimate" ratio.
 *
 * The MCP tool returns both. The AI does the semantic narrowing (which
 * siblings are most like the task being estimated) — sprintomatic just
 * surfaces the numbers honestly.
 */
import { getWorkItem, listClosedCalibration, listClosedSiblings, type WorkItem } from './ado.js';

export interface AnchorSample {
  id: number;
  title: string;
  type: string;
  estimate: number;
  actual: number;
  ratio: number;
  closedAt: string;
}

export interface AnchorCalibration {
  samples: number;
  medianRatio: number | null;
  averageRatio: number | null;
  estimateSum: number;
  actualSum: number;
  /** Tasks ran on average about Nx their estimate. Plain-English number. */
  overallRatio: number | null;
  /** One plain sentence about how the user's guesses usually land. Echo it. */
  summary: string;
}

export interface EstimateAnchor {
  parent: {
    id: number;
    title: string;
    type: string;
  } | null;
  /** Empty when no parent was provided or no closed siblings exist yet. */
  siblings: AnchorSample[];
  calibration: AnchorCalibration;
  /** True when both lists are empty — caller should fall back to a labeled guess. */
  isColdStart: boolean;
}

const MAX_SIBLINGS = 8;
const MAX_CALIBRATION = 30;
/** Fewer finished tasks than this and the ratio is noise, so we don't claim one. */
export const MIN_CALIBRATION_SAMPLES = 5;

export async function buildEstimateAnchor(opts: {
  parentId?: number;
}): Promise<EstimateAnchor> {
  // Look up siblings + calibration in parallel.
  const [siblingsRaw, calibrationRaw, parentDetail] = await Promise.all([
    opts.parentId ? listClosedSiblings(opts.parentId).catch(() => [] as WorkItem[]) : Promise.resolve([] as WorkItem[]),
    listClosedCalibration().catch(() => [] as WorkItem[]),
    opts.parentId ? getWorkItem(opts.parentId).catch(() => null) : Promise.resolve(null),
  ]);

  const siblings = siblingsRaw
    .slice(0, MAX_SIBLINGS)
    .map(w => toSample(w))
    .filter((s): s is AnchorSample => s != null);

  const calibration = computeCalibration(calibrationRaw.slice(0, MAX_CALIBRATION));

  const parent = parentDetail
    ? { id: parentDetail.id, title: parentDetail.title, type: parentDetail.type }
    : null;

  return {
    parent,
    siblings,
    calibration,
    isColdStart: siblings.length === 0 && calibration.samples === 0,
  };
}

/** Just the "how far off are my guesses" part, for the Retro page. */
export async function buildCalibration(): Promise<AnchorCalibration> {
  return computeCalibration((await listClosedCalibration()).slice(0, MAX_CALIBRATION));
}

function toSample(w: WorkItem): AnchorSample | null {
  if (w.originalEstimate == null || w.completedWork == null) return null;
  if (w.originalEstimate <= 0 || w.completedWork <= 0) return null;
  return {
    id: w.id,
    title: w.title,
    type: w.type,
    estimate: round2(w.originalEstimate),
    actual: round2(w.completedWork),
    ratio: round2(w.completedWork / w.originalEstimate),
    closedAt: w.changedDate,
  };
}

export function computeCalibration(items: WorkItem[]): AnchorCalibration {
  const ratios: number[] = [];
  let estimateSum = 0;
  let actualSum = 0;
  for (const w of items) {
    if (w.originalEstimate == null || w.completedWork == null) continue;
    if (w.originalEstimate <= 0 || w.completedWork <= 0) continue;
    estimateSum += w.originalEstimate;
    actualSum += w.completedWork;
    ratios.push(w.completedWork / w.originalEstimate);
  }
  if (ratios.length === 0) {
    return {
      samples: 0,
      medianRatio: null,
      averageRatio: null,
      estimateSum: 0,
      actualSum: 0,
      overallRatio: null,
      summary: estimateHabitLine(0, null),
    };
  }
  ratios.sort((a, b) => a - b);
  const median = ratios[Math.floor(ratios.length / 2)];
  const average = ratios.reduce((s, r) => s + r, 0) / ratios.length;
  const overall = actualSum / estimateSum;
  return {
    samples: ratios.length,
    medianRatio: round2(median),
    averageRatio: round2(average),
    estimateSum: round2(estimateSum),
    actualSum: round2(actualSum),
    overallRatio: round2(overall),
    summary: estimateHabitLine(ratios.length, median),
  };
}

/**
 * The plain sentence for "how far off are my guesses?". Uses the median, so
 * one task that ran 10x long doesn't speak for all the others.
 */
export function estimateHabitLine(samples: number, medianRatio: number | null): string {
  if (samples < MIN_CALIBRATION_SAMPLES || medianRatio == null) {
    const sofar = samples === 0 ? 'none yet' : `${samples} so far`;
    return `Not enough finished tasks yet to tell how your guesses compare with the real hours (${sofar}; it needs ${MIN_CALIBRATION_SAMPLES} with both an estimate and logged hours).`;
  }
  const from = `from your last ${samples} finished tasks`;
  const r = Math.round(medianRatio * 10) / 10;
  if (r >= 0.9 && r <= 1.1) {
    return `Your guesses are usually about right: the real hours land close to the estimate (${from}).`;
  }
  const example = Math.round(4 * r * 2) / 2;
  if (r > 1.1) {
    return `You usually take about ${r}x your guess, so a 4-hour guess tends to end up near ${example} hours (${from}).`;
  }
  return `You usually finish faster than your guess, about ${r}x, so a 4-hour guess tends to end up near ${example} hours (${from}).`;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
