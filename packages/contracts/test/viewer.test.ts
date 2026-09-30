// The record's sources as the viewer draws them: one state per source, with the words for its chip.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { chipLabel, type ParsedDocument, type ParsedPage, type Word } from '../../documents/src/index.ts';
import { applyDecisions, buildRecord, fieldViewerSources, validateContractsPreset, type Candidate, type Extraction } from '../src/index.ts';

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
const cand = (value: Candidate['value'], quote: string, clause: string, p = 1, file = 'main.pdf'): Candidate => ({ value, quote, file, page: p, clause });
const build = (fields: Extraction['fields'], amendments: Extraction['amendments'] = [], docs: Record<string, ParsedDocument> = {}, files = ['main.pdf']) =>
  buildRecord({ id: 'a1', ref: 'A1', files, parsed: { 'main.pdf': MAIN, ...docs }, extraction: { fields, amendments }, preset });

const MAIN = doc(
  '2.1 This agreement commences on 1 March 2026 for a period of three (3) years.\n2.2 The monthly fee is R4 850.00 excluding VAT.',
  'Cover again.\nFees are payable monthly. Rent is R4 850.00 excluding VAT.\nDeposit is R4 850.00 excluding VAT.',
);

describe('fieldViewerSources', () => {
  it('a found source: highlight fractions, the page, a chip with page and clause', () => {
    const [s] = fieldViewerSources(build({ startDate: [cand('2026-03-01', 'This agreement commences on 1 March 2026', 'cl. 2.1')] }), 'startDate');
    expect(s).toMatchObject({ state: 'found', page: 1, clause: 'cl. 2.1', clauseChecked: true, label: 'Start' });
    expect(s!.fractions.length).toBeGreaterThan(0);
    expect(chipLabel(s!)).toBe('p.1 · cl. 2.1');
  });

  it('an unchecked clause label is dropped from the chip', () => {
    const [s] = fieldViewerSources(build({ startDate: [cand('2026-03-01', 'This agreement commences on 1 March 2026', 'cl. 9.9')] }), 'startDate');
    expect(chipLabel(s!)).toBe('p.1');
  });

  it('a quote that is not on its page: not_found, no highlight, the reason in words', () => {
    const [s] = fieldViewerSources(build({ startDate: [cand('2026-03-01', 'The Tenant shall pay a deposit', 'cl. 2.1')] }), 'startDate');
    expect(s).toMatchObject({ state: 'not_found', fractions: [], reason: 'The quoted wording was not found on this page.' });
    expect(chipLabel(s!)).toBe('Source not found — review');
  });

  it('a quote in more than one place: ambiguous', () => {
    const [s] = fieldViewerSources(build({ fee: [cand({ cents: 485000, per: 'month' }, 'R4 850.00 excluding VAT', 'cl. 2.2', 2)] }), 'fee');
    expect(s).toMatchObject({ state: 'ambiguous', fractions: [] });
    expect(chipLabel(s!)).toBe('Source unclear — review');
  });

  it('a real quote with the wrong value: value_mismatch, and the location is still shown', () => {
    const [s] = fieldViewerSources(build({ fee: [cand({ cents: 585000, per: 'month' }, 'The monthly fee is R4 850.00 excluding VAT', 'cl. 2.2')] }), 'fee');
    expect(s).toMatchObject({ state: 'value_mismatch', reason: 'The value is not in the quoted wording.' });
    expect(s!.fractions.length).toBeGreaterThan(0);
    expect(chipLabel(s!)).toBe('p.1 · cl. 2.2 · value not in wording — review');
  });

  it('a quote found on a different page than claimed keeps what was claimed', () => {
    const [s] = fieldViewerSources(build({ startDate: [cand('2026-03-01', 'This agreement commences on 1 March 2026', 'cl. 2.1', 2)] }), 'startDate');
    expect(s).toMatchObject({ state: 'found', page: 1, claimedPage: 2 });
  });

  it('a superseded clause says by what, in words', () => {
    const addendum = doc('Add. 1 Clause 2.1 is replaced: this agreement commences on 1 April 2026 for a period of three (3) years.');
    const r = build(
      {
        startDate: [
          cand('2026-03-01', 'This agreement commences on 1 March 2026', 'cl. 2.1'),
          cand('2026-04-01', 'this agreement commences on 1 April 2026 for a period of three (3) years', 'Add. 1 cl. 2', 1, 'add.pdf'),
        ],
      },
      [{ file: 'add.pdf', page: 1, clause: 'Add. 1 cl. 2', quote: 'Clause 2.1 is replaced', targetClause: '2.1', fieldKeys: ['startDate'] }],
      { 'add.pdf': addendum },
      ['main.pdf', 'add.pdf'],
    );
    const [old, current] = fieldViewerSources(r, 'startDate');
    expect(old).toMatchObject({ supersededBy: 'Add. 1 cl. 2' });
    expect(current!.supersededBy).toBeUndefined();
  });

  it('a scanned file makes every one of its highlights approximate', () => {
    const r = build({ startDate: [cand('2026-03-01', 'This agreement commences on 1 March 2026', 'cl. 2.1')] });
    expect(fieldViewerSources(r, 'startDate', { scanned: (f) => f === 'main.pdf' })[0]!.approximate).toBe(true);
    expect(fieldViewerSources(r, 'startDate')[0]!.approximate).toBeUndefined();
  });

  it('a quote that runs across a page break carries the second page\'s boxes', () => {
    const split = doc('2.2 The monthly fee is', 'R4 850.00 excluding VAT, payable in advance.');
    const r = buildRecord({ id: 'a', ref: 'A', files: ['main.pdf'], parsed: { 'main.pdf': split }, extraction: { fields: { fee: [cand({ cents: 485000, per: 'month' }, 'The monthly fee is R4 850.00 excluding VAT', 'cl. 2.2')] }, amendments: [] }, preset });
    const [s] = fieldViewerSources(r, 'fee');
    expect(s!.more).toHaveLength(1);
    expect(s!.more![0]!.page).toBe(2);
  });

  it('a field that was never extracted has no sources', () => expect(fieldViewerSources(build({}), 'fee')).toEqual([]));

  describe('flags: where a review item points, the chip says so in words', () => {
    const CONFLICT = doc('2.2 The monthly fee is R4 850.00 excluding VAT.\nSch. 1 The monthly fee is R5 850.00 excluding VAT.');
    const conflicting = () =>
      buildRecord({
        id: 'a1', ref: 'A1', files: ['main.pdf'], parsed: { 'main.pdf': CONFLICT },
        extraction: { amendments: [], fields: { fee: [cand({ cents: 485000, per: 'month' }, 'The monthly fee is R4 850.00 excluding VAT', 'cl. 2.2'), cand({ cents: 585000, per: 'month' }, 'The monthly fee is R5 850.00 excluding VAT', 'Sch. 1')] } },
        preset,
      });

    it('both sources of a conflict are flagged, and their chips say "conflict"', () => {
      const sources = fieldViewerSources(conflicting(), 'fee');
      expect(sources.map((x) => x.flag)).toEqual(['conflict', 'conflict']);
      expect(sources.map((x) => chipLabel(x))).toEqual(['p.1 · cl. 2.2 · conflict', 'p.1 · Sch. 1 · conflict']);
    });

    it('a field with no open review item has no flag', () => {
      const [x] = fieldViewerSources(build({ startDate: [cand('2026-03-01', 'This agreement commences on 1 March 2026', 'cl. 2.1')] }), 'startDate');
      expect(x!.flag).toBeUndefined();
    });

    it('once a reviewer decides the conflict, the flag is gone', () => {
      const decided = applyDecisions(conflicting(), [{ itemId: 'conflict:fee', optionId: 'clarify', chosenValueIndex: 0 }], preset);
      expect(fieldViewerSources(decided, 'fee').every((x) => x.flag === undefined)).toBe(true);
    });

    it('a blank line in the signed copy flags its source as "blank line"', () => {
      const blank = doc('2.2 This agreement shall endure for a period of __________ months.');
      const r = buildRecord({ id: 'a', ref: 'A', files: ['main.pdf'], parsed: { 'main.pdf': blank }, extraction: { amendments: [], fields: { termMonths: [cand('blank', 'This agreement shall endure for a period of __________ months', 'cl. 2.2')] } }, preset });
      const [x] = fieldViewerSources(r, 'termMonths');
      expect(x!.flag).toBe('blank');
      expect(chipLabel(x!)).toBe('p.1 · cl. 2.2 · blank line');
    });
  });
});
