/**
 * Thrown when sprintomatic can't reach the board because something was never
 * filled in (no organization, no token, …) — as opposed to the board being
 * down or a sign-in running out. The dashboard shows a "not set up yet" screen
 * for this one instead of an error.
 */
export class SetupNeededError extends Error {
  readonly setupNeeded = true;
  constructor(message: string) {
    super(message);
    this.name = 'SetupNeededError';
  }
}

export function isSetupNeeded(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as { setupNeeded?: unknown }).setupNeeded === true;
}
