/**
 * Pure decisions for closing a Claude Code session. Kept out of mcp/server.ts
 * so the logic can be unit-tested without standing up the MCP server.
 */

/**
 * Should session_end refuse to close because the session ran a real stretch
 * but recorded nothing about what happened?
 *
 * A "substantive log" is a session_log entry of type progress / blocker /
 * decision. A closing summary does NOT count — that's the loophole this
 * closes: an agent that batches everything into one closing summary used to
 * sail through. Short sessions (under the threshold) are never required to
 * log, so a quick one-step task isn't forced to log twice.
 */
export function catchUpLogRequired(opts: {
  minutesOpen: number;
  hadSubstantiveLog: boolean;
  thresholdMinutes: number;
}): boolean {
  return opts.minutesOpen >= opts.thresholdMinutes && !opts.hadSubstantiveLog;
}
