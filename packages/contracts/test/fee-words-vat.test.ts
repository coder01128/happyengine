// D21 and D22: a charge in words beside the amount lines, and VAT status on every amount line. Small synthetic inputs.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ParsedDocument, ParsedPage, Word } from '../../documents/src/index.ts';
import { buildRecord, contractsSchema, feeLinesOf, fieldText, mergeFee, scheduleSteps, validateContractsPreset, type Candidate, type Extraction } from '../src/index.ts';

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
const build = (fields: Extraction['fields']) => buildRecord({ id: 't', ref: 'T', files: ['main.pdf'], parsed: { 'main.pdf': MAIN }, extraction: { fields, amendments: [] }, preset });

const MAIN = doc(
  'Year 3 · 1 Feb 2026 – 31 Jan 2027 R32 000.00\n\n' +
    'The 2 additional bays are let at R450.00 per bay per month, excluding VAT.\n\n' +
    'The Tenant pays a levy of R1 200.00 per month.\n\n' +
    'Insurance levy: 1.5% of the declared value.',
);
const rent = cand({ cents: 3200000, per: 'month', vat: 'excluded', what: 'rent', from: '2026-02-01' }, 'Year 3 · 1 Feb 2026 – 31 Jan 2027 R32 000.00', 'Sch. 2');
const parking = cand({ cents: 45000, per: 'month', vat: 'excluded', what: 'parking bay' }, 'The 2 additional bays are let at R450.00 per bay per month, excluding VAT', 'cl. 3');
const levy = cand({ text: '1.5% of declared value', what: 'insurance levy' }, 'Insurance levy: 1.5% of the declared value', 'cl. 6');

describe('a charge in words beside the amount lines (D21)', () => {
  it('sits beside the lines with no conflict, and shows after the amounts', () => {
    const r = build({ fee: [rent, parking, levy] });
    expect(r.fields.fee!.status).toBe('recorded');
    expect(r.reviewItems).toEqual([]);
    expect(feeLinesOf(r.fields.fee!.value)).toHaveLength(2);
    expect(fieldText(r.fields.fee, '2026-10-14')).toBe('Rent R32 000.00 per month excl. VAT (from 1 Feb 2026) · Parking bay R450.00 per month excl. VAT · Insurance levy 1.5% of declared value');
  });

  it('alone, it is the fee', () => {
    const r = build({ fee: [levy] });
    expect(r.fields.fee).toMatchObject({ status: 'recorded', value: { text: '1.5% of declared value', what: 'insurance levy' } });
    expect(fieldText(r.fields.fee, '2026-10-14')).toBe('1.5% of declared value');
  });

  it('two wordings of the same charge agree when one contains the other, and conflict when they differ', () => {
    const wording = (text: string) => ({ text, what: 'insurance levy' });
    expect(mergeFee([wording('Insurance levy 1.5% of declared value'), wording('1.5% of declared value')]).kind).toBe('lines');
    expect(mergeFee([wording('1.5% of declared value'), wording('2% of declared value')]).kind).toBe('conflict');
  });

  it('words with no charge name are left to the ordinary rules, so an amount beside them conflicts', () => {
    expect(mergeFee([{ text: 'Rates per Schedule A' }, { cents: 100, per: 'month', what: 'rent' }]).kind).toBe('not_lines');
  });

  it('are not steps', () => {
    const m = mergeFee([{ text: 'x', what: 'levy' }, { cents: 100, per: 'month', what: 'rent', from: '2025-02-01' }, { cents: 200, per: 'month', what: 'rent', from: '2026-02-01' }]);
    expect(m.kind === 'lines' && scheduleSteps(m.lines)?.steps).toEqual([100, 200]);
  });
});

describe('VAT status on every amount line (D22)', () => {
  const withVat = (vat?: 'excluded' | 'included' | 'not_stated') => cand({ cents: 120000, per: 'month', what: 'levy', ...(vat ? { vat } : {}) }, 'The Tenant pays a levy of R1 200.00 per month', 'cl. 5');

  it('a line without it is flagged, naming the line count', () => {
    const r = build({ fee: [rent, withVat()] });
    expect(r.fields.fee!.status).toBe('recorded');
    expect(r.reviewItems).toHaveLength(1);
    expect(r.reviewItems[0]).toMatchObject({ id: 'unclear:fee:vat', kind: 'unclear', fieldKey: 'fee' });
    expect(r.reviewItems[0]!.summary).toBe('Fee: VAT status missing on a line (excluding, including or not stated)');
    expect(r.reviewItems[0]!.sources).toHaveLength(1);
  });

  it('a line in the older form, with no charge name, is flagged too', () => {
    const r = build({ fee: [cand({ cents: 120000, per: 'month' }, 'The Tenant pays a levy of R1 200.00 per month')] });
    expect(r.reviewItems.map((i) => i.id)).toEqual(['unclear:fee:vat']);
  });

  it.each(['excluded', 'included', 'not_stated'] as const)('%s is an answer, not a flag', (vat) => {
    expect(build({ fee: [withVat(vat)] }).reviewItems).toEqual([]);
  });

  it('is shown in the register in words', () => {
    expect(fieldText(build({ fee: [withVat('not_stated')] }).fields.fee)).toBe('R1 200.00 per month (VAT not stated)');
    expect(fieldText(build({ fee: [withVat('included')] }).fields.fee)).toBe('R1 200.00 per month incl. VAT');
  });

  it('is required by the extraction schema on every amount line, and the charge in words carries its name', () => {
    const fee = contractsSchema.properties.fields.properties.fee as { items: { properties: { value: { anyOf: { anyOf?: { required: string[] }[] }[] } } } };
    const [amount, words] = fee.items.properties.value.anyOf[0]!.anyOf!;
    expect(amount!.required).toEqual(['cents', 'per', 'what', 'vat']);
    expect(words!.required).toEqual(['text', 'what']);
  });
});
