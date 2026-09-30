// The eval's scoring: per-field counts, the highlight rule (overlap or inside the expected box), and the reason on every miss.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { addScore, emptyScore, sameAnswer, scoreAgreement, type Boxes, type ExpectedAgreement } from '../../../eval/contracts/score.ts';
import type { ParsedDocument, ParsedPage, Word } from '../../documents/src/index.ts';
import { buildRecord, validateContractsPreset, type Candidate } from '../src/index.ts';

const preset = validateContractsPreset(JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', '..', 'presets', 'contracts.default.json'), 'utf8')));

/** An A4 page (points), one line per row: 6 units per character, 20 per row, 12 high. */
function page(text: string): ParsedPage {
  const words: Word[] = [];
  let offset = 0;
  text.split('\n').forEach((line, row) => {
    for (const m of line.matchAll(/\S+/g)) words.push({ text: m[0], start: offset + m.index, end: offset + m.index + m[0].length, box: { x: 40 + m.index * 6, y: 100 + row * 20, w: m[0].length * 6, h: 12 } });
    offset += line.length + 1;
  });
  return { page: 1, width: 595.28, height: 841.89, text, words };
}
const DOC: ParsedDocument = { parser: 'fixture', pageCount: 1, pages: [page('2.1 This agreement commences on 1 March 2026 for a period of twelve months.')] };
const cand = (value: Candidate['value'], quote: string): Candidate => ({ value, quote, file: 'main.pdf', page: 1, clause: 'cl. 2.1' });
const record = (candidates: Candidate[]) => buildRecord({ id: 'a', ref: 'A', files: ['main.pdf'], parsed: { 'main.pdf': DOC }, extraction: { fields: { startDate: candidates }, amendments: [] }, preset });
const expectedFor = (value: string): ExpectedAgreement => ({ fields: { startDate: { value, source: ['x'] } }, flags: [], dates: [] });
const score = (candidates: Candidate[], box: { x: number; y: number; w: number; h: number }, value = '2026-03-01') =>
  scoreAgreement('a', record(candidates), expectedFor(value), '2026-10-14', preset, { 'main.pdf': DOC }, { 'main.pdf': { x: [{ page: 1, ...box }] } } as Boxes);

// The quote "This agreement commences on 1 March 2026" sits at x 64–304, y 100–112 on this page.
const QUOTE = 'This agreement commences on 1 March 2026';

describe('highlight rule', () => {
  it('counts a box that lies inside a larger, padded expected box, even though the overlap is low', () => {
    const s = score([cand('2026-03-01', QUOTE)], { x: 30, y: 90, w: 500, h: 40 }); // expected box is 10x the quote's area
    expect(s.highlights).toMatchObject({ ok: 1, iouOk: 0, total: 1, misses: [] });
  });

  it('counts a box that overlaps the expected box', () => {
    const s = score([cand('2026-03-01', QUOTE)], { x: 62, y: 99, w: 245, h: 14 });
    expect(s.highlights).toMatchObject({ ok: 1, iouOk: 1 });
  });

  it('is a miss, with the numbers, when the box is somewhere else', () => {
    const s = score([cand('2026-03-01', QUOTE)], { x: 300, y: 500, w: 100, h: 20 });
    expect(s.highlights.ok).toBe(0);
    expect(s.highlights.misses[0]).toMatch(/A startDate \(main\.pdf p\.1 cl\. 2\.1\): box is elsewhere: overlap 0\.00, inside expected 0%/);
  });

  it('is a miss, saying so, when the quote was not found so there is no highlight', () => {
    const s = score([cand('2026-03-01', 'The Tenant shall pay a deposit of R7 500.00 on signature')], { x: 30, y: 90, w: 500, h: 40 });
    expect(s.highlights.misses[0]).toMatch(/no highlight: quote not found on its page/);
  });

  it('does not score a source cited at a place the answer key does not list: counted apart, not a miss', () => {
    const r = record([cand('2026-03-01', QUOTE)]);
    const s = scoreAgreement('a', r, expectedFor('2026-03-01'), '2026-10-14', preset, { 'main.pdf': DOC }, { 'main.pdf': {} } as Boxes);
    expect(s.highlights).toMatchObject({ total: 0, ok: 0, unlisted: 1, misses: [] });
  });
});

describe('fields', () => {
  it('counts correct and total per field, and adds them across agreements', () => {
    const right = score([cand('2026-03-01', QUOTE)], { x: 30, y: 90, w: 500, h: 40 });
    const wrong = score([cand('2026-03-01', QUOTE)], { x: 30, y: 90, w: 500, h: 40 }, '2026-04-01');
    expect(right.fields.byField).toEqual({ startDate: { correct: 1, total: 1 } });
    expect(wrong.fields.byField).toEqual({ startDate: { correct: 0, total: 1 } });
    expect(addScore(right, wrong).fields.byField).toEqual({ startDate: { correct: 1, total: 2 } });
    expect(addScore(emptyScore(), right).fields.byField).toEqual({ startDate: { correct: 1, total: 1 } });
  });

  it('gives the reason on a miss: what the rules did with what the extractor cited', () => {
    const notFound = score([cand('2026-03-01', 'The Tenant shall pay a deposit of R7 500.00 on signature')], { x: 30, y: 90, w: 500, h: 40 });
    expect(notFound.fields.misses[0]).toMatch(/expected "2026-03-01", got "not_verified" — flagged: the quoted wording was not found on its page \(cited p\.1 · cl\. 2\.1\)/);

    const wrongValue = score([cand('2026-04-01', QUOTE)], { x: 30, y: 90, w: 500, h: 40 });
    expect(wrongValue.fields.misses[0]).toMatch(/flagged: value not found in cited text/);

    const none = scoreAgreement('a', buildRecord({ id: 'a', ref: 'A', files: ['main.pdf'], parsed: { 'main.pdf': DOC }, extraction: { fields: {}, amendments: [] }, preset }), expectedFor('2026-03-01'), '2026-10-14', preset, { 'main.pdf': DOC });
    expect(none.fields.misses[0]).toMatch(/the extractor gave no candidate for this field/);
  });
});

describe('sameAnswer: free-text values are compared loosely', () => {
  const expected = { text: 'Rates per Schedule A' };
  it.each([
    ['the same words', { text: 'Rates per Schedule A' }],
    ['other case and punctuation', { text: 'rates, per schedule a.' }],
    ['the expected words plus more', { text: 'Per-service rates in Schedule A (e.g. Same-day within city R185.00), excluding VAT' }],
  ])('accepts %s', (_name, got) => expect(sameAnswer(got, expected)).toBe(true));

  it.each([
    ['a different schedule', { text: 'Rates per Schedule B' }],
    ['a word missing', { text: 'Rates in Schedule A' }],
  ])('refuses %s', (_name, got) => expect(sameAnswer(got, expected)).toBe(false));

  it('leaves every other kind of value to an exact comparison', () => {
    expect(sameAnswer({ cents: 485000, per: 'month' }, { cents: 485000, per: 'month' })).toBe(true);
    expect(sameAnswer({ cents: 485000, per: 'month' }, { cents: 585000, per: 'month' })).toBe(false);
    expect(sameAnswer('2026-03-01', '2026-03-01')).toBe(true);
    expect(sameAnswer('2026-03-01', '2026-03-02')).toBe(false);
  });
});
