// Reading amounts, dates and numbers out of a quote (the parts of the value-in-quote check that know nothing about contracts).
import { describe, expect, it } from 'vitest';
import { centsIn, datesIn, numbersIn } from '../src/index.ts';

describe('centsIn: amounts of money in a quote', () => {
  it.each([
    ['R4 850.00 per month', [485000]],
    ['R4,850.00', [485000]],
    ['R 4850', [485000]],
    ['R4 850,00', [485000]],
    ['ZAR 32 000.00', [3200000]],
    ['R32 000.00 and R33 600.00', [3200000, 3360000]],
    ['deposit of R7 500', [750000]],
    ['R950.50', [95050]],
    ['nothing here', []],
  ])('%s', (text, expected) => expect(centsIn(text)).toEqual(expect.arrayContaining(expected)));
  it('does not read a clause number as money', () => expect(centsIn('clause 2.1.7 on page 4')).toEqual([]));
});

describe('datesIn: dates in a quote, as ISO', () => {
  it.each([
    ['ending on 31 January 2027', '2027-01-31'],
    ['on 1 Feb 2024', '2024-02-01'],
    ['on 1 Feb. 2024', '2024-02-01'],
    ['commencing 1st of June 2025', '2025-06-01'],
    ['on 31/01/2027', '2027-01-31'],
    ['on 31-01-2027', '2027-01-31'],
    ['on 2027-01-31', '2027-01-31'],
    ['on 2027/01/31', '2027-01-31'],
    ['on January 31, 2027', '2027-01-31'],
    ['op 31 Januarie 2027', '2027-01-31'],
    ['the 29th day of February 2028', '2028-02-29'],
  ])('%s', (text, iso) => expect(datesIn(text)).toContain(iso));
  it('reads day first for a slash date, as South Africans write it', () => expect(datesIn('on 03/04/2026')).toEqual(['2026-04-03']));
  it('ignores things that are not dates', () => {
    expect(datesIn('31 February 2027')).toEqual([]);
    expect(datesIn('clause 12.3.2027')).toEqual([]);
    expect(datesIn('no dates at all')).toEqual([]);
  });
});

describe('numbersIn: numbers in a quote, digits and words', () => {
  it.each([
    ['not less than 60 days', 60],
    ['sixty days', 60],
    ['three (3) months', 3],
    ['three calendar months', 3],
    ['twelve (12) months', 12],
    ['one hundred and eighty days', 180],
    ['twenty-four months', 24],
    ['8.5% per annum', 8.5],
    ['8,5 per cent', 8.5],
    ['a period of thirty-six (36) months', 36],
  ])('%s → %s', (text, n) => expect(numbersIn(text)).toContain(n));
  it('reads no number from text without one', () => expect(numbersIn('the Landlord shall give notice')).toEqual([]));
});
