// Phase 2 on records: the value-in-quote check, the label check, a quote found on another page, a repeated
// quote, a quote across a page break, and watermark words. Small synthetic inputs, no network.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ParsedDocument, ParsedPage, Word } from '../../documents/src/index.ts';
import { buildRecord, checkValue, validateContractsPreset, type Candidate, type Extraction, type FieldKey } from '../src/index.ts';

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
  '1.1 Parties: Acme Supplies (Pty) Ltd and Marula Office Supplies (Pty) Ltd.\n' +
    '2.1 This agreement commences on 1 March 2026 for a period of three (3) years.\n' +
    '2.2 The monthly fee is R4 850.00 excluding VAT, payable in advance.\n' +
    '2.3 Either party may cancel on not less than 60 days written notice before the renewal date.',
);

describe('case 9: the value is not in the cited wording', () => {
  it.each<[string, FieldKey, Candidate['value'], string]>([
    ['a start date that is not the one quoted', 'startDate', '2026-04-01', 'This agreement commences on 1 March 2026 for a period of three (3) years'],
    ['a fee that is not the one quoted', 'fee', { cents: 585000, per: 'month' }, 'The monthly fee is R4 850.00 excluding VAT, payable in advance'],
    ['a term that is not the one quoted', 'termMonths', 24, 'This agreement commences on 1 March 2026 for a period of three (3) years'],
    ['a notice period that is not the one quoted', 'notice', { amount: 90, unit: 'days', before: 'renewal' }, 'Either party may cancel on not less than 60 days written notice before the renewal date'],
  ])('%s: flagged for review with the reason, and no value is shown', (_name, key, value, quote) => {
    const r = build({ [key]: [cand(value, quote, 'cl. 2.1')] }, MAIN);
    const f = r.fields[key]!;
    expect(f.status).toBe('not_verified');
    expect(f.value).toBeUndefined();
    expect(f.candidates[0]).toMatchObject({ valueCheck: 'failed' });
    expect(f.candidates[0]!.grounding.status).toBe('grounded'); // the quote is real; the value doesn't go with it
    expect(r.reviewItems[0]).toMatchObject({ kind: 'not_verified', fieldKey: key });
    expect(r.reviewItems[0]!.summary).toContain('value not found in cited text');
  });

  it('a quote that got a number wrong cannot vouch for a value that agrees with the quote: the page text decides', () => {
    // The extractor wrote 90 in the quote and in the value; the page says 60. The quote still aligns (fuzzy), the value doesn't.
    const r = build({ notice: [cand({ amount: 90, unit: 'days', before: 'renewal' }, 'Either party may cancel on not less than 90 days written notice before the renewal date', 'cl. 2.3')] }, MAIN);
    expect(r.fields.notice!.candidates[0]).toMatchObject({ grounding: { status: 'grounded', match: 'fuzzy' }, valueCheck: 'failed' });
    expect(r.fields.notice!.status).toBe('not_verified');
  });

  it.each<[string, FieldKey, Candidate['value'], string]>([
    ['a date written out', 'startDate', '2026-03-01', 'This agreement commences on 1 March 2026 for a period'],
    ['a term of years given in months', 'termMonths', 36, 'for a period of three (3) years'],
    ['an amount with spaces in it', 'fee', { cents: 485000, per: 'month', vat: 'excluded' }, 'The monthly fee is R4 850.00 excluding VAT'],
    ['a notice period in days', 'notice', { amount: 60, unit: 'days', before: 'renewal' }, 'not less than 60 days written notice before the renewal date'],
    ['a text field, which has nothing to check', 'counterparty', 'Acme Supplies (Pty) Ltd', 'Parties: Acme Supplies (Pty) Ltd and Marula'],
  ])('passes %s', (_name, key, value, quote) => {
    const r = build({ [key]: [cand(value, quote, 'cl. 2.1')] }, MAIN);
    expect(r.fields[key]!.status).toBe('recorded');
    expect(r.reviewItems).toEqual([]);
  });
});

describe('case 10: a clause label that is not on the page is dropped', () => {
  it('keeps the value and the page chip, and marks the label unchecked so it is never shown', () => {
    const r = build({ startDate: [cand('2026-03-01', 'This agreement commences on 1 March 2026', 'cl. 7.3')] }, MAIN);
    expect(r.fields.startDate!.status).toBe('recorded');
    expect(r.fields.startDate!.candidates[0]).toMatchObject({ clause: 'cl. 7.3', clauseChecked: false, page: 1 });
    expect(r.reviewItems).toEqual([]);
  });
  it('checks the label against the page the quote was really found on, not the page claimed', () => {
    const two = doc('Cover page with clause 9.9 only', '2.1 This agreement commences on 1 March 2026.');
    const right = build({ startDate: [cand('2026-03-01', 'This agreement commences on 1 March 2026', 'cl. 2.1', 1)] }, two);
    expect(right.fields.startDate!.candidates[0]).toMatchObject({ page: 2, claimedPage: 1, clauseChecked: true });
    const wrong = build({ startDate: [cand('2026-03-01', 'This agreement commences on 1 March 2026', 'cl. 9.9', 2)] }, two);
    expect(wrong.fields.startDate!.candidates[0]).toMatchObject({ page: 2, clauseChecked: false });
  });
});

