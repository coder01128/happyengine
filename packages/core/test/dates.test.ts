import { describe, expect, it } from 'vitest';
import { addDays, addMonths, todayInZone } from '../src/index.ts';

describe('addMonths (calendar months, clamped to the month end)', () => {
  it.each([
    ['2026-01-31', 1, '2026-02-28'],
    ['2027-01-31', -3, '2026-10-31'],
    ['2026-10-31', -3, '2026-07-31'],
    ['2026-05-31', -3, '2026-02-28'],
    ['2024-02-29', 12, '2025-02-28'],
    ['2024-01-31', 1, '2024-02-29'],
    ['2026-03-01', 12, '2027-03-01'],
    ['2026-12-15', 1, '2027-01-15'],
    ['2027-01-15', -1, '2026-12-15'],
    ['2024-02-01', 36, '2027-02-01'],
    ['2026-08-31', 0, '2026-08-31'],
  ])('%s + %i months = %s', (d, n, want) => expect(addMonths(d, n)).toBe(want));
});

describe('addDays', () => {
  it.each([
    ['2027-03-01', -60, '2026-12-31'],
    ['2027-02-28', 1, '2027-03-01'],
    ['2028-02-28', 1, '2028-02-29'],
    ['2026-01-01', -1, '2025-12-31'],
    ['2026-10-14', 0, '2026-10-14'],
  ])('%s + %i days = %s', (d, n, want) => expect(addDays(d, n)).toBe(want));
});

describe('key dates from the demo brief and the Contracts test set', () => {
  it('C1 renewal notice deadline: 2027-01-31 − 3 months', () => expect(addMonths('2027-01-31', -3)).toBe('2026-10-31'));
  it('C2 cancellation deadline: 2027-03-01 − 60 days', () => expect(addDays('2027-03-01', -60)).toBe('2026-12-31'));
  it('C4 termination notice deadline: 2026-10-31 − 3 months', () => expect(addMonths('2026-10-31', -3)).toBe('2026-07-31'));
  it('C2 end date: 2026-03-01 + 12 months − 1 day', () => expect(addDays(addMonths('2026-03-01', 12), -1)).toBe('2027-02-28'));
  it('C2 renewal date: end date + 1 day', () => expect(addDays('2027-02-28', 1)).toBe('2027-03-01'));
  it('leap year: 2024-02-29 + 12 months', () => expect(addMonths('2024-02-29', 12)).toBe('2025-02-28'));
});

describe('todayInZone', () => {
  it('uses the Johannesburg calendar day, not UTC', () => {
    // 23:30 UTC on 13 Oct is 01:30 on 14 Oct in Johannesburg (UTC+2).
    expect(todayInZone('Africa/Johannesburg', new Date('2026-10-13T23:30:00Z'))).toBe('2026-10-14');
    expect(todayInZone('UTC', new Date('2026-10-13T23:30:00Z'))).toBe('2026-10-13');
  });
  it('returns an ISO date for now', () => expect(todayInZone()).toMatch(/^\d{4}-\d{2}-\d{2}$/));
});
