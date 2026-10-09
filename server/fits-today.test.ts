import { describe, it, expect } from 'vitest';
import { buildFitsToday } from './fits-today';

const t = (id: number, remainingHours: number) => ({ id, title: `Example task ${id}`, remainingHours });

describe('buildFitsToday', () => {
  it('puts tasks already going first, skips one too big, and tries the next', () => {
    const r = buildFitsToday({
      freeHours: 5,
      going: [t(100001, 2)],
      waiting: [t(100002, 4), t(100003, 3)],
      hasCalendar: true,
      isWorkToday: true,
    });
    expect(r.fits.map(f => f.id)).toEqual([100001, 100003]);
    expect(r.summary).toBe(
      'You have about 5 hours free today. You can finish these 2: **Example task 100001** (#100001) (2 hours left), **Example task 100003** (#100003) (3 hours left). That is about 5 hours.',
    );
  });

  it('says so plainly when nothing can be finished', () => {
    const r = buildFitsToday({ freeHours: 1, going: [t(100001, 3)], waiting: [], hasCalendar: true, isWorkToday: true });
    expect(r.fits).toEqual([]);
    expect(r.summary).toMatch(/None of your open tasks can be finished in that/);
  });

  it('says there is no desk time left at the end of the day', () => {
    const r = buildFitsToday({ freeHours: 0.2, going: [t(100001, 0.1)], waiting: [], hasCalendar: true, isWorkToday: true });
    expect(r.summary).toBe('No free desk time left today.');
  });

  it('says so on a day that is not a working day', () => {
    const r = buildFitsToday({ freeHours: 0, going: [t(100001, 1)], waiting: [], hasCalendar: true, isWorkToday: false });
    expect(r.fits).toEqual([]);
    expect(r.summary).toMatch(/not one of your working days/);
  });

  it('says meetings are not counted when no calendar is connected', () => {
    const r = buildFitsToday({ freeHours: 4, going: [t(100001, 1)], waiting: [], hasCalendar: false, isWorkToday: true });
    expect(r.summary).toMatch(/No calendar is connected/);
  });

  it('skips tasks with no hours left', () => {
    const r = buildFitsToday({ freeHours: 4, going: [t(100001, 0)], waiting: [t(100002, 1)], hasCalendar: true, isWorkToday: true });
    expect(r.fits.map(f => f.id)).toEqual([100002]);
    expect(r.summary).toMatch(/this one/);
  });
});
