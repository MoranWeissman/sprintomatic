/**
 * What an edit did to the board when it stopped part-way.
 *
 * `workitem_edit` writes one field at a time. If the fourth write fails, the
 * first three are already on the board — saying only "it failed" would leave
 * the user thinking nothing moved. So we name both halves: what changed, and
 * what didn't.
 *
 * Pure on purpose: field names in, two lists and one sentence out. No board
 * calls, nothing to mock, easy to pin with tests.
 */

/**
 * `storyPoints` is never asked for. It rides along whenever `effort` is set
 * (one point = one workday), so it lands on the board without anyone naming
 * it. Listing it back would read as a field the user asked to change.
 */
const RIDE_ALONG_FIELDS = new Set(['storyPoints']);

export interface EditOutcome {
  /** Field names that reached the board, in the order they were written. */
  landed: string[];
  /** Field names that were asked for and never reached the board. */
  missed: string[];
  /**
   * Null when nothing at all landed — the caller then just reports the error.
   * Otherwise a plain sentence naming both halves, ready to hand to the model.
   */
  message: string | null;
}

/**
 * @param requested Field names the caller asked for, in write order.
 * @param applied   What actually went through, keyed by field name.
 */
export function describeEditOutcome(
  requested: string[],
  applied: Record<string, unknown>,
): EditOutcome {
  const landed = Object.keys(applied).filter(k => !RIDE_ALONG_FIELDS.has(k));
  if (landed.length === 0) return { landed, missed: requested.slice(), message: null };
  const missed = requested.filter(k => !landed.includes(k));
  return {
    landed,
    missed,
    message:
      'Part of this edit DID go through, so tell the user plainly what the board looks like now. '
      + `Changed on the board: ${landed.join(', ')}. Not changed: ${missed.join(', ')}. `
      + "Don't repeat the whole edit — only retry the fields that didn't change.",
  };
}
