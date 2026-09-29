import { describe, expect, it } from 'vitest';
import { BLANK, ground, normalise, type ParsedPage, type Word } from '../src/index.ts';

/** A page whose word boxes follow a simple grid: 6 units per character, 20 per line, 12 high. */
function pageOf(text: string, page = 1): ParsedPage {
  const words: Word[] = [];
  let lineStart = 0;
  text.split('\n').forEach((line, n) => {
    for (const m of line.matchAll(/\S+/g)) {
      words.push({ text: m[0], start: lineStart + m.index, end: lineStart + m.index + m[0].length, box: { x: m.index * 6, y: n * 20, w: m[0].length * 6, h: 12 } });
    }
    lineStart += line.length + 1;
  });
  return { page, width: 600, height: 800, text, words };
}

describe('normalise', () => {
  it('maps every character back to the page text', () => {
    const n = normalise('The “Rent”\n  is  **due**');
    expect(n.text).toBe('the "rent" is due');
    expect(n.from.length).toBe(n.text.length);
  });
  it('turns a blank run into one token', () => expect(normalise('period of ________ months').text).toBe(`period of ${BLANK} months`));
});

describe('ground', () => {
  it('finds an exact quote and its box', () => {
    const page = pageOf('4.1 This lease shall endure for the Lease Period.');
    const r = ground('This lease shall endure', page, 0.9);
    expect(r).toMatchObject({ status: 'grounded', score: 1, page: 1 });
    expect(page.text.slice(r.start, r.end)).toBe('This lease shall endure');
    expect(r.boxes).toEqual([{ x: 24, y: 0, w: 138, h: 12 }]);
  });

  it('ignores curly versus straight quotes and dashes', () => {
    const page = pageOf('“Premises” means Unit 4 – Oakridge Business Park');
    expect(ground('"Premises" means Unit 4 - Oakridge', page, 0.9)).toMatchObject({ status: 'grounded', score: 1 });
  });

  it('joins a word hyphenated across a line break', () => {
    const page = pageOf('three months before the termi-\nnation date of this lease');
    const r = ground('before the termination date', page, 0.9);
    expect(r).toMatchObject({ status: 'grounded', score: 1 });
    expect(r.boxes).toHaveLength(2);
  });

  it('reads through a markdown table cell', () => {
    const page = pageOf('| Period | Monthly rent |\n| --- | --- |\n| Year 3 · 1 Feb 2026 | **R32 000.00** |');
    const r = ground('Year 3 · 1 Feb 2026 R32 000.00', page, 0.9);
    expect(r).toMatchObject({ status: 'grounded', score: 1 });
  });

  it('matches a blank of underscores whatever its length', () => {
    const page = pageOf('2.2 This agreement shall endure for a period of __________ months.');
    const r = ground('This agreement shall endure for a period of ______ months', page, 0.9);
    expect(r).toMatchObject({ status: 'grounded', score: 1 });
    expect(page.text.slice(r.start, r.end)).toBe('This agreement shall endure for a period of __________ months');
  });

  it('does not look on another page: a quote not on its page is not found', () => {
    const page = pageOf('Schedule 1 · Premises and domicilia', 2);
    expect(ground('The Tenant shall have the option to renew', page, 0.9)).toEqual({ status: 'not_found', score: expect.any(Number), page: 2, boxes: [] });
  });

  it('refuses a near miss below the threshold', () => {
    const page = pageOf('on not less than sixty days written notice before the renewal date');
    const r = ground('on not less than ninety days written notice before the expiry date', page, 0.9);
    expect(r.status).toBe('not_found');
    expect(r.score).toBeGreaterThan(0.6);
    expect(r.score).toBeLessThan(0.9);
  });

  it('accepts a small OCR slip above the threshold', () => {
    const page = pageOf('Tbe Tenant shall pay the Rent monthly in advance on the first Business Day');
    const r = ground('The Tenant shall pay the Rent monthly in advance', page, 0.9);
    expect(r.status).toBe('grounded');
    expect(r.score).toBeGreaterThanOrEqual(0.9);
    expect(r.score).toBeLessThan(1);
    expect(page.text.slice(r.start, r.end)).toBe('Tbe Tenant shall pay the Rent monthly in advance');
  });

  it('gives one box per line for a quote spanning two lines', () => {
    const page = pageOf('The Tenant shall exercise the option by written notice\nto the Landlord given not less than three months');
    const r = ground('by written notice to the Landlord', page, 0.9);
    expect(r.status).toBe('grounded');
    expect(r.boxes).toEqual([
      { x: 37 * 6, y: 0, w: 17 * 6, h: 12 },
      { x: 0, y: 20, w: 15 * 6, h: 12 },
    ]);
  });

  it('marks a quote that appears twice (first one taken)', () => {
    const page = pageOf('excluding VAT. The Rent excluding VAT is payable');
    expect(ground('excluding VAT', page, 0.9)).toMatchObject({ status: 'grounded', score: 0.99, start: 0 });
  });

  it('never grounds an empty quote', () => expect(ground('  ', pageOf('anything at all'), 0.9).status).toBe('not_found'));
});
