// D17: the fee as lines (one amount for one charge, from a date). Steps and separate charges merge; only the same
// charge from the same date with two amounts conflicts. The fee change follows from the steps. Small synthetic inputs.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ParsedDocument, ParsedPage, Word } from '../../documents/src/index.ts';
import { buildRecord, currentFee, feeLinesOf, fieldText, mergeFee, scheduleSteps, validateContractsPreset, type Candidate, type Extraction } from '../src/index.ts';

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
const build = (fields: Extraction['fields'], main: ParsedDocument) =>
  buildRecord({ id: 't', ref: 'T', files: ['main.pdf'], parsed: { 'main.pdf': main }, extraction: { fields, amendments: [] }, preset });

const MAIN = doc(
  'SCHEDULE 2 RENT\n' +
    'Year 1 · 1 Feb 2024 – 31 Jan 2025 R27 435.00\n' +
    'Year 2 · 1 Feb 2025 – 31 Jan 2026 R29 630.00\n' +
    'Year 3 · 1 Feb 2026 – 31 Jan 2027 R32 000.00\n' +
    'The 2 additional bays are let at R450.00 per bay per month, excluding VAT.\n' +
    'The Rent shall escalate on each anniversary by 8% of the Rent of the year before.\n' +
    'The Tenant pays a levy of R1 200.00 per month.',
);

const rent = (n: 1 | 2 | 3) => {
  const [from, cents, row] = [
    ['2024-02-01', 2743500, 'Year 1 · 1 Feb 2024 – 31 Jan 2025 R27 435.00'],
    ['2025-02-01', 2963000, 'Year 2 · 1 Feb 2025 – 31 Jan 2026 R29 630.00'],
    ['2026-02-01', 3200000, 'Year 3 · 1 Feb 2026 – 31 Jan 2027 R32 000.00'],
  ][n - 1] as [string, number, string];
  return cand({ cents, per: 'month', vat: 'excluded', what: 'rent', from }, row, 'Sch. 2');
};
const parking = cand({ cents: 45000, per: 'month', vat: 'excluded', what: 'parking bay' }, 'The 2 additional bays are let at R450.00 per bay per month, excluding VAT', 'cl. 3');

describe('a stepped rent and a separate charge', () => {
  const r = build({ fee: [rent(1), rent(2), rent(3), parking] }, MAIN);

  it('are recorded as lines, with every source kept, and nothing is flagged', () => {
    expect(r.fields.fee!.status).toBe('recorded');
    expect(feeLinesOf(r.fields.fee!.value)).toHaveLength(4);
    expect(r.fields.fee!.candidates).toHaveLength(4);
    expect(r.reviewItems).toEqual([]);
    expect(r.status).toBe('ready');
  });

  it('give the fee change from the steps, calculated by code, with the fee lines as its source', () => {
    const f = r.fields.feeChange!;
    expect(f).toMatchObject({ status: 'recorded', value: { kind: 'schedule', steps: [2743500, 2963000, 3200000] }, derived: { from: ['fee'] } });
    expect(f.derived!.sources).toHaveLength(3);
    expect(r.tags).toContain('fee-change');
  });

  it('read as the current amount of each charge at a date', () => {
    const at = (d: string) => currentFee(r.fields.fee!.value, d).map((c) => `${c.line.what} ${c.line.cents} ${c.started ? 'started' : 'not started'}`);
    expect(at('2026-10-14')).toEqual(['rent 3200000 started', 'parking bay 45000 started']);
    expect(at('2025-03-01')).toEqual(['rent 2963000 started', 'parking bay 45000 started']);
    expect(at('2024-01-01')).toEqual(['rent 2743500 not started', 'parking bay 45000 started']);
  });

  it('show in the register as the current amounts with their start dates', () => {
    expect(fieldText(r.fields.fee, '2026-10-14')).toBe('Rent R32 000.00 per month excl. VAT (from 1 Feb 2026) · Parking bay R450.00 per month excl. VAT');
    expect(fieldText(r.fields.fee, '2024-01-01')).toContain('starts 1 Feb 2024');
    expect(fieldText(r.fields.fee)).toContain('Rent R27 435.00 per month excl. VAT from 1 Feb 2024');
  });
});

