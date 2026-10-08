/**
 * One place that turns a work item into the name the user reads.
 *
 * The shape is always `**<title>** (#<id>)` — the name first, the number
 * after it in brackets. The user is not a developer: numbers are there to be
 * copied, names are there to be read. Every packet the tools ship carries this
 * string pre-built so nothing downstream has to guess at it, and the dashboard
 * parses the same shape back apart.
 *
 * When a fact is not backed by the board we drop that half of the name instead
 * of filling it with something plausible. A bare `#<id>` is the one place a
 * number is allowed to stand alone, and only when the title lookup really did
 * come back with nothing.
 */

/**
 * Build the reading name for a work item.
 *
 * - title and id known → `**Fix login** (#100001)`
 * - title unknown (missing, empty, only spaces) → `#100001`
 * - id unknown → `**Fix login**`
 * - neither known → an empty string
 *
 * The title goes out exactly as the board has it, padding aside. A star or an
 * underscore in a real title can make the bold render oddly, but escaping or
 * stripping it would show a name the board does not have, so it stays.
 */
export function displayNameFor(
  workItemId: number | string | null | undefined,
  title: string | null | undefined,
): string {
  const name = (title ?? '').trim();
  const id = workItemId == null ? '' : String(workItemId).trim();

  if (!name) return id ? `#${id}` : '';
  if (!id) return `**${name}**`;
  return `**${name}** (#${id})`;
}
