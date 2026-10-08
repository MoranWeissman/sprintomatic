/**
 * Outlook calendar reader (slice R5).
 *
 * Fetches the user's published ICS feed (URL stored locally in the settings
 * table), parses it, expands recurring events, and returns busy intervals
 * for capacity math. No app registration, no OAuth — just an HTTPS GET
 * against the URL the user pasted in once.
 *
 * Setup: see docs/setup/outlook-calendar.md.
 */
import ical from 'node-ical';
import { getSetting, setSetting } from './timers';

const URL_SETTING_KEY = 'calendar_ics_url';
const CACHE_TTL_MS = 5 * 60 * 1000;

type BusyStatus = 'BUSY' | 'TENTATIVE' | 'OOF' | 'FREE' | 'UNKNOWN';

export interface BusyInterval {
  summary: string;
  start: Date;
  end: Date;
  busyStatus: BusyStatus;
  durationMinutes: number;
  /** true if this came from an RRULE expansion (vs a single instance). */
  recurrent: boolean;
}

let cache: { fetchedAt: number; ics: string; url: string } | null = null;

export function getCalendarUrl(): string | null {
  const v = getSetting(URL_SETTING_KEY);
  return v && v.length > 0 ? v : null;
}

export function setCalendarUrl(url: string | null): void {
  setSetting(URL_SETTING_KEY, url ?? '');
  cache = null;
}

const FETCH_TIMEOUT_MS = 15_000;

async function fetchIcs(force = false): Promise<string> {
  const url = getCalendarUrl();
  if (!url) {
    throw new Error(
      'No Outlook calendar URL is configured. Set one with the calendar_set_url MCP tool. See docs/setup/outlook-calendar.md.',
    );
  }
  if (!force && cache && cache.url === url && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.ics;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, { signal: controller.signal });
  } catch (e) {
    if ((e as Error).name === 'AbortError') {
      throw new Error(`Calendar fetch timed out after ${FETCH_TIMEOUT_MS / 1000}s — Outlook's publish endpoint may be slow right now. Try again in a moment.`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    throw new Error(`Calendar fetch failed: HTTP ${res.status} ${res.statusText}`);
  }
  const ics = await res.text();
  cache = { fetchedAt: Date.now(), ics, url };
  return ics;
}

function normalizeBusyStatus(e: Record<string, unknown>): BusyStatus {
  const raw = String(e['MICROSOFT-CDO-BUSYSTATUS'] ?? e.summary ?? '').toUpperCase();
  if (raw === 'BUSY') return 'BUSY';
  if (raw === 'TENTATIVE') return 'TENTATIVE';
  if (raw === 'OOF' || raw === 'OUT OF OFFICE') return 'OOF';
  if (raw === 'FREE') return 'FREE';
  return 'UNKNOWN';
}

/**
 * Return all busy intervals that overlap the [start, end] window, with
 * recurring events expanded. Skips FREE intervals — they don't reserve time.
 */
export async function listBusyInWindow(start: Date, end: Date): Promise<BusyInterval[]> {
  const ics = await fetchIcs();
  const parsed = ical.parseICS(ics) as Record<string, Record<string, unknown>>;
  const intervals: BusyInterval[] = [];

  for (const key of Object.keys(parsed)) {
    const e = parsed[key];
    if (e.type !== 'VEVENT') continue;

    const status = normalizeBusyStatus(e);
    if (status === 'FREE') continue; // doesn't reserve time

    const summary = String(e.summary ?? '(no subject)');
    const rrule = e.rrule as { between(s: Date, en: Date, inclusive?: boolean): Date[] } | undefined;
    const eStart = e.start as Date | undefined;
    const eEnd = e.end as Date | undefined;
    if (!eStart || !eEnd) continue;
    const durMs = eEnd.getTime() - eStart.getTime();

    if (rrule) {
      const occs = rrule.between(start, end, true);
      const exdates = (e.exdate ? Object.values(e.exdate) : []) as Date[];
      for (const occ of occs) {
        if (exdates.some(d => d.getTime() === occ.getTime())) continue;
        const occEnd = new Date(occ.getTime() + durMs);
        intervals.push({
          summary,
          start: occ,
          end: occEnd,
          busyStatus: status,
          durationMinutes: durMs / 60000,
          recurrent: true,
        });
      }
    } else {
      if (eEnd < start || eStart > end) continue;
      intervals.push({
        summary,
        start: eStart,
        end: eEnd,
        busyStatus: status,
        durationMinutes: durMs / 60000,
        recurrent: false,
      });
    }
  }

  intervals.sort((a, b) => a.start.getTime() - b.start.getTime());
  return intervals;
}

/** An all-day calendar entry as inclusive local dates (YYYY-MM-DD). */
export interface AllDayEntry {
  start: string;
  /** INCLUSIVE last day. ICS DTEND on all-day events is EXCLUSIVE (an event
   *  0826→0828 covers the 26th and the 27th); this field is normalized so
   *  0828 becomes 2026-08-27. */
  end: string;
}

function isoDateOf(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate(),
  ).padStart(2, '0')}`;
}

/**
 * The pure half of {@link listAllDayInWindow}: pulls all-day events out of an
 * already-parsed ICS object. Split out so tests can feed it a small parsed
 * feed without any fetching.
 *
 * Busy status is deliberately NOT filtered — the user's days off are
 * published as all-day FREE, which is exactly what listBusyInWindow drops.
 * Recurring all-day series (birthdays and the like) are skipped: a real day
 * off is a one-off entry, and a yearly series would raise the same question
 * forever.
 */
export function allDayEntriesFromParsed(
  parsed: Record<string, Record<string, unknown>>,
  windowStart: Date,
  windowEnd: Date,
): AllDayEntry[] {
  const winStart = isoDateOf(windowStart);
  const winEnd = isoDateOf(windowEnd);
  const entries: AllDayEntry[] = [];

  for (const key of Object.keys(parsed)) {
    const e = parsed[key];
    if (e.type !== 'VEVENT') continue;
    if (e.rrule) continue; // recurring series are never a one-off day off

    const eStart = e.start as (Date & { dateOnly?: boolean }) | undefined;
    if (!eStart) continue;
    // node-ical marks date-only values twice over: datetype 'date' on the
    // event, dateOnly on the parsed Date. Either is enough.
    const isAllDay = e.datetype === 'date' || eStart.dateOnly === true;
    if (!isAllDay) continue;

    const start = isoDateOf(eStart);
    const eEnd = e.end as Date | undefined;
    let end = start;
    if (eEnd) {
      // DTEND is exclusive: step back one day to the inclusive last day.
      // Some producers ship DTEND == DTSTART for a single day; the clamp
      // below keeps that from going backwards.
      const inclusive = new Date(eEnd.getFullYear(), eEnd.getMonth(), eEnd.getDate() - 1);
      end = isoDateOf(inclusive);
      if (end < start) end = start;
    }

    if (start > winEnd || end < winStart) continue; // outside the window
    entries.push({ start, end });
  }

  entries.sort((a, b) => (a.start === b.start ? (a.end < b.end ? -1 : 1) : a.start < b.start ? -1 : 1));
  return entries;
}

/**
 * All-day events that overlap the [windowStart, windowEnd] window, regardless
 * of busy status. Uses the same fetched-and-cached feed as listBusyInWindow.
 */
export async function listAllDayInWindow(
  windowStart: Date,
  windowEnd: Date,
): Promise<AllDayEntry[]> {
  const ics = await fetchIcs();
  const parsed = ical.parseICS(ics) as Record<string, Record<string, unknown>>;
  return allDayEntriesFromParsed(parsed, windowStart, windowEnd);
}
