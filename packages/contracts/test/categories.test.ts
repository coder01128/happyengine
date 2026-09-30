// D18 and D19: the kind of agreement decides which fields are required. "Not stated" on a required field is flagged,
// including when the extractor gave no wording at all; an end date worked out from start and term is not "not stated";
// a category the checks are not applied to must be confirmed by a person; a missing or disputed category counts as
// unclassified. Uses the real default preset. Small synthetic inputs, no network.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ParsedDocument, ParsedPage, Word } from '../../documents/src/index.ts';
import { AGREEMENT_CATEGORIES, applyDecisions, buildRecord, contractsSchema, validateContractsPreset, type Candidate, type Extraction } from '../src/index.ts';

const raw = readFileSync(join(import.meta.dirname, '..', '..', '..', 'presets', 'contracts.default.json'), 'utf8');
const preset = validateContractsPreset(JSON.parse(raw));

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

const MAIN = doc(
  'LEASE AGREEMENT\n' +
    '1.1 The Landlord lets the premises to the Tenant.\n' +
    '2.1 This lease commences on 1 March 2026 and ends on 28 February 2029.\n' +
    '2.2 The lease is for a period of thirty six (36) months.\n' +
    '3.1 The Tenant may renew this lease for a further 36 months.\n' +
    '3.2 Either party may cancel on not less than 3 calendar months written notice before expiry.',
);
const build = (fields: Extraction['fields'], main: ParsedDocument = MAIN) =>
  buildRecord({ id: 't', ref: 'T', files: ['main.pdf'], parsed: { 'main.pdf': main }, extraction: { fields, amendments: [] }, preset });

const category = (value: string, quote = 'LEASE AGREEMENT') => cand(value, quote, 'title');
const START = cand('2026-03-01', 'This lease commences on 1 March 2026', 'cl. 2.1');
const END = cand('2029-02-28', 'ends on 28 February 2029', 'cl. 2.1');
const TERM = cand(36, 'The lease is for a period of thirty six (36) months', 'cl. 2.2');
const RENEWAL = cand({ kind: 'option', periodMonths: 36 }, 'The Tenant may renew this lease for a further 36 months', 'cl. 3.1');
const NOTICE = cand({ amount: 3, unit: 'months', before: 'expiry' }, 'Either party may cancel on not less than 3 calendar months written notice before expiry', 'cl. 3.2');
const ALL: Extraction['fields'] = { agreementCategory: [category('lease')], startDate: [START], endDate: [END], termMonths: [TERM], renewal: [RENEWAL], notice: [NOTICE] };
const ids = (r: ReturnType<typeof build>) => r.reviewItems.map((i) => i.id);

describe('a lease, rental, subscription, service or licence needs renewal, notice and end date', () => {
  it('nothing is flagged when all three are stated', () => {
    const r = build(ALL);
    expect(ids(r)).toEqual([]);
    expect(r.status).toBe('ready');
  });

  it.each(['lease', 'licence', 'rental', 'service', 'subscription'])('%s: a "not stated" renewal is flagged', (kind) => {
    const r = build({ ...ALL, agreementCategory: [category(kind)], renewal: [cand('not_stated', 'The Tenant may renew this lease for a further 36 months')] });
    expect(r.fields.renewal!.status).toBe('not_stated');
    expect(r.reviewItems).toHaveLength(1);
    expect(r.reviewItems[0]).toMatchObject({ id: 'unclear:renewal', kind: 'unclear', fieldKey: 'renewal', summary: 'Renewal not stated' });
    expect(r.status).toBe('flagged');
  });

  it('a required field the extractor gave no wording for at all is flagged, not left out', () => {
    const { renewal: _r, notice: _n, ...rest } = ALL;
    const r = build(rest);
    expect(ids(r)).toEqual(['unclear:renewal', 'unclear:notice']);
    expect(r.fields.renewal).toMatchObject({ status: 'not_stated', value: 'not_stated', candidates: [] });
    expect(r.reviewItems[0]!.summary).toBe('Renewal not stated (no wording found for it)');
  });

  it('an end date that is not stated but can be worked out from start and term is not flagged', () => {
    const { endDate: _e, ...rest } = ALL;
    const r = build(rest);
    expect(ids(r)).toEqual([]);
    expect(r.fields.endDate).toMatchObject({ status: 'recorded', value: '2029-02-28', derived: { from: ['startDate', 'termMonths'] } });
  });

  it('an end date that is neither stated nor calculable is flagged', () => {
    const { endDate: _e, termMonths: _t, ...rest } = ALL;
    const r = build(rest);
    expect(ids(r)).toEqual(['unclear:endDate']);
    expect(r.status).toBe('flagged');
  });

  it('a stated end date, next to a not-stated one for the same field, is not "not stated"', () => {
    const r = build({ ...ALL, endDate: [END, cand('not_stated', 'This lease commences on 1 March 2026')] });
    expect(ids(r)).toEqual([]);
  });
});

