// What a source viewer draws for a matched quote: the regions to highlight (as 0–1 page fractions, so the
// viewer only ever sets CSS percentages) and the text of the chip that opens it. Pure and dependency-free.

import { isTilted, type FractionBox } from './positions.ts';

/** A rectangle to draw on one page. */
export interface Region {
  page: number;
  box: FractionBox;
}

/** Padding round a clause highlight, as fractions of the page: about 2.4 pt across and 2.5 pt down on A4. */
export const PAD_X = 0.004;
export const PAD_Y = 0.003;
/** Extra sideways padding for a scanned page. LlamaParse's OCR word positions on picture-only pages run about 1% narrow
 *  across the page (measured 29–30 Sep 2026; see docs/llamaparse-findings.md), so a tight box could sit a word off. */
export const SCAN_PAD_X = 0.01;

/** One part of a match: the page it is on and its line boxes. A quote that runs across a page break has two. */
export interface Hit {
  page: number;
  fractions: FractionBox[];
  more?: { page: number; fractions: FractionBox[] }[];
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

function pad(b: FractionBox, px: number, py: number): FractionBox {
  const x = clamp01(b.x - px);
  const y = clamp01(b.y - py);
  const out: FractionBox = { x, y, w: clamp01(b.x + b.w + px) - x, h: clamp01(b.y + b.h + py) - y };
  if (b.r) out.r = b.r;
  return out;
}

/**
 * The rectangles to draw for a hit. Clause style: one padded rectangle round all of a part's upright line boxes. Words
 * tilted by 3 degrees or more (a stamp) are drawn word by word, each box rotated about its own centre, because a
 * rectangle round them would not follow them. `approximate` (a scanned page) widens the padding sideways.
 */
export function highlightRegions(hit: Hit, opts: { approximate?: boolean } = {}): Region[] {
  const px = PAD_X + (opts.approximate ? SCAN_PAD_X : 0);
  const parts = [{ page: hit.page, fractions: hit.fractions }, ...(hit.more ?? [])];
  const out: Region[] = [];
  for (const part of parts) {
    if (!part.fractions.length) continue;
    // Upright words: one padded rectangle. Tilted words (a stamp) are drawn one by one, each about its own centre.
    const flat = part.fractions.filter((b) => !isTilted(b));
    if (flat.length) {
      const x = Math.min(...flat.map((b) => b.x));
      const y = Math.min(...flat.map((b) => b.y));
      const union: FractionBox = { x, y, w: Math.max(...flat.map((b) => b.x + b.w)) - x, h: Math.max(...flat.map((b) => b.y + b.h)) - y };
      out.push({ page: part.page, box: pad(union, px, PAD_Y) });
    }
    for (const b of part.fractions.filter(isTilted)) out.push({ page: part.page, box: pad(b, px, PAD_Y) });
  }
  return out;
}

/** Chip text: "p.2 · cl. 4.1". A clause label that wasn't found on the page is dropped, leaving "p.2". */
export function chipText(s: { page: number; clause?: string; clauseChecked: boolean }): string {
  return s.clause && s.clauseChecked ? `p.${s.page} · ${s.clause}` : `p.${s.page}`;
}

/** The top-left corner of the first region, as fractions: where to scroll to. */
export function firstRegion(regions: Region[]): Region | undefined {
  return [...regions].sort((a, b) => a.page - b.page || a.box.y - b.box.y || a.box.x - b.box.x)[0];
}

/**
 * Everything a source viewer needs about one place a value was found (or wasn't). Built by a service package from its
 * own record; the viewer knows nothing about contracts.
 *   found           the quote is on the page and the value is in it
 *   value_mismatch  the quote is on the page but the value isn't in it (flagged for review, location still shown)
 *   no_position     the quote is on the page but the parser gave no usable positions for it, so nothing can be highlighted
 *   ambiguous       the quote is in more than one place
 *   not_found       the quote is nowhere on its page
 */
export interface ViewerSource {
  id: string;
  file: string;
  page: number;
  /** The page the extractor claimed, when the quote was found on a different one. */
  claimedPage?: number;
  clause?: string;
  clauseChecked: boolean;
  /** What the value is: "Notice period". */
  label: string;
  quote: string;
  state: 'found' | 'value_mismatch' | 'no_position' | 'ambiguous' | 'not_found';
  /** The reason in words, when not found. */
  reason?: string;
  fractions: FractionBox[];
  more?: { page: number; fractions: FractionBox[] }[];
  /** True on a scanned page: the highlight is padded and labelled approximate. */
  approximate?: boolean;
  /** "Add. 1 cl. 2": set when a later document replaced this clause. */
  supersededBy?: string;
  /** Set when this source is one of the places a review item points at (and it hasn't been decided yet): the chip says so in words. */
  flag?: SourceFlag;
}

/** conflict: the agreement says different things in different places. blank: a blank line in the signed copy. unclear: needs a person to read it. */
export type SourceFlag = 'conflict' | 'blank' | 'unclear';

const FLAG_CHIP: Record<SourceFlag, string> = { conflict: 'conflict', blank: 'blank line', unclear: 'unclear' };
/** The words for a badge on a flagged field. */
export const FLAG_BADGE: Record<SourceFlag, string> = { conflict: 'Conflict — review', blank: 'Blank in signed copy — review', unclear: 'Unclear — review' };

/** The words on a source's chip. */
export function chipLabel(s: Pick<ViewerSource, 'state' | 'page' | 'clause' | 'clauseChecked' | 'flag'>): string {
  switch (s.state) {
    case 'found':
      return s.flag ? `${chipText(s)} · ${FLAG_CHIP[s.flag]}` : chipText(s);
    case 'value_mismatch':
      return `${chipText(s)} · value not in wording — review`;
    case 'no_position':
      return `${chipText(s)} · no highlight`;
    case 'ambiguous':
      return 'Source unclear — review';
    default:
      return 'Source not found — review';
  }
}
