import { describe, it, expect } from 'vitest';
import ical from 'node-ical';
import { allDayEntriesFromParsed } from './calendar';

/**
 * The parsing half of the all-day reader is pure — feed it a small ICS text
 * parsed offline (node-ical parses synchronously, no network) and check what
 * comes out. The fetch/caching half is shared with listBusyInWindow and is
 * exercised there.
 */

function parse(ics: string) {
  return ical.parseICS(ics) as Record<string, Record<string, unknown>>;
}

const wrap = (events: string) =>
  ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//test//EN', events, 'END:VCALENDAR'].join('\r\n');

const WIN_START = new Date(2026, 7, 23); // Sun 23 Aug 2026
const WIN_END = new Date(2026, 8, 3, 23, 59); // Thu 3 Sep 2026

describe('allDayEntriesFromParsed', () => {
  it('normalizes the exclusive DTEND to the inclusive last day', () => {
    // 0826 → 0828 covers the 26th and the 27th.
    const parsed = parse(wrap([
      'BEGIN:VEVENT',
      'UID:100001@test',
      'DTSTAMP:20260801T000000Z',
      'DTSTART;VALUE=DATE:20260826',
      'DTEND;VALUE=DATE:20260828',
      'SUMMARY:Vacation',
      'X-MICROSOFT-CDO-BUSYSTATUS:FREE',
      'END:VEVENT',
    ].join('\r\n')));
    expect(allDayEntriesFromParsed(parsed, WIN_START, WIN_END)).toEqual([
      { start: '2026-08-26', end: '2026-08-27' },
    ]);
  });

  it('keeps FREE all-day entries — busy status is not filtered here', () => {
    const parsed = parse(wrap([
      'BEGIN:VEVENT',
      'UID:100002@test',
      'DTSTAMP:20260801T000000Z',
      'DTSTART;VALUE=DATE:20260827',
      'DTEND;VALUE=DATE:20260828',
      'SUMMARY:Someone out',
      'X-MICROSOFT-CDO-BUSYSTATUS:FREE',
      'END:VEVENT',
    ].join('\r\n')));
    expect(allDayEntriesFromParsed(parsed, WIN_START, WIN_END)).toEqual([
      { start: '2026-08-27', end: '2026-08-27' },
    ]);
  });

  it('skips timed events entirely', () => {
    const parsed = parse(wrap([
      'BEGIN:VEVENT',
      'UID:100003@test',
      'DTSTAMP:20260801T000000Z',
      'DTSTART:20260827T100000Z',
      'DTEND:20260827T110000Z',
      'SUMMARY:A meeting',
      'END:VEVENT',
    ].join('\r\n')));
    expect(allDayEntriesFromParsed(parsed, WIN_START, WIN_END)).toEqual([]);
  });

  it('skips all-day events outside the window', () => {
    const parsed = parse(wrap([
      'BEGIN:VEVENT',
      'UID:100004@test',
      'DTSTAMP:20260801T000000Z',
      'DTSTART;VALUE=DATE:20260910',
      'DTEND;VALUE=DATE:20260911',
      'SUMMARY:Later vacation',
      'END:VEVENT',
    ].join('\r\n')));
    expect(allDayEntriesFromParsed(parsed, WIN_START, WIN_END)).toEqual([]);
  });

  it('keeps an all-day event that only partly overlaps the window', () => {
    // 0901 → 0906 exclusive = 1st..5th inclusive; the window ends on the 3rd.
    const parsed = parse(wrap([
      'BEGIN:VEVENT',
      'UID:100005@test',
      'DTSTAMP:20260801T000000Z',
      'DTSTART;VALUE=DATE:20260901',
      'DTEND;VALUE=DATE:20260906',
      'SUMMARY:Long vacation',
      'END:VEVENT',
    ].join('\r\n')));
    expect(allDayEntriesFromParsed(parsed, WIN_START, WIN_END)).toEqual([
      { start: '2026-09-01', end: '2026-09-05' },
    ]);
  });

  it('skips recurring all-day series (a birthday is never a one-off day off)', () => {
    const parsed = parse(wrap([
      'BEGIN:VEVENT',
      'UID:100006@test',
      'DTSTAMP:20260801T000000Z',
      'DTSTART;VALUE=DATE:20260827',
      'DTEND;VALUE=DATE:20260828',
      'RRULE:FREQ=YEARLY',
      'SUMMARY:A birthday',
      'END:VEVENT',
    ].join('\r\n')));
    expect(allDayEntriesFromParsed(parsed, WIN_START, WIN_END)).toEqual([]);
  });

  it('an all-day event with DTEND equal to DTSTART still covers its one day', () => {
    const parsed = parse(wrap([
      'BEGIN:VEVENT',
      'UID:100007@test',
      'DTSTAMP:20260801T000000Z',
      'DTSTART;VALUE=DATE:20260827',
      'DTEND;VALUE=DATE:20260827',
      'SUMMARY:Odd producer',
      'END:VEVENT',
    ].join('\r\n')));
    expect(allDayEntriesFromParsed(parsed, WIN_START, WIN_END)).toEqual([
      { start: '2026-08-27', end: '2026-08-27' },
    ]);
  });
});