describe('a quote on another page, a repeated quote, a page break, a watermark', () => {
  it('a quote on a different page from the one claimed is recorded on the page it is on, keeping what was claimed', () => {
    const two = doc('Cover', '2.1 This agreement commences on 1 March 2026.');
    const r = build({ startDate: [cand('2026-03-01', 'This agreement commences on 1 March 2026', 'cl. 2.1', 1)] }, two);
    const c = r.fields.startDate!.candidates[0]!;
    expect(c).toMatchObject({ page: 2, claimedPage: 1, grounding: { status: 'grounded', match: 'exact', page: 2, claimedPage: 1 } });
    expect(c.grounding.fractions).toHaveLength(1);
    expect(r.fields.startDate!.status).toBe('recorded');
  });

  it('a quote that appears twice is not taken: flagged for review as appearing in more than one place', () => {
    const rep = doc('Fees are payable monthly. Rent is R4 850.00 excluding VAT.\nDeposit is R4 850.00 excluding VAT.');
    const r = build({ fee: [cand({ cents: 485000, per: 'month' }, 'R4 850.00 excluding VAT', 'cl. 2.2')] }, rep);
    expect(r.fields.fee!.candidates[0]!.grounding).toMatchObject({ status: 'ambiguous', boxes: [] });
    expect(r.fields.fee!.status).toBe('not_verified');
    expect(r.reviewItems[0]!.summary).toContain('more than one place');
  });

  it('a quote across a page break is found, and the value is checked against all of it', () => {
    const split = doc('2.2 The monthly fee is', 'R4 850.00 excluding VAT, payable in advance.');
    const q = 'The monthly fee is R4 850.00 excluding VAT';
    const ok = build({ fee: [cand({ cents: 485000, per: 'month' }, q, 'cl. 2.2', 1)] }, split);
    expect(ok.fields.fee!.candidates[0]).toMatchObject({ page: 1, grounding: { status: 'grounded', more: [{ page: 2 }] }, valueCheck: 'passed' });
    expect(ok.fields.fee!.status).toBe('recorded');
    const bad = build({ fee: [cand({ cents: 585000, per: 'month' }, q, 'cl. 2.2', 1)] }, split);
    expect(bad.fields.fee!.status).toBe('not_verified');
  });

  it('a SAMPLE watermark in the middle of a short quote still grounds (the preset lists it)', () => {
    const wm = doc('2.3 Either party may cancel on SAMPLE 60 days written notice before the renewal date.');
    const r = build({ notice: [cand({ amount: 60, unit: 'days', before: 'renewal' }, 'Either party may cancel on 60 days written notice', 'cl. 2.3')] }, wm);
    expect(r.fields.notice!.candidates[0]).toMatchObject({ grounding: { status: 'grounded', match: 'fuzzy', score: 1 }, valueCheck: 'passed' });
    expect(r.fields.notice!.status).toBe('recorded');
  });

  it('a quote claimed on a page the parser could not read is not verified, with the reason', () => {
    const bad: ParsedDocument = { parser: 'fixture', pageCount: 2, pages: [page('Cover', 1), { page: 2, width: 600, height: 800, text: '', words: [], positionsOk: false, positionsError: 'render failed' }] };
    const r = build({ startDate: [cand('2026-03-01', 'This agreement commences on 1 March 2026', 'cl. 2.1', 2)] }, bad);
    expect(r.fields.startDate!.status).toBe('not_verified');
    expect(r.reviewItems[0]!.summary).toContain('page could not be read for positions');
  });
});

describe('checkValue', () => {
  it.each<[FieldKey, Candidate['value'], string, string]>([
    ['startDate', '2027-01-31', 'ending on 31 January 2027', 'passed'],
    ['startDate', '2027-01-31', 'ending on 31 December 2026', 'failed'],
    ['endDate', '2027-01-31', 'until 31/01/2027', 'passed'],
    ['termMonths', 36, 'a period of three (3) years', 'passed'],
    ['termMonths', 36, 'a period of 36 months', 'passed'],
    ['termMonths', 12, 'a period of 36 months', 'failed'],
    ['renewal', { kind: 'automatic', periodMonths: 12 }, 'renews for successive periods of twelve (12) months', 'passed'],
    ['renewal', { kind: 'option' }, 'the Tenant may renew', 'skipped'],
    ['notice', { amount: 3, unit: 'months' }, 'three calendar months before expiry', 'passed'],
    ['notice', { amount: 60, unit: 'days' }, 'sixty days written notice', 'passed'],
    ['notice', { amount: 90, unit: 'days' }, 'sixty days written notice', 'failed'],
    ['fee', { cents: 485000, per: 'month' }, 'R4 850.00 per month', 'passed'],
    ['fee', { cents: 485000, per: 'month' }, 'R4 580.00 per month', 'failed'],
    ['fee', { text: 'per the price list' }, 'as per the price list', 'skipped'],
    ['deposit', 750000, 'a deposit of R7 500.00', 'passed'],
    ['feeChange', { kind: 'schedule', steps: [3200000, 3360000] }, 'R32 000.00 then R33 600.00', 'passed'],
    ['feeChange', { kind: 'schedule', steps: [3200000, 3400000] }, 'R32 000.00 then R33 600.00', 'failed'],
    ['feeChange', { kind: 'percent_escalation', percent: 8, every: 'anniversary' }, 'increases by 8% each anniversary', 'passed'],
    ['feeChange', { kind: 'unquantified' }, 'may increase the fee', 'skipped'],
    ['counterparty', 'Acme', 'anything', 'skipped'],
    ['startDate', 'not_stated', 'anything', 'skipped'],
    ['termMonths', 'blank', 'a period of ______ months', 'skipped'],
  ])('%s %j in "%s" → %s', (key, value, text, expected) => expect(checkValue(key, value, text)).toBe(expected));
});
