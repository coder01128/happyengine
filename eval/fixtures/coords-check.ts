// Compares a parse of coords.pdf with the known word positions in coords.expected.json.
// A word passes when it is found on its page and its box (as fractions of the page) is within the
// tolerance (1% of the page) of the expected box on every side. Used by scripts/check-coords.ts and the tests.

import { maxDeviation, toFraction, type Box, type ParsedDocument } from '../../packages/documents/src/index.ts';

export interface ExpectedCoords {
  tolerance: number;
  pages: { page: number; kind: string; width: number; height: number; digital: boolean; words: { t: string; box: Box }[] }[];
}

export interface PageCheck {
  page: number;
  kind: string;
  /** Known words on the page. */
  words: number;
  found: number;
  /** Found and within tolerance. */
  pass: number;
  /** Largest deviation seen among found words, as a fraction of the page. */
  worst: number;
  /** Set when the parser gave up on the page (no positions). */
  unreadable?: string;
  misses: string[];
}

/** Letters and digits only, lowercase: "**Alpha**" and "Alpha," both read "alpha". */
const key = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

export function checkCoords(doc: ParsedDocument, expected: ExpectedCoords): PageCheck[] {
  return expected.pages.map((ep) => {
    const out: PageCheck = { page: ep.page, kind: ep.kind, words: ep.words.length, found: 0, pass: 0, worst: 0, misses: [] };
    const page = doc.pages.find((p) => p.page === ep.page);
    if (!page) {
      out.unreadable = 'the parser returned no such page';
      out.misses = ep.words.map((w) => `${w.t}: page missing`);
      return out;
    }
    if (page.positionsOk === false) {
      out.unreadable = page.positionsError ?? 'no positions';
      out.misses = ep.words.map((w) => `${w.t}: page has no positions`);
      return out;
    }
    for (const w of ep.words) {
      const want = toFraction(w.box, { width: ep.width, height: ep.height });
      // Same word text on this page: take the one nearest the expected place.
      const near = page.words
        .filter((pw) => key(pw.text) === key(w.t))
        .map((pw) => ({ dev: maxDeviation(toFraction(pw.box, page), want), box: toFraction(pw.box, page) }))
        .sort((a, b) => a.dev - b.dev)[0];
      if (!near) {
        out.misses.push(`${w.t}: not found on the page`);
        continue;
      }
      out.found++;
      out.worst = Math.max(out.worst, near.dev);
      if (near.dev <= expected.tolerance) out.pass++;
      else out.misses.push(`${w.t}: off by ${(near.dev * 100).toFixed(2)}% of the page (allowed ${(expected.tolerance * 100).toFixed(0)}%)`);
    }
    return out;
  });
}
