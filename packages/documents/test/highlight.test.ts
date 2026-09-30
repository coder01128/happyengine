import { describe, expect, it } from 'vitest';
import { chipText, firstRegion, highlightRegions, PAD_X, PAD_Y, SCAN_PAD_X } from '../src/index.ts';

const close = (a: number, b: number) => expect(a).toBeCloseTo(b, 6);

describe('highlightRegions', () => {
  it('draws one padded rectangle round all the line boxes of a clause', () => {
    const [r, ...rest] = highlightRegions({ page: 2, fractions: [{ x: 0.1, y: 0.2, w: 0.5, h: 0.02 }, { x: 0.1, y: 0.22, w: 0.3, h: 0.02 }] });
    expect(rest).toEqual([]);
    expect(r!.page).toBe(2);
    close(r!.box.x, 0.1 - PAD_X);
    close(r!.box.y, 0.2 - PAD_Y);
    close(r!.box.w, 0.5 + 2 * PAD_X);
    close(r!.box.h, 0.04 + 2 * PAD_Y);
  });

  it('never leaves the page', () => {
    const [r] = highlightRegions({ page: 1, fractions: [{ x: 0.001, y: 0.001, w: 0.998, h: 0.998 }] });
    expect(r!.box).toEqual({ x: 0, y: 0, w: 1, h: 1 });
  });

  it('widens the padding sideways, not up and down, for a scanned page', () => {
    const tight = highlightRegions({ page: 1, fractions: [{ x: 0.3, y: 0.3, w: 0.2, h: 0.02 }] })[0]!.box;
    const wide = highlightRegions({ page: 1, fractions: [{ x: 0.3, y: 0.3, w: 0.2, h: 0.02 }] }, { approximate: true })[0]!.box;
    close(tight.x - wide.x, SCAN_PAD_X);
    close(wide.w - tight.w, 2 * SCAN_PAD_X);
    close(wide.y, tight.y);
    close(wide.h, tight.h);
  });

  it('gives one region per page for a quote that runs across a page break', () => {
    const regions = highlightRegions({ page: 4, fractions: [{ x: 0.1, y: 0.9, w: 0.6, h: 0.02 }], more: [{ page: 5, fractions: [{ x: 0.1, y: 0.05, w: 0.3, h: 0.02 }] }] });
    expect(regions.map((r) => r.page)).toEqual([4, 5]);
  });

  it('keeps rotated words as separate boxes, each with its own rotation (a rectangle would not follow them)', () => {
    const regions = highlightRegions({ page: 1, fractions: [{ x: 0.1, y: 0.1, w: 0.05, h: 0.02, r: 90 }, { x: 0.2, y: 0.1, w: 0.05, h: 0.02, r: 90 }] });
    expect(regions).toHaveLength(2);
    expect(regions.every((r) => r.box.r === 90)).toBe(true);
  });

  it('draws nothing when there are no boxes (a source that was not found)', () => {
    expect(highlightRegions({ page: 1, fractions: [] })).toEqual([]);
  });
});

describe('chipText', () => {
  it.each([
    [{ page: 2, clause: 'cl. 4.1', clauseChecked: true }, 'p.2 · cl. 4.1'],
    [{ page: 2, clause: 'cl. 4.1', clauseChecked: false }, 'p.2'],
    [{ page: 7, clauseChecked: true }, 'p.7'],
    [{ page: 1, clause: 'Sch. 2', clauseChecked: true }, 'p.1 · Sch. 2'],
  ])('%j → %s', (s, text) => expect(chipText(s)).toBe(text));
});

describe('firstRegion', () => {
  it('is the top-most region on the earliest page', () => {
    const b = (y: number) => ({ x: 0, y, w: 1, h: 0.1 });
    expect(firstRegion([{ page: 3, box: b(0.1) }, { page: 2, box: b(0.6) }, { page: 2, box: b(0.3) }])).toEqual({ page: 2, box: b(0.3) });
    expect(firstRegion([])).toBeUndefined();
  });
});

describe('highlightRegions with a stamp in the quote', () => {
  it('draws one padded rectangle for the upright words and each tilted word on its own', () => {
    const regions = highlightRegions({ page: 1, fractions: [{ x: 0.1, y: 0.4, w: 0.1, h: 0.01 }, { x: 0.21, y: 0.4, w: 0.1, h: 0.01 }, { x: 0.32, y: 0.39, w: 0.08, h: 0.02, r: 9 }] });
    expect(regions).toHaveLength(2);
    expect(regions[0]!.box.r).toBeUndefined();
    expect(regions[1]!.box.r).toBe(9);
  });

  it('a tilt under 3 degrees is upright', () => {
    const regions = highlightRegions({ page: 1, fractions: [{ x: 0.1, y: 0.4, w: 0.1, h: 0.01, r: 1.5 }, { x: 0.21, y: 0.4, w: 0.1, h: 0.01 }] });
    expect(regions).toHaveLength(1);
    expect(regions[0]!.box.r).toBeUndefined();
  });
});