describe('a kind the checks are not applied to', () => {
  it.each(['loan', 'nda', 'order', 'poa', 'sale', 'settlement'])('%s: no dates are required, and a person must confirm the category', (kind) => {
    const r = build({ agreementCategory: [category(kind)], startDate: [START] });
    expect(ids(r)).toEqual(['confirm:agreementCategory']);
    expect(r.reviewItems[0]).toMatchObject({ kind: 'unclear', fieldKey: 'agreementCategory' });
    expect(r.reviewItems[0]!.summary).toContain('A person must confirm the category');
    expect(r.reviewItems[0]!.sources).toHaveLength(1);
  });

  it('confirming the category is a review decision like any other', () => {
    const r = build({ agreementCategory: [category('nda')], startDate: [START] });
    const done = applyDecisions(r, [{ itemId: 'confirm:agreementCategory', optionId: 'confirm' }], preset);
    expect(done.status).toBe('reviewed');
    expect(done.reviewItems[0]!.decision?.optionId).toBe('confirm');
  });

  it('a lease misread as a non-disclosure agreement is not silent: it raises the confirm flag', () => {
    const { renewal: _r, notice: _n, ...rest } = ALL;
    const r = build({ ...rest, agreementCategory: [category('nda')] });
    expect(ids(r)).toEqual(['confirm:agreementCategory']);
  });
});

describe('an agreement with no usable category is unclassified, and unclassified needs the three fields', () => {
  it('no category at all', () => {
    expect(ids(build({ startDate: [START], termMonths: [TERM] }))).toEqual(['unclear:renewal', 'unclear:notice']);
  });

  it('"other" needs them, with no confirm flag', () => {
    expect(ids(build({ agreementCategory: [category('other')], startDate: [START], termMonths: [TERM] }))).toEqual(['unclear:renewal', 'unclear:notice']);
  });

  it('a category that is not in the list', () => {
    expect(ids(build({ agreementCategory: [category('franchise')], startDate: [START], termMonths: [TERM] }))).toEqual(['unclear:renewal', 'unclear:notice']);
  });

  it('two different categories are a conflict, and the checks apply as for unclassified', () => {
    const two = doc('LEASE AGREEMENT\nCONFIDENTIALITY AGREEMENT\n2.1 This lease commences on 1 March 2026.');
    const r = build({ agreementCategory: [category('lease'), category('nda', 'CONFIDENTIALITY AGREEMENT')], startDate: [START] }, two);
    expect(r.fields.agreementCategory!.status).toBe('conflict');
    expect(ids(r)).toEqual(['conflict:agreementCategory', 'unclear:renewal', 'unclear:notice', 'unclear:endDate']);
  });

  it('a title repeated on the page is taken at the first place, not refused as ambiguous', () => {
    const twice = doc('LEASE AGREEMENT\nbetween the parties\nThis LEASE AGREEMENT is made on 1 March 2026.');
    const r = build({ agreementCategory: [category('lease')] }, twice);
    expect(r.fields.agreementCategory).toMatchObject({ status: 'recorded', value: 'lease' });
    expect(r.fields.agreementCategory!.candidates[0]!.grounding).toMatchObject({ status: 'grounded', score: 0.99 });
  });
});

describe('the preset and the extraction schema agree on the categories', () => {
  it('every category in the preset is one the extractor may answer with, and the reverse', () => {
    expect(preset.categories.map((c) => c.id).sort()).toEqual([...AGREEMENT_CATEGORIES].sort());
    const schema = contractsSchema.properties.fields.properties.agreementCategory as { items: { properties: { value: { anyOf: { enum?: string[] }[] } } } };
    expect([...schema.items.properties.value.anyOf[0]!.enum!].sort()).toEqual([...AGREEMENT_CATEGORIES].sort());
  });

  it('the checks apply to lease, licence, rental, service and subscription (and other, for unclassified)', () => {
    expect(preset.categories.filter((c) => c.required.length).map((c) => c.id)).toEqual(['lease', 'licence', 'other', 'rental', 'service', 'subscription']);
    expect(preset.categories.filter((c) => c.confirm).map((c) => c.id)).toEqual(['loan', 'nda', 'order', 'poa', 'sale', 'settlement']);
    expect(preset.uncategorised.required).toEqual(['renewal', 'notice', 'endDate']);
  });

  it('is in alphabetical order by label, has "other", and only names real fields', () => {
    const bad = (mutate: (p: any) => void) => {
      const p = JSON.parse(raw);
      mutate(p);
      return () => validateContractsPreset(p);
    };
    expect(bad((p) => p.categories.reverse())).toThrow(/alphabetical/);
    expect(bad((p) => (p.categories = p.categories.filter((c: any) => c.id !== 'other')))).toThrow(/"other"/);
    expect(bad((p) => (p.categories[0].required = ['nonsense']))).toThrow(/categories\.lease\.required/);
    expect(bad((p) => (p.uncategorised.required = ['nonsense']))).toThrow(/uncategorised\.required/);
    expect(bad((p) => delete p.uncategorised)).toThrow(/uncategorised/);
  });
});
