import { describe, expect, it } from 'vitest';
import type { Season } from '../graph/types.js';
import { analyzeDate, computeDerivedValues } from './derived.js';
import { business } from './testing.js';

const utc = business();
const la = business({ timezone: 'America/Los_Angeles' });

describe('computeDerivedValues — calendar', () => {
  it('date-only: that calendar day in the business timezone', () => {
    const now = new Date('2026-07-01T00:00:00Z');
    expect(computeDerivedValues('2026-07-04', now, utc)).toMatchObject({
      dayOfWeek: 6,
      weekday: 'sat',
      isWeekend: true,
    });
    // Same date-only input is still Saturday in LA (never shifted by UTC parsing).
    expect(computeDerivedValues('2026-07-04', now, la)).toMatchObject({ dayOfWeek: 6, weekday: 'sat' });
    expect(computeDerivedValues('2026-07-06', now, utc)).toMatchObject({ dayOfWeek: 1, weekday: 'mon', isWeekend: false });
  });

  it('date-time: the business-local calendar day of the instant', () => {
    const now = new Date('2026-07-01T00:00:00Z');
    // 02:00Z on Saturday is still Friday evening in Los Angeles.
    expect(computeDerivedValues('2026-07-04T02:00:00Z', now, la)).toMatchObject({ dayOfWeek: 5, weekday: 'fri', isWeekend: false });
    expect(computeDerivedValues('2026-07-04T02:00:00Z', now, utc)).toMatchObject({ dayOfWeek: 6, isWeekend: true });
  });
});

describe('computeDerivedValues — lead time', () => {
  it('fractional hours, floored days', () => {
    const now = new Date('2026-07-01T00:00:00Z');
    expect(computeDerivedValues('2026-07-04', now, utc)).toMatchObject({ leadTimeHours: 72, leadTimeDays: 3 });
    expect(computeDerivedValues('2026-07-02T12:30:00Z', now, utc)).toMatchObject({ leadTimeHours: 36.5, leadTimeDays: 1 });
    expect(computeDerivedValues('2026-07-07T23:00:00Z', now, utc)).toMatchObject({ leadTimeDays: 6 });
  });

  it('date-only lead time runs to local midnight of that day', () => {
    const now = new Date('2026-07-01T07:00:00Z'); // LA midnight July 1
    expect(computeDerivedValues('2026-07-02', now, la)).toMatchObject({ leadTimeHours: 24, leadTimeDays: 1 });
  });

  it('honours explicit offsets and treats offset-less date-times as business wall clock', () => {
    const now = new Date('2026-07-04T00:00:00Z');
    expect(analyzeDate('2026-07-04T09:00:00-07:00', now, utc)?.start.toISOString()).toBe('2026-07-04T16:00:00.000Z');
    expect(analyzeDate('2026-07-04T09:00', now, la)?.start.toISOString()).toBe('2026-07-04T16:00:00.000Z');
    expect(analyzeDate('2026-07-04T09:00:30.5', now, utc)?.start.toISOString()).toBe('2026-07-04T09:00:30.500Z');
  });

  it('clamps derived lead time at 0 but exposes the raw (negative) lead', () => {
    const now = new Date('2026-07-04T12:00:00Z');
    const a = analyzeDate('2026-07-04T06:00:00Z', now, utc);
    expect(a?.values).toMatchObject({ leadTimeHours: 0, leadTimeDays: 0 });
    expect(a?.rawLeadHours).toBe(-6);
    expect(a?.inPast).toBe(true);
  });
});

describe('analyzeDate — past dates', () => {
  it('date-only today is not past (lead clamped to 0); yesterday is', () => {
    const now = new Date('2026-07-04T15:00:00Z');
    const today = analyzeDate('2026-07-04', now, utc);
    expect(today?.inPast).toBe(false);
    expect(today?.rawLeadHours).toBe(-15);
    expect(today?.values.leadTimeHours).toBe(0);
    expect(analyzeDate('2026-07-03', now, utc)?.inPast).toBe(true);
  });

  it('"today" is the business-local date', () => {
    const now = new Date('2026-07-04T03:00:00Z'); // July 3, 20:00 in LA
    expect(analyzeDate('2026-07-03', now, la)?.inPast).toBe(false);
    expect(analyzeDate('2026-07-02', now, la)?.inPast).toBe(true);
    expect(analyzeDate('2026-07-03', now, utc)?.inPast).toBe(true);
  });

  it('date-time in the past is past; in the future is not', () => {
    const now = new Date('2026-07-04T12:00:00Z');
    expect(analyzeDate('2026-07-04T11:59:00Z', now, utc)?.inPast).toBe(true);
    expect(analyzeDate('2026-07-04T12:01:00Z', now, utc)?.inPast).toBe(false);
  });
});

