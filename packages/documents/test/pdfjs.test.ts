import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createPdfjsParser } from '../src/parsers/pdfjs.ts';
import { createFixtureParser, ground, ParserError } from '../src/index.ts';

const contracts = join(import.meta.dirname, '..', '..', '..', 'eval', 'contracts');
const pdf = (set: string, name: string) => readFileSync(join(contracts, set, name));
const parser = createPdfjsParser();

describe('pdfjs parser (digital PDFs)', () => {
  it('reads the text layer with a box for every word', async () => {
    const doc = await parser.parse(pdf('demo-marula', 'c5-courier.pdf'), { filename: 'c5-courier.pdf' });
    expect(doc).toMatchObject({ parser: 'pdfjs', pageCount: 4 });
    const page = doc.pages[0]!;
    expect(page.width).toBeCloseTo(595.9, 0);
    expect(page.height).toBeCloseTo(842.9, 0);
    for (const w of page.words) {
      expect(page.text.slice(w.start, w.end)).toBe(w.text);
      expect(w.box.x).toBeGreaterThanOrEqual(0);
      expect(w.box.y + w.box.h).toBeLessThanOrEqual(page.height);
    }
    expect(ground('This agreement shall endure for a period of ______ months', page, 0.9)).toMatchObject({ status: 'grounded', score: 1 });
  });

  it('fails on a scan with no text layer', async () => {
    const err = await parser.parse(pdf('scan-marula', 'c5-courier.pdf'), { filename: 'c5-courier.pdf' }).catch((e) => e);
    expect(err).toBeInstanceOf(ParserError);
    expect(err.code).toBe('no_text_layer');
  });
});

describe('fixture parser', () => {
  it('replays a recorded parse by filename', async () => {
    const recorded = { parser: 'pdfjs' as const, pageCount: 1, pages: [{ page: 1, width: 10, height: 10, text: 'x', words: [] }] };
    const fixture = createFixtureParser({ 'a.pdf': recorded });
    expect(await fixture.parse(new Uint8Array(), { filename: 'a.pdf' })).toEqual(recorded);
    await expect(fixture.parse(new Uint8Array(), { filename: 'b.pdf' })).rejects.toThrow(/No recorded parse/);
  });
});
