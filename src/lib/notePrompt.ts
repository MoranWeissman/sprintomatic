/**
 * Build the paste-into-a-chat prompt for a helper note's "Act on it" button.
 * Pure string assembly — no network, no React. The note body keeps its
 * `**title** (#id)` formatting so the chat can find the work item.
 */
export function buildNotePrompt(body: string, extra: string): string {
  const lines = [
    'Help me deal with this note from my sprint helper:',
    '',
    `"${body}"`,
  ];
  const trimmedExtra = extra.trim();
  if (trimmedExtra) {
    lines.push('', trimmedExtra);
  }
  lines.push('', "Let's talk it through and take care of it.");
  return lines.join('\n');
}
