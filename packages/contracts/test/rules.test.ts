// The rules on small synthetic inputs.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ParsedDocument, ParsedPage, Word } from '../../documents/src/index.ts';
import { buildRecord, sameValue, validateContractsPreset, type Candidate, type Extraction } from '../src/index.ts';

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
const cand = (value: Candidate['value'], quote: string, clause?: string, file = 'main.pdf', p = 1): Candidate => ({ value, quote, file, page: p, ...(clause ? { clause } : {}) });

const MAIN = doc(
  '1.1 This agreement is between Acme Supplies (Pty) Ltd (sample) and Marula Office Supplies (Pty) Ltd.\n' +
    '2.1 This agreement commences on 1 March 2026 for 12 months.\n' +
    '2.2 Either party may cancel on not less than sixty days written notice before the renewal date.',
);
const build = (fields: Extraction['fields'], amendments: Extraction['amendments'] = [], parsed: Record<string, ParsedDocument> = { 'main.pdf': MAIN }, files = ['main.pdf'], p = preset) =>
  buildRecord({ id: 't', ref: 'T', files, parsed, extraction: { fields, amendments }, preset: p });

describe('rules', () => {
  it('a quote that is not on its page: not verified, flagged for review, no value shown', () => {
    const r = build({ counterparty: [cand('Acme Supplies (Pty) Ltd', 'This agreement is between Beta Holdings', 'cl. 1.1')] });
    expect(r.fields.counterparty).toMatchObject({ status: 'not_verified' });
    expect(r.fields.counterparty!.value).toBeUndefined();
    expect(r.reviewItems.map((i) => i.id)).toEqual(['not_verified:counterparty']);
  });

  it('a fuzzy match just below the threshold is not verified', () => {
    // Three words changed in a 16-word quote scores 0.86, just below the preset's 0.9.
    const r = build({ notice: [cand({ amount: 90, unit: 'days', before: 'renewal' }, 'Either party may terminate on not less than ninety days written notice before the expiry date.', 'cl. 2.2')] });
    const g = r.fields.notice!.candidates[0]!.grounding;
    expect(g.status).toBe('not_found');
    expect(g.score).toBeGreaterThan(0.85);
    expect(g.score).toBeLessThan(0.9);
    expect(r.fields.notice!.status).toBe('not_verified');
  });

  it('two candidates with the same value after normalising are not a conflict', () => {
    expect(sameValue('Acme Supplies (Pty) Ltd', '  ACME   supplies (pty) ltd ')).toBe(true);
    const r = build({
      counterparty: [
        cand('Acme Supplies (Pty) Ltd', 'This agreement is between Acme Supplies (Pty) Ltd (sample)', 'cl. 1.1'),
        cand('  ACME   supplies (pty) ltd ', 'Acme Supplies (Pty) Ltd (sample) and Marula', 'cl. 1.1'),
      ],
    });
    expect(r.fields.counterparty!.status).toBe('recorded');
    expect(r.reviewItems).toEqual([]);
  });

  it('two different values are a conflict listing every candidate as a source', () => {
    const r = build({
      notice: [
        cand({ amount: 60, unit: 'days', before: 'renewal' }, 'not less than sixty days written notice before the renewal date', 'cl. 2.2'),
        cand({ amount: 1, unit: 'months' }, 'commences on 1 March 2026 for 12 months', 'cl. 2.1'),
      ],
    });
    expect(r.fields.notice!.status).toBe('conflict');
    expect(r.reviewItems[0]).toMatchObject({ kind: 'conflict', fieldKey: 'notice' });
    expect(r.reviewItems[0]!.sources.map((s) => s.clause)).toEqual(['cl. 2.2', 'cl. 2.1']);
    expect(r.keyDates).toEqual([{ key: 'notice', label: 'Notice deadline', date: null, pendingReason: 'Pending review', what: 'Last day for written notice.', tags: ['notice'], derivation: { rule: '' } }]);
  });

  it('an amendment whose target clause is missing is not applied and is flagged', () => {
    const addendum = doc('Addendum 1. 2 Clause 9.4 is replaced: either party may cancel on 90 days notice before the renewal date.');
    const r = build(
      {
        notice: [
          cand({ amount: 60, unit: 'days', before: 'renewal' }, 'not less than sixty days written notice before the renewal date', 'cl. 2.2'),
          cand({ amount: 90, unit: 'days', before: 'renewal' }, 'either party may cancel on 90 days notice before the renewal date', 'Add. 1 cl. 2', 'add.pdf'),
        ],
      },
      [{ file: 'add.pdf', page: 1, clause: 'Add. 1 cl. 2', quote: 'Clause 9.4 is replaced', targetClause: '9.4', fieldKeys: ['notice'] }],
      { 'main.pdf': MAIN, 'add.pdf': addendum },
      ['main.pdf', 'add.pdf'],
    );
    expect(r.amendments[0]!.applied).toBe(false);
    expect(r.reviewItems.map((i) => `${i.kind}:${i.summary}`)).toContain('unclear:Amendment target not found');
    // Not applied, so both clauses stand, and they disagree.
    expect(r.fields.notice!.status).toBe('conflict');
  });

  it('a candidate recorded as blank with no blank line in the matched text is not verified', () => {
    const r = build({ termMonths: [cand('blank', 'This agreement commences on 1 March 2026 for 12 months.', 'cl. 2.1')] });
    expect(r.fields.termMonths!.status).toBe('not_verified');
    expect(r.reviewItems[0]!.kind).toBe('not_verified');
  });

  it('a required field that is not stated is flagged as unclear', () => {
    const strict = { ...preset, fields: preset.fields.map((f) => (f.key === 'deposit' ? { ...f, required: true } : f)) };
    const r = build({ deposit: [cand('not_stated', 'This agreement commences on 1 March 2026', 'cl. 2.1')] }, [], undefined, undefined, strict);
    expect(r.reviewItems).toMatchObject([{ id: 'unclear:deposit', kind: 'unclear', summary: 'Deposit not stated' }]);
    // The default preset has no required fields, as in the demo.
    expect(build({ deposit: [cand('not_stated', 'This agreement commences on 1 March 2026', 'cl. 2.1')] }).reviewItems).toEqual([]);
  });

  it('keeps a page-only chip when the clause number isn’t on the page', () => {
    const r = build({ startDate: [cand('2026-03-01', 'This agreement commences on 1 March 2026', 'cl. 7.3')] });
    expect(r.fields.startDate!.candidates[0]).toMatchObject({ clause: 'cl. 7.3', clauseChecked: false });
    expect(r.reviewItems).toEqual([]);
  });
});

describe('extraction instructions', () => {
  it('names the organisation and says the counterparty is the other party', async () => {
    const { contractsInstructions, contractsInstructionsFor } = await import('../src/index.ts');
    const text = contractsInstructionsFor('Marula Office Supplies (Pty) Ltd');
    expect(text).toContain(contractsInstructions);
    expect(text).toContain('The counterparty is the OTHER party, the one that is not "Marula Office Supplies (Pty) Ltd"');
    expect(text).toContain('only after looking through every page');
  });
  it('without an organisation name it adds no party line', async () => {
    const { contractsInstructionsFor } = await import('../src/index.ts');
    expect(contractsInstructionsFor('  ')).not.toContain('Whose register this is');
  });
});