describe('the rules for merging lines', () => {
  const line = (cents: number, what: string, from?: string) => ({ cents, per: 'month', what, ...(from ? { from } : {}) });

  it('one line is just the fee, as before', () => {
    const r = build({ fee: [parking] }, MAIN);
    expect(r.fields.fee).toMatchObject({ status: 'recorded', value: { cents: 45000, what: 'parking bay' } });
    expect(r.fields.feeChange).toBeUndefined();
    expect(fieldText(r.fields.fee, '2026-10-14')).toBe('R450.00 per month excl. VAT');
  });

  it('different charges never replace each other, and the charge name ignores case and spacing', () => {
    const m = mergeFee([line(100, 'Rent'), line(200, 'parking  bay'), line(100, 'rent')]);
    expect(m.kind).toBe('lines');
    if (m.kind === 'lines') expect(m.lines.map((l) => l.line.what)).toEqual(['Rent', 'parking  bay']);
  });

  it('the same charge from the same date with two amounts is a conflict', () => {
    expect(mergeFee([line(100, 'rent', '2026-02-01'), line(200, 'rent', '2026-02-01')]).kind).toBe('conflict');
    const twice = doc('Year 3 · 1 Feb 2026 – 31 Jan 2027 R32 000.00\nYear 3 revised · 1 Feb 2026 R33 000.00');
    const r = build({ fee: [rent(3), cand({ cents: 3300000, per: 'month', vat: 'excluded', what: 'rent', from: '2026-02-01' }, 'Year 3 revised · 1 Feb 2026 R33 000.00', 'Sch. 2')] }, twice);
    expect(r.fields.fee!.status).toBe('conflict');
  });

  it('the same amount cited twice is one line', () => {
    const m = mergeFee([line(100, 'rent', '2026-02-01'), line(100, 'rent', '2026-02-01')]);
    expect(m.kind === 'lines' && m.lines).toHaveLength(1);
  });

  it('an undated amount that equals a step is that step; one that matches no step is a conflict', () => {
    const steps = [line(100, 'rent', '2025-02-01'), line(200, 'rent', '2026-02-01')];
    expect(mergeFee([...steps, line(200, 'rent')]).kind).toBe('lines');
    expect(mergeFee([...steps, line(150, 'rent')]).kind).toBe('conflict');
  });

  it('two different undated amounts for one charge are a conflict', () => {
    expect(mergeFee([line(100, 'rent'), line(200, 'rent')]).kind).toBe('conflict');
  });

  it('a line with no charge name, or words, is left to the ordinary rules (two amounts conflict)', () => {
    expect(mergeFee([{ cents: 100, per: 'month' }, { cents: 200, per: 'month' }]).kind).toBe('not_lines');
    expect(mergeFee([{ text: 'Rates per Schedule A' }]).kind).toBe('not_lines');
    const r = build({ fee: [cand({ cents: 2743500, per: 'month' }, 'Year 1 · 1 Feb 2024 – 31 Jan 2025 R27 435.00'), cand({ cents: 45000, per: 'month' }, 'The 2 additional bays are let at R450.00 per bay per month')] }, MAIN);
    expect(r.fields.fee!.status).toBe('conflict');
  });

  it('steps are found on one charge only', () => {
    const merged = mergeFee([line(100, 'rent', '2025-02-01'), line(200, 'rent', '2026-02-01'), line(50, 'levy', '2025-02-01'), line(60, 'levy', '2026-02-01')]);
    expect(merged.kind === 'lines' && scheduleSteps(merged.lines)).toBeUndefined();
    const one = mergeFee([line(100, 'rent', '2025-02-01'), line(200, 'rent', '2026-02-01'), line(50, 'levy')]);
    expect(one.kind === 'lines' && scheduleSteps(one.lines)?.steps).toEqual([100, 200]);
  });
});

describe('the value check on a line', () => {
  it('a start date that is not in the quoted row is refused, so the line cannot stand', () => {
    const r = build({ fee: [cand({ cents: 2743500, per: 'month', what: 'rent', from: '2024-03-01' }, 'Year 1 · 1 Feb 2024 – 31 Jan 2025 R27 435.00', 'Sch. 2')] }, MAIN);
    expect(r.fields.fee!.candidates[0]!.valueCheck).toBe('failed');
    expect(r.fields.fee!.status).toBe('not_verified');
  });

  it('a line with no start date is checked on its amount only', () => {
    const r = build({ fee: [cand({ cents: 120000, per: 'month', what: 'levy' }, 'The Tenant pays a levy of R1 200.00 per month', 'cl. 5')] }, MAIN);
    expect(r.fields.fee!.status).toBe('recorded');
  });
});

describe('the fee change next to fee steps', () => {
  const pct = cand({ kind: 'percent_escalation', percent: 8, every: 'anniversary' }, 'The Rent shall escalate on each anniversary by 8% of the Rent of the year before', 'cl. 5.2');
  const steps = [rent(1), rent(2), rent(3)];

  it('a percentage from the extractor is kept as a source and not compared with the steps', () => {
    const r = build({ fee: steps, feeChange: [pct] }, MAIN);
    expect(r.fields.feeChange).toMatchObject({ status: 'recorded', value: { kind: 'schedule', steps: [2743500, 2963000, 3200000] } });
    expect(r.fields.feeChange!.candidates).toHaveLength(1);
    expect(r.reviewItems).toEqual([]);
  });

  it('an extractor schedule with the same amounts agrees with it', () => {
    const table = cand({ kind: 'schedule', steps: [2743500, 2963000, 3200000] }, 'Year 1 · 1 Feb 2024 – 31 Jan 2025 R27 435.00\nYear 2 · 1 Feb 2025 – 31 Jan 2026 R29 630.00\nYear 3 · 1 Feb 2026 – 31 Jan 2027 R32 000.00', 'Sch. 2');
    const r = build({ fee: steps, feeChange: [pct, table] }, MAIN);
    expect(r.fields.feeChange).toMatchObject({ status: 'recorded', derived: { from: ['fee'] } });
    expect(r.reviewItems).toEqual([]);
  });

  it('an extractor schedule with different amounts is a real disagreement: nothing is derived and it is flagged', () => {
    const other = cand({ kind: 'schedule', steps: [2743500, 2963000] }, 'Year 1 · 1 Feb 2024 – 31 Jan 2025 R27 435.00\nYear 2 · 1 Feb 2025 – 31 Jan 2026 R29 630.00', 'Sch. 2');
    const r = build({ fee: steps, feeChange: [pct, other] }, MAIN);
    expect(r.fields.feeChange!.derived).toBeUndefined();
    expect(r.fields.feeChange!.status).toBe('conflict');
  });

  it('a single dated line is not a schedule', () => {
    const r = build({ fee: [rent(3)], feeChange: [pct] }, MAIN);
    expect(r.fields.feeChange).toMatchObject({ status: 'recorded', value: { kind: 'percent_escalation' } });
    expect(r.fields.feeChange!.derived).toBeUndefined();
  });
});
