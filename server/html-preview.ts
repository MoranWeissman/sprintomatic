/**
 * Strip HTML tags + decode entities into plain text, preserving paragraph
 * breaks as newlines. No truncation — use this for reading panes.
 */
export function htmlToText(html: string | undefined): string | undefined {
  if (!html) return undefined;
  const text = html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text || undefined;
}

/** Single-line summary for cards: plain text, whitespace collapsed, capped at 280 chars. */
export function htmlPreview(html: string | undefined): string | undefined {
  const text = htmlToText(html)?.replace(/\s+/g, ' ');
  if (!text) return undefined;
  return text.length > 280 ? text.slice(0, 277).trimEnd() + '…' : text;
}
