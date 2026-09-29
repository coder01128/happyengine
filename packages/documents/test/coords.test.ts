import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkCoords, type ExpectedCoords } from '../../../eval/fixtures/coords-check.ts';
import { mapLlamaPages, maxDeviation, toFraction, wordFractions, type LlamaPage, type ParsedDocument } from '../src/index.ts';
import { createPdfjsParser } from '../src/parsers/pdfjs.ts';

const fixtures = join(import.meta.dirname, '..', '..', '..', 'eval', 'fixtures');
const expected = JSON.parse(readFileSync(join(fixtures, 'coords.expected.json'), 'utf8')) as ExpectedCoords;

describe('page fractions', () => {
  it('divides by the page size and keeps r', () => {
    expect(toFraction({ x: 59.528, y: 84.189, w: 119.056, h: 8.4189, r: 90 }, { width: 595.28, height: 841.89 })).toEqual({ x: 0.1, y: 0.1, w: 0.2, h: 0.01, r: 90 });
    expect(toFraction({ x: 0, y: 0, w: 1, h: 1 }, { width: 2, height: 4 })).toEqual({ x: 0, y: 0, w: 0.5, h: 0.25 });
  });

  it('lists a page\'s words as text + fraction box + line', () => {
    const page = { page: 1, width: 200, height: 100, text: 'a b', words: [{ text: 'a', start: 0, end: 1, line: 3, box: { x: 20, y: 10, w: 10, h: 5 } }] };
    expect(wordFractions(page)).toEqual([{ t: 'a', line: 3, box: { x: 0.1, y: 0.1, w: 0.05, h: 0.05 } }]);
  });

  it('measures the largest gap on any side', () => {
    expect(maxDeviation({ x: 0.1, y: 0.1, w: 0.1, h: 0.1 }, { x: 0.1, y: 0.13, w: 0.1, h: 0.11 })).toBeCloseTo(0.03);
  });
});

describe('coordinate test fixture (eval/fixtures/coords.pdf)', () => {
  it('has four pages: portrait, landscape, /Rotate 90 and picture-only, 8 known words each', () => {
    expect(expected.pages.map((p) => p.kind)).toEqual(['portrait', 'landscape', 'rotate90', 'image-only']);
    expect(expected.pages.every((p) => p.words.length === 8)).toBe(true);
    // The rotated page is displayed landscape: page 3 is as wide as page 2.
    expect(expected.pages[2]).toMatchObject({ width: expected.pages[1]!.width, height: expected.pages[1]!.height });
    expect(expected.tolerance).toBe(0.01);
  });

  it('PDF.js reads every known word on the digital pages within 1% of the page (portrait, landscape, /Rotate 90)', async () => {
    const doc = await createPdfjsParser({ onEmptyPage: 'keep' }).parse(readFileSync(join(fixtures, 'coords.pdf')), { filename: 'coords.pdf' });
    const digital = { ...expected, pages: expected.pages.filter((p) => p.digital) };
    const checks = checkCoords(doc, digital);
    expect(checks.map((c) => `${c.kind} ${c.pass}/${c.words}`)).toEqual(['portrait 8/8', 'landscape 8/8', 'rotate90 8/8']);
    // The picture page has no text layer: kept, flagged, with no words.
    expect(doc.pages[3]).toMatchObject({ page: 4, positionsOk: false, words: [] });
    // The page sizes include /Rotate, as LlamaParse's do.
    expect(doc.pages[2]).toMatchObject({ width: expected.pages[2]!.width, height: expected.pages[2]!.height });
  });
});

/** A parse a perfect parser would give: every known word at its known place, in LlamaParse's sidecar shape. */
function llamaPagesFrom(shift: { x?: number; y?: number } = {}, rotateOnPage?: number): LlamaPage[] {
  return expected.pages.map((ep) => {
    let md = '';
    const words = ep.words.map((w) => {
      md += (md ? ' ' : '') + w.t;
      const s = md.length - w.t.length;
      return { span: [s, s + w.t.length] as [number, number], bbox: { x: w.box.x + (shift.x ?? 0) * ep.width, y: w.box.y + (shift.y ?? 0) * ep.height, w: w.box.w, h: w.box.h, ...(ep.page === rotateOnPage ? { r: 90 } : {}) } };
    });
    return { page_number: ep.page, page_width: ep.width, page_height: ep.height, success: true, items: [{ type: 'text', md, grounding: { lines: [{ span: [0, md.length] as [number, number], bbox: { x: 0, y: 0, w: 1, h: 1 }, words }] } }] };
  });
}
const asDoc = (pages: LlamaPage[]): ParsedDocument => ({ parser: 'llamaparse', pageCount: pages.length, pages: mapLlamaPages(pages) });

describe('the coordinate check itself (with a stand-in for LlamaParse)', () => {
  it('passes a parse that puts every word where it is, on all four pages', () => {
    const checks = checkCoords(asDoc(llamaPagesFrom()), expected);
    expect(checks.map((c) => `${c.kind} ${c.pass}/${c.words}`)).toEqual(['portrait 8/8', 'landscape 8/8', 'rotate90 8/8', 'image-only 8/8']);
  });

  it('fails a parse that is 2% off, and reports the size of the error', () => {
    const checks = checkCoords(asDoc(llamaPagesFrom({ x: 0.02 })), expected);
    expect(checks.every((c) => c.pass === 0)).toBe(true);
    expect(checks[0]!.misses[0]).toMatch(/off by 2\.0\d% of the page/);
  });

  it('accepts a parse 0.9% off but not 1.1% off (the tolerance is 1% of the page)', () => {
    expect(checkCoords(asDoc(llamaPagesFrom({ y: 0.009 })), expected).every((c) => c.pass === c.words)).toBe(true);
    expect(checkCoords(asDoc(llamaPagesFrom({ y: 0.011 })), expected).every((c) => c.pass === 0)).toBe(true);
  });

  it('carries r through to the fraction boxes and does not move the box', () => {
    const doc = asDoc(llamaPagesFrom({}, 3));
    expect(wordFractions(doc.pages[2]!)[0]!.box.r).toBe(90);
    expect(checkCoords(doc, expected)[2]!.pass).toBe(8);
  });

  it('reports a page the parser could not read as unreadable, with every word missed', () => {
    const pages = llamaPagesFrom();
    pages[3] = { page_number: 4, success: false, error: 'render failed' };
    const c = checkCoords(asDoc(pages), expected)[3]!;
    expect(c).toMatchObject({ pass: 0, words: 8, unreadable: 'render failed' });
  });
});
