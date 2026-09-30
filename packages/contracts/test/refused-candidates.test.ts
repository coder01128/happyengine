// D16: when a value stands (or "not stated" does) and another cited wording was refused with a different value,
// the reviewer is told. A refused wording with the same value, a descriptive field and a replaced clause are left alone.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ParsedDocument, ParsedPage, Word } from '../../documents/src/index.ts';
import { buildRecord, validateContractsPreset, type Candidate, type Extraction } from '../src/index.ts';

const preset = validateContractsPreset(JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', '..', 'presets', 'contracts.default.json'), 'utf8')));

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
const build = (fields: Extraction['fields'], main: ParsedDocument, amendments: Extraction['amendments'] = []) =>
  buildRecord({ id: 't', ref: 'T', files: ['main.pdf'], parsed: { 'main.pdf': main }, extraction: { fields, amendments }, preset });

const MAIN = doc(
  '2.1 This agreement commences on 1 March 2026 for a period of three (3) years.\n' +
    '2.2 The monthly fee is R4 850.00 excluding VAT, payable in advance.\n' +
    '2.3 Either party may cancel on not less than 60 days written notice before the renewal date.',
);
const START = cand('2026-03-01', 'This agreement commences on 1 March 2026 for a period of three', 'cl. 2.1');
const NOT_ON_PAGE = 'The Tenant shall pay a deposit of R7 500.00 on signature of this agreement';

describe('a refused wording with a different value', () => {
  it('is flagged, while the value that stands is still recorded', () => {
    const r = build({ startDate: [START, cand('2026-04-01', NOT_ON_PAGE, 'cl. 9.9')] }, MAIN);
    expect(r.fields.startDate).toMatchObject({ status: 'recorded', value: '2026-03-01' });
    expect(r.reviewItems).toHaveLength(1);
    expect(r.reviewItems[0]).toMatchObject({ id: 'refused:startDate', kind: 'unclear', fieldKey: 'startDate' });
    expect(r.reviewItems[0]!.summary).toContain('another cited wording was refused (the quoted wording was not found on its page)');
    expect(r.reviewItems[0]!.sources).toHaveLength(2);
    expect(r.status).toBe('flagged');
  });

  it('is flagged when it is refused because the value is not in its quote', () => {
    const r = build({ startDate: [START, cand('2026-05-01', 'This agreement commences on 1 March 2026 for a period of three', 'cl. 2.1')] }, MAIN);
    expect(r.reviewItems[0]!.summary).toContain('value not found in cited text');
  });

  it('is flagged next to "not stated"', () => {
    const r = build({ notice: [cand('not_stated', 'Either party may cancel on not less than 60 days written notice'), cand({ amount: 3, unit: 'months', before: 'expiry' }, NOT_ON_PAGE)] }, MAIN);
    expect(r.fields.notice!.status).toBe('not_stated');
    expect(r.reviewItems[0]).toMatchObject({ id: 'refused:notice', kind: 'unclear' });
  });

  it('is flagged for a fee line the recorded lines do not have, and not for one they do', () => {
    const fee = cand({ cents: 485000, per: 'month', vat: 'excluded', what: 'rent' }, 'The monthly fee is R4 850.00 excluding VAT', 'cl. 2.2');
    const missing = build({ fee: [fee, cand({ cents: 99900, per: 'month', what: 'levy' }, NOT_ON_PAGE)] }, MAIN);
    expect(missing.reviewItems[0]).toMatchObject({ id: 'refused:fee' });
    const same = build({ fee: [fee, cand({ cents: 485000, per: 'month', vat: 'excluded', what: 'rent' }, NOT_ON_PAGE)] }, MAIN);
    expect(same.reviewItems).toEqual([]);
  });
});

describe('what is left alone', () => {
  it('a refused wording with the same value', () => {
    const r = build({ startDate: [START, cand('2026-03-01', NOT_ON_PAGE)] }, MAIN);
    expect(r.reviewItems).toEqual([]);
  });

  it('a refused "not stated"', () => {
    const r = build({ startDate: [START, cand('not_stated', NOT_ON_PAGE)] }, MAIN);
    expect(r.reviewItems).toEqual([]);
  });

  it('a descriptive field, whatever its other wordings are', () => {
    const r = build({ scope: [cand('Office premises', '2.1 This agreement commences on 1 March 2026'), cand('Vehicle hire', NOT_ON_PAGE)] }, MAIN);
    expect(r.reviewItems).toEqual([]);
  });

  it('a clause an addendum replaced', () => {
    const parsed = { 'main.pdf': doc('18.2 not less than two calendar months before the Expiry Date.'), 'add.pdf': doc('2 The Tenant shall give not less than three calendar months before expiry of this lease.') };
    const r = buildRecord({
      id: 't', ref: 'T', files: ['main.pdf', 'add.pdf'], parsed,
      extraction: {
        fields: { notice: [{ value: { amount: 2, unit: 'months' }, quote: NOT_ON_PAGE, file: 'main.pdf', page: 1, clause: 'cl. 18.2' }, { value: { amount: 3, unit: 'months' }, quote: 'not less than three calendar months before expiry of this lease', file: 'add.pdf', page: 1, clause: 'Add. 1 cl. 2' }] },
        amendments: [{ file: 'add.pdf', page: 1, clause: 'Add. 1 cl. 2', quote: 'The Tenant shall give not less than three calendar months before expiry of this lease', targetClause: '18.2', fieldKeys: ['notice'] }],
      },
      preset,
    });
    expect(r.fields.notice!.candidates[0]!.superseded).toBeDefined();
    expect(r.reviewItems.filter((i) => i.fieldKey === 'notice')).toEqual([]);
  });

  it('a conflict, which is already flagged as one', () => {
    const both = doc('2.3 Either party may cancel on not less than 60 days written notice before the renewal date.\n2.4 A tenant may cancel on 90 days written notice before the renewal date.');
    const r = build({ notice: [cand({ amount: 60, unit: 'days', before: 'renewal' }, 'Either party may cancel on not less than 60 days written notice before the renewal date'), cand({ amount: 90, unit: 'days', before: 'renewal' }, 'A tenant may cancel on 90 days written notice before the renewal date'), cand({ amount: 30, unit: 'days' }, NOT_ON_PAGE)] }, both);
    expect(r.fields.notice!.status).toBe('conflict');
    expect(r.reviewItems.map((i) => i.id)).toEqual(['conflict:notice']);
  });
});
