import { useEffect, useState } from 'react';
import type { SprintContext, SprintDay } from './types';

const WEEKDAYS_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS_LONG = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const WEEKDAYS_SHORT = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

/** Live every-second clock. Triggers re-render once per second. */
export function useNow(intervalMs = 1000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

/** "Thursday, May 26" — long form for the hero greeting. */
export function formatLongDate(d: Date): string {
  return `${WEEKDAYS_LONG[d.getDay()]}, ${MONTHS_LONG[d.getMonth()]} ${d.getDate()}`;
}

/** "09:14" — local HH:MM 24-hour. */
export function formatClock(d: Date): string {
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}

/** Day-of-sprint (1-indexed). Returns clamped value between 1 and sprint.totalDays. */
export function dayOfSprint(sprint: SprintContext, now: Date): number {
  const start = startOfDay(sprint.startDate);
  const today = startOfDay(now);
  const ms = today.getTime() - start.getTime();
  const day = Math.floor(ms / (1000 * 60 * 60 * 24)) + 1;
  return Math.max(1, Math.min(sprint.totalDays, day));
}

function startOfDay(d: Date): Date {
  const c = new Date(d);
  c.setHours(0, 0, 0, 0);
  return c;
}

/**
 * Greeting based on local hour.
 * 12:00–13:59 is "around noon" — the user specifically noted that "afternoon"
 * at 13:33 felt too late.
 */
export function greetingForHour(d: Date): string {
  const h = d.getHours();
  if (h >= 5 && h < 12) return 'Good morning';
  if (h >= 12 && h < 14) return 'Around noon';
  if (h >= 14 && h < 18) return 'Good afternoon';
  if (h >= 18 && h < 22) return 'Good evening';
  return 'Working late';
}

/** Returns each day of the sprint with its weekday letter and state for the rail. */
export function sprintDays(sprint: SprintContext, now: Date): SprintDay[] {
  const todayIdx = dayOfSprint(sprint, now) - 1;
  return Array.from({ length: sprint.totalDays }, (_, i) => {
    const d = new Date(sprint.startDate);
    d.setDate(d.getDate() + i);
    const dow = d.getDay();
    return {
      index: i,
      label: WEEKDAYS_SHORT[dow],
      state: i < todayIdx ? 'past' : i === todayIdx ? 'today' : 'future',
      isOff: !sprint.workingDays.includes(dow),
    };
  });
}

/** Elapsed sec → "1h 12m" (rolls minutes up to hours; 0h hides the hour part). */
export function fmtHM(baseSec: number, tick: number): string {
  const total = baseSec + tick;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  if (h === 0) return `${m}m`;
  return `${h}h ${String(m).padStart(2, '0')}m`;
}

/** Estimate minutes → "2h" or "1h 30m". */
export function fmtEstimate(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}
