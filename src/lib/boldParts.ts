/**
 * Notes come with the board's `**title**` marks. Split the text so the screen
 * can draw those parts bold instead of showing the stars.
 */
export function boldParts(text: string): Array<{ text: string; bold: boolean }> {
  return text
    .split(/\*\*(.+?)\*\*/)
    .map((part, i) => ({ text: part, bold: i % 2 === 1 }))
    .filter(p => p.text !== '');
}
