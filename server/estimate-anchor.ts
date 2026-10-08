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

function computeCalibration(items: WorkItem[]): AnchorCalibration {
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
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
