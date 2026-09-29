// Page fractions. Parsers give boxes in the page's own units (PDF points, top-left origin); a viewer wants
// 0–1 fractions of the page so it only ever sets CSS percentages. Converted here, in one place.

import type { Box, ParsedPage } from './types.ts';

/** A box as fractions of the page: 0 = left/top edge, 1 = right/bottom edge. r as in Box. */
export interface FractionBox { x: number; y: number; w: number; h: number; r?: number }

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

export function toFraction(box: Box, page: { width: number; height: number }): FractionBox {
  const f: FractionBox = {
    x: round6(box.x / page.width),
    y: round6(box.y / page.height),
    w: round6(box.w / page.width),
    h: round6(box.h / page.height),
  };
  if (box.r) f.r = box.r;
  return f;
}

/** Every word of a page as text + fraction box (+ line, when the parser gave one). */
export function wordFractions(page: ParsedPage): { t: string; line?: number; box: FractionBox }[] {
  return page.words.map((w) => ({ t: w.text, ...(w.line === undefined ? {} : { line: w.line }), box: toFraction(w.box, page) }));
}

/** Largest gap between two fraction boxes on any side, as a fraction of the page (x and w against page width, y and h against page height). */
export function maxDeviation(a: FractionBox, b: FractionBox): number {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y), Math.abs(a.w - b.w), Math.abs(a.h - b.h));
}
