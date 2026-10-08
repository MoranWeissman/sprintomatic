/** The model's tool-call markup sometimes leaks into a free-text arg
 *  ("...done.</text>\n<parameter name=\"remainingHoursAfter\">2"). Cut at the
 *  first sign of it and trim. Pure; safe on clean text. */
export function stripToolCallJunk(s: string): string {
  const cut = s.search(/<\/(text|parameter|standupSummary|question)>|<parameter\s+name=|<\/?invoke\b/i);
  return (cut >= 0 ? s.slice(0, cut) : s).trim();
}
