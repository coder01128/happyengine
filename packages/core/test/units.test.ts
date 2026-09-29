import { describe, expect, it } from 'vitest';
import { daysBetween, formatDate, formatRand, parseAmount, parseDate } from '../src/index.ts';

describe('money', () => {
  it.each([
    [1_245_000, 'R12 450.00'],
    [-18_650, '−R186.50'],
    [4_218, 'R42.18'],
    [0, 'R0.00'],
    [12_355_693, 'R123 556.93'],
    [-922_275, '−R9 222.75'],
    [100_000_000, 'R1 000 000.00'],
  ])('formatRand(%i) = %s', (cents, text) => expect(formatRand(cents)).toBe(text));

  it.each([
    ['12 450.00', 1_245_000],
    ['12450', 1_245_000],
    ['-1,284.60', -128_460],
    ['(186.50)', -18_650],
    ['R1 234,56', 123_456],
    ['1.234,56', 123_456],
    ['42.18', 4_218],
    ['1 234.5', 123_450],
    ['100.00-', -10_000],
    ['250.00 DR', -25_000],
    ['250.00 CR', 25_000],
    ['−R186.50', -18_650],
    ['-R186.50', -18_650],
    ['12,540.00', 1_254_000],
    ['0.1', 10],
  ])('parseAmount(%s) = %i', (raw, cents) => expect(parseAmount(raw)).toBe(cents));

  it('refuses to guess', () => {
    expect(() => parseAmount('')).toThrow();
    expect(() => parseAmount('twelve')).toThrow();
    expect(() => parseAmount('12.3.4x')).toThrow();
  });

  it('never drifts: 0.1 + 0.2 in cents', () => expect(parseAmount('0.10') + parseAmount('0.20')).toBe(30));
});

describe('dates', () => {
  it('parses each supported format to UTC date-only', () => {
    expect(parseDate('08/09/2026', 'DD/MM/YYYY')).toBe('2026-09-08');
    expect(parseDate('2026-09-08', 'YYYY-MM-DD')).toBe('2026-09-08');
    expect(parseDate('2026/09/08', 'YYYY/MM/DD')).toBe('2026-09-08');
    expect(parseDate('20260908120000[+2:SAST]'.slice(0, 8), 'YYYYMMDD')).toBe('2026-09-08');
    expect(parseDate('8 Sep 2026', 'D MMM YYYY')).toBe('2026-09-08');
    expect(parseDate('08 September 2026', 'D MMM YYYY')).toBe('2026-09-08');
  });
  it('rejects impossible dates and wrong formats', () => {
    expect(() => parseDate('31/09/2026', 'DD/MM/YYYY')).toThrow();
    expect(() => parseDate('2026-09-08', 'DD/MM/YYYY')).toThrow();
  });
  it('counts days across month ends and leap years', () => {
    expect(daysBetween('2026-09-30', '2026-10-03')).toBe(3);
    expect(daysBetween('2028-02-28', '2028-03-01')).toBe(2);
  });
  it('formats for display', () => expect(formatDate('2026-10-05')).toBe('5 Oct 2026'));
});
