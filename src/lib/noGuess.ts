/**
 * A task with no guess adds nothing to "of Xh guessed", so the story looks
 * smaller than it is. This says so, so the low number isn't trusted.
 */
export function noGuessLine(count: number): string | null {
  if (count <= 0) return null;
  return count === 1
    ? "1 open task has no guess, so it isn't in this number."
    : `${count} open tasks have no guess, so they aren't in this number.`;
}