describe('analyzeDate — invalid input', () => {
  const now = new Date('2026-07-01T00:00:00Z');
  it.each([
    '2026-02-30',
    'tomorrow',
    '2026-07-04T25:00Z',
    '2026-7-4',
    '2026-07-04T09:00:00+25:00',
    '',
    '1899-12-31',
    '0001-01-01',
    '0099-06-01T10:00:00Z',
  ])('%s', (input) => {
    expect(analyzeDate(input, now, utc)).toBeUndefined();
    expect(computeDerivedValues(input, now, utc)).toEqual({});
  });

  it('a wall time inside a DST gap is unparsable', () => {
    expect(analyzeDate('2026-03-08T02:30', now, business({ timezone: 'America/New_York' }))).toBeUndefined();
  });

  it('an invalid timezone falls back to UTC', () => {
    expect(computeDerivedValues('2026-07-04T02:00:00Z', now, business({ timezone: 'Mars/Olympus' }))).toMatchObject({ dayOfWeek: 6 });
  });
});

describe('computeDerivedValues — seasons', () => {
  const seasons: Season[] = [
    { name: 'summer', kind: 'peak', from: '06-01', to: '08-31' },
    { name: 'holidays', kind: 'peak', from: '12-15', to: '01-15' },
    { name: 'november_2026', kind: 'off_peak', from: '2026-11-01', to: '2026-11-30' },
    { name: 'weekends', kind: 'custom', days: [0, 6] },
  ];
  const b = business({ seasons });
  const now = new Date('2026-01-01T00:00:00Z');
  const at = (date: string) => computeDerivedValues(date, now, b);

  it('recurring range, inclusive bounds; first matching season named', () => {
    expect(at('2026-06-01')).toMatchObject({ isPeak: true, isOffPeak: false, season: 'summer' });
    expect(at('2026-08-31')).toMatchObject({ isPeak: true, season: 'summer' });
    expect(at('2027-07-04')).toMatchObject({ isPeak: true, season: 'summer' }); // Sunday, summer listed first
  });

  it('recurring range wrapping the year end', () => {
    expect(at('2026-12-20')).toMatchObject({ isPeak: true, season: 'holidays' });
    expect(at('2027-01-15')).toMatchObject({ isPeak: true, season: 'holidays' });
    expect(at('2027-01-16')).toMatchObject({ isPeak: false });
  });

  it('absolute range only matches that year', () => {
    expect(at('2026-11-10')).toMatchObject({ isPeak: false, isOffPeak: true, season: 'november_2026' });
    expect(at('2027-11-10')).toMatchObject({ isOffPeak: false });
  });

  it('days filter with open bounds', () => {
    expect(at('2026-10-03')).toMatchObject({ isPeak: false, isOffPeak: false, season: 'weekends' }); // Saturday
  });

  it("no match: flags false, season 'none'", () => {
    expect(at('2026-10-06')).toMatchObject({ isPeak: false, isOffPeak: false, season: 'none' }); // Tuesday
  });

  it('no date, no season value', () => {
    expect(computeDerivedValues('nope', now, b)).not.toHaveProperty('season');
  });

  it('year bounds 1900–9999 are valid', () => {
    expect(analyzeDate('1900-01-01', now, utc)).toBeDefined();
    expect(analyzeDate('9999-12-31', now, utc)).toBeDefined();
  });

  it('open-ended bounds and empty days list', () => {
    const open = business({
      seasons: [
        { name: 'from_only', kind: 'peak', from: '2026-09-01' },
        { name: 'never', kind: 'off_peak', days: [] },
      ],
    });
    expect(computeDerivedValues('2030-01-01', now, open)).toMatchObject({ isPeak: true, isOffPeak: false, season: 'from_only' });
    expect(computeDerivedValues('2026-08-31', now, open)).toMatchObject({ isPeak: false, isOffPeak: false });
  });

  it('seasons use the local calendar day', () => {
    const laSeasons = business({ timezone: 'America/Los_Angeles', seasons });
    // 2026-06-01T03:00Z is still May 31 in LA.
    expect(computeDerivedValues('2026-06-01T03:00:00Z', now, laSeasons)).toMatchObject({ isPeak: false });
  });
});
