// D24: "possibly incomplete" (a row of the cited section holds a Rand amount that no fee line covers) and D25: charge
// names ignore period qualifiers in brackets but keep the brackets that say which charge it is. Small synthetic inputs.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ParsedDocument, ParsedPage, Word } from '../../documents/src/index.ts';
import { buildRecord, chargeName, currentFee, mergeFee, scheduleSteps, validateContractsPreset, type Candidate, type Extraction } from '../src/index.ts';

// These tests are about one rule each: the required-field checks of the categories are switched off here (see categories.test.ts).
const preset = { ...validateContractsPreset(JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', '..', 'presets', 'contracts.default.json'), 'utf8'))), uncategorised: { required: [] as string[] } };

function page(text: string, n = 1): ParsedPage {
  const words: Word[] = [];
  let offset = 0;
  text.split('\n').forEach((line, row) => {
    for (const m of line.matchAll(/\S+/g)) words.push({ text: m[0], start: offset + m.index, end: offset + m.index + m[0].length, box: { x: m.index * 6, y: row * 20, w: m[0].length * 6, h: 12 } });
    offset += line.length + 1;
  });
  return { page: n, width: 600, height: 800, text, words };
}
const doc = (...pages: string[]): ParsedDocument => ({ parser: 'fixture', pageCount: pages.length, pages: pages.map((t, i) => page(t, i + 1)) });
const cand = (value: Candidate['value'], quote: string, clause?: string): Candidate => ({ value, quote, file: 'main.pdf', page: 1, ...(clause ? { clause } : {}) });
const build = (fields: Extraction['fields'], main: ParsedDocument) => buildRecord({ id: 't', ref: 'T', files: ['main.pdf'], parsed: { 'main.pdf': main }, extraction: { fields, amendments: [] }, preset });
const line = (what: string, cents: number, quote: string, per = 'consignment') => cand({ cents, per, vat: 'excluded', what }, quote, 'Sch. A');

const RATES = doc(
  'SCHEDULE A RATES\n' +
    'Same-day, within city R185.00\n' +
    'Overnight, national R240.00\n' +
    'Economy, 2–3 days R145.00\n\n' +
    'Rates exclude VAT.\n\n' +
    'A deposit of R5 000.00 is payable on signature.',
);
const SAME_DAY = line('same-day', 18500, 'Same-day, within city R185.00');
const OVERNIGHT = line('overnight', 24000, 'Overnight, national R240.00');
const ECONOMY = line('economy', 14500, 'Economy, 2–3 days R145.00');
const item = (r: ReturnType<typeof build>) => r.reviewItems.find((i) => i.id === 'unclear:fee:incomplete');

describe('possibly incomplete (D24)', () => {
  it('every row of the rate card recorded: nothing is flagged', () => {
    const r = build({ fee: [SAME_DAY, OVERNIGHT, ECONOMY] }, RATES);
    expect(item(r)).toBeUndefined();
    expect(r.reviewItems).toEqual([]);
  });

  it('a row left out is flagged, with its amount, and the recorded lines are the sources', () => {
    const r = build({ fee: [SAME_DAY] }, RATES);
    expect(r.fields.fee!.status).toBe('recorded');
    expect(item(r)).toMatchObject({ kind: 'unclear', fieldKey: 'fee' });
    expect(item(r)!.summary).toBe('Fee: possibly incomplete: R240.00, R145.00 in the cited section are not in any fee line');
    expect(item(r)!.sources).toHaveLength(1);
    expect(r.status).toBe('flagged');
  });

  it('one amount left out reads in the singular', () => {
    const r = build({ fee: [SAME_DAY, OVERNIGHT] }, RATES);
    expect(item(r)!.summary).toBe('Fee: possibly incomplete: R145.00 in the cited section is not in any fee line');
  });

  it('a charge recorded as words does not cover its amounts: the C4 copy-charge case', () => {
    const copies = doc('Rental R1 980.00, excluding VAT.\n\nCopy charges Mono R0.19 · colour R1.45 per copy.');
    const rental = cand({ cents: 198000, per: 'month', vat: 'excluded', what: 'rental' }, 'Rental R1 980.00, excluding VAT');
    const words = cand({ text: 'Mono R0.19 · colour R1.45 per copy', what: 'copy charges' }, 'Copy charges Mono R0.19 · colour R1.45 per copy');
    const r = build({ fee: [rental, words] }, copies);
    expect(item(r)!.summary).toContain('R0.19, R1.45');
  });

  it('a table’s other columns are not flagged: a row that holds a recorded amount is covered', () => {
    const table = doc('| Year 1 | R27 435.00 | R66.59 |\n| Year 2 | R29 630.00 | R71.92 |');
    const r = build({ fee: [cand({ cents: 2743500, per: 'month', vat: 'excluded', what: 'rent', from: '2024-02-01' }, 'Year 1 | R27 435.00 | R66.59'), cand({ cents: 2963000, per: 'month', vat: 'excluded', what: 'rent', from: '2025-02-01' }, 'Year 2 | R29 630.00 | R71.92')] }, table);
    expect(r.reviewItems.map((i) => i.id)).not.toContain('unclear:fee:incomplete');
  });

  it('an amount in another paragraph (a deposit clause) is not part of the cited section', () => {
    const r = build({ fee: [SAME_DAY, OVERNIGHT, ECONOMY] }, RATES);
    expect(item(r)).toBeUndefined();
  });

  it('an amount that is the recorded deposit is covered', () => {
    const same = doc('Rent R4 850.00 per month.\nDeposit R9 700.00.');
    const r = build({ fee: [cand({ cents: 485000, per: 'month', vat: 'excluded', what: 'rent' }, 'Rent R4 850.00 per month')], deposit: [cand(970000, 'Deposit R9 700.00')] }, same);
    expect(item(r)).toBeUndefined();
    const without = build({ fee: [cand({ cents: 485000, per: 'month', vat: 'excluded', what: 'rent' }, 'Rent R4 850.00 per month')] }, same);
    expect(item(without)!.summary).toContain('R9 700.00');
  });

  it('a row with two amounts of which one is recorded counts as covered (a known limit: it cannot tell)', () => {
    const two = doc('Mono R0.19 · colour R1.45 per copy.');
    const r = build({ fee: [cand({ cents: 19, per: 'copy', vat: 'not_stated', what: 'mono' }, 'Mono R0.19 · colour R1.45 per copy')] }, two);
    expect(item(r)).toBeUndefined();
  });

  it('only a fee that stands is checked: a conflict or an unverified fee is flagged already', () => {
    const twice = doc('Same-day, within city R185.00\nSame-day, within city R190.00');
    const conflict = build({ fee: [SAME_DAY, line('same-day', 19000, 'Same-day, within city R190.00')] }, twice);
    expect(conflict.fields.fee!.status).toBe('conflict');
    expect(item(conflict)).toBeUndefined();
    const notFound = build({ fee: [line('x', 100, 'Wording that is not on the page at all')] }, RATES);
    expect(notFound.fields.fee!.status).toBe('not_verified');
    expect(item(notFound)).toBeUndefined();
  });

  it('a page with no blank lines is one block: every row of it is looked at', () => {
    const flat = doc('Same-day R185.00\nOvernight R240.00');
    const r = build({ fee: [line('same-day', 18500, 'Same-day R185.00')] }, flat);
    expect(item(r)!.summary).toContain('R240.00');
  });
});

describe('charge names ignore period qualifiers (D25)', () => {
  it.each([
    ['Rent (year 1)', 'rent'],
    ['rent (Year 2)', 'rent'],
    ['Rent (months 13–24)', 'rent'],
    ['Rent (from 1 Feb 2025)', 'rent'],
    ['Rent (2025/26)', 'rent'],
    ['Rent (first year)', 'rent'],
    ['Rent (with effect from 1 March 2026)', 'rent'],
    ['Rent [year 3]', 'rent'],
    ['Rent (office) (year 1)', 'rent (office)'],
    ['  Rent   (year 1)  ', 'rent'],
  ])('%s → %s', (what, name) => expect(chargeName(what)).toBe(name));

  it.each(['Rent (office)', 'Rent (warehouse)', 'Parking (per bay)', 'Operating costs (estimate)', 'Levy (monthly)'])('%s keeps its bracket', (what) => {
    expect(chargeName(what)).toBe(what.toLowerCase());
  });

  it('the rent of every year is one charge, so the steps are found', () => {
    const merged = mergeFee([
      { cents: 100, per: 'month', vat: 'excluded', what: 'rent (year 1)', from: '2024-02-01' },
      { cents: 200, per: 'month', vat: 'excluded', what: 'Rent (year 2)', from: '2025-02-01' },
      { cents: 300, per: 'month', vat: 'excluded', what: 'rent (year 3)', from: '2026-02-01' },
    ]);
    expect(merged.kind).toBe('lines');
    expect(merged.kind === 'lines' && scheduleSteps(merged.lines)?.steps).toEqual([100, 200, 300]);
    expect(currentFee(merged.kind === 'lines' ? { lines: merged.lines.map((m) => m.line) } : undefined, '2025-06-01').map((c) => c.line.cents)).toEqual([200]);
  });

  it('"Rent (office)" and "Rent (warehouse)" stay separate charges, even from the same date', () => {
    const merged = mergeFee([
      { cents: 100, per: 'month', vat: 'excluded', what: 'Rent (office)', from: '2026-02-01' },
      { cents: 900, per: 'month', vat: 'excluded', what: 'Rent (warehouse)', from: '2026-02-01' },
    ]);
    expect(merged.kind).toBe('lines');
    expect(merged.kind === 'lines' && merged.lines).toHaveLength(2);
    expect(merged.kind === 'lines' && scheduleSteps(merged.lines)).toBeUndefined();
  });

  it('two different amounts for the same period of the same charge are still a conflict, whatever the qualifier', () => {
    expect(mergeFee([
      { cents: 100, per: 'month', vat: 'excluded', what: 'rent (year 2)', from: '2025-02-01' },
      { cents: 150, per: 'month', vat: 'excluded', what: 'Rent', from: '2025-02-01' },
    ]).kind).toBe('conflict');
  });
});
