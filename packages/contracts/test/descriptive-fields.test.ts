// D13: descriptive fields (agreement type, scope) record different wordings without flagging. Dates, money and
// notice keep their rules. Small synthetic inputs, no network.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ParsedDocument, ParsedPage, Word } from '../../documents/src/index.ts';
import { buildRecord, validateContractsPreset, type Candidate, type Extraction } from '../src/index.ts';

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
const cand = (value: Candidate['value'], quote: string, clause?: string, p = 1): Candidate => ({ value, quote, file: 'main.pdf', page: p, ...(clause ? { clause } : {}) });
const build = (fields: Extraction['fields'], main: ParsedDocument) =>
  buildRecord({ id: 't', ref: 'T', files: ['main.pdf'], parsed: { 'main.pdf': main }, extraction: { fields, amendments: [] }, preset });

const MAIN = doc(
  'OFFICE LEASE AGREEMENT\n' +
    '1.1 The Landlord lets the office premises to the Tenant.\n' +
    '1.2 The premises may be used for general office purposes and storage.\n' +
    '2.2 The monthly fee is R4 850.00 excluding VAT. A second fee of R5 100.00 excluding VAT applies from March.\n' +
    '2.3 Either party may cancel on 60 days written notice. Notice of 90 days written notice applies to renewals.',
);

describe('descriptive fields: agreement type and scope', () => {
  it('two different wordings of the scope are both recorded, the first is shown, and nothing is flagged', () => {
    const r = build({ scope: [cand('Office premises', 'The Landlord lets the office premises to the Tenant', 'cl. 1.1'), cand('General office use and storage', 'general office purposes and storage', 'cl. 1.2')] }, MAIN);
    const f = r.fields.scope!;
    expect(f.status).toBe('recorded');
    expect(f.value).toBe('Office premises');
    expect(f.current).toBe(0);
    expect(f.candidates).toHaveLength(2);
    expect(f.candidates.every((c) => c.grounding.status === 'grounded')).toBe(true);
    expect(r.reviewItems).toEqual([]);
    expect(r.status).toBe('ready');
  });

  it('the same goes for the agreement type', () => {
    const r = build({ agreementType: [cand('Office lease', 'OFFICE LEASE AGREEMENT', 'cl. 1.1'), cand('Lease of premises', 'lets the office premises', 'cl. 1.1')] }, MAIN);
    expect(r.fields.agreementType).toMatchObject({ status: 'recorded', value: 'Office lease' });
    expect(r.reviewItems).toEqual([]);
  });

  it('a title that appears in more than one place is taken at the first, not refused', () => {
    const twice = doc('OFFICE LEASE AGREEMENT\nbetween the parties\nThis OFFICE LEASE AGREEMENT is made on 1 March 2026.');
    const r = build({ agreementType: [cand('Office lease', 'OFFICE LEASE AGREEMENT')] }, twice);
    expect(r.fields.agreementType).toMatchObject({ status: 'recorded', value: 'Office lease' });
    expect(r.fields.agreementType!.candidates[0]!.grounding).toMatchObject({ status: 'grounded', score: 0.99, start: 0 });
    expect(r.reviewItems).toEqual([]);
  });

  it('a descriptive wording that is found nowhere is still flagged: nothing supports it', () => {
    const r = build({ scope: [cand('Vehicle hire', 'The Hirer shall return the vehicles on Friday')] }, MAIN);
    expect(r.fields.scope!.status).toBe('not_verified');
    expect(r.reviewItems[0]).toMatchObject({ kind: 'not_verified', fieldKey: 'scope' });
  });

  it('a wording that stands is recorded even when another wording for the same field is not found', () => {
    const r = build({ scope: [cand('Vehicle hire', 'The Hirer shall return the vehicles on Friday'), cand('Office premises', 'The Landlord lets the office premises to the Tenant')] }, MAIN);
    expect(r.fields.scope).toMatchObject({ status: 'recorded', value: 'Office premises', current: 1 });
    expect(r.reviewItems).toEqual([]);
  });

  it('a field marked required that is not stated is still raised as unclear', () => {
    const strict = validateContractsPreset({ ...JSON.parse(JSON.stringify(preset)), fields: preset.fields.map((f) => (f.key === 'scope' ? { ...f, required: true } : f)) });
    const r = buildRecord({ id: 't', ref: 'T', files: ['main.pdf'], parsed: { 'main.pdf': MAIN }, extraction: { fields: { scope: [cand('not_stated', 'The Landlord lets the office premises to the Tenant')] }, amendments: [] }, preset: strict });
    expect(r.reviewItems[0]).toMatchObject({ kind: 'unclear', fieldKey: 'scope' });
  });
});

describe('fields that are not descriptive keep their rules', () => {
  it('two different fees are still a conflict', () => {
    const r = build({ fee: [cand({ cents: 485000, per: 'month' }, 'The monthly fee is R4 850.00 excluding VAT', 'cl. 2.2'), cand({ cents: 510000, per: 'month' }, 'A second fee of R5 100.00 excluding VAT applies from March', 'cl. 2.2')] }, MAIN);
    expect(r.fields.fee!.status).toBe('conflict');
    expect(r.reviewItems[0]).toMatchObject({ kind: 'conflict', fieldKey: 'fee' });
  });

  it('two different notice periods are still a conflict', () => {
    const r = build({ notice: [cand({ amount: 60, unit: 'days', before: 'renewal' }, 'Either party may cancel on 60 days written notice', 'cl. 2.3'), cand({ amount: 90, unit: 'days', before: 'renewal' }, 'Notice of 90 days written notice applies to renewals', 'cl. 2.3')] }, MAIN);
    expect(r.fields.notice!.status).toBe('conflict');
  });

  it('a money quote in more than one place is still refused as ambiguous', () => {
    const rep = doc('Rent is R4 850.00 excluding VAT.\nDeposit is R4 850.00 excluding VAT.');
    const r = build({ fee: [cand({ cents: 485000, per: 'month' }, 'R4 850.00 excluding VAT', 'cl. 2.2')] }, rep);
    expect(r.fields.fee!.candidates[0]!.grounding.status).toBe('ambiguous');
    expect(r.fields.fee!.status).toBe('not_verified');
  });
});

describe('the preset', () => {
  it('marks only agreement type and scope as descriptive', () =>
    expect(preset.fields.filter((f) => f.descriptive).map((f) => f.key)).toEqual(['agreementType', 'scope']));

  it('refuses a descriptive setting that is not true or false', () => {
    const p = JSON.parse(JSON.stringify(preset));
    p.fields[0].descriptive = 'yes';
    expect(() => validateContractsPreset(p)).toThrow(/fields\.counterparty\.descriptive/);
  });
});
