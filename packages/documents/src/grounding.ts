// The quote check: find an extracted quote on the page it was cited from (or, failing that, elsewhere in the
// document) and return the boxes of the words it covers. A quote that can't be found, or that matches in
// more than one place, is flagged for review and never guessed at.
//
// Dependency-free (types and page fractions only), so edge functions and Node scripts import the same code.

import { isTilted, toFraction, type FractionBox } from './positions.ts';
import type { Box, ParsedPage } from './types.ts';

/** The part of a quote that sits on a following page, when the quote runs across a page break. */
export interface GroundingPart {
  page: number;
  /** Offsets into that page's text. */
  start: number;
  end: number;
  boxes: Box[];
  fractions: FractionBox[];
}

export interface GroundingResult {
  /** ambiguous: the quote matches in more than one place, so none is taken. */
  status: 'grounded' | 'ambiguous' | 'not_found';
  /** 1 = exact, 0.99 = exact but the text occurs more than once (single-page ground() only), below that = fuzzy. */
  score: number;
  /** The page the quote was found on (its first page, if it crosses a page break). */
  page: number;
  /** Offsets into page.text. */
  start?: number;
  end?: number;
  /** One box per visual line, in the page's own units (PDF points). */
  boxes: Box[];
  /** The same boxes as fractions of the page (0–1): what a viewer draws. Present when grounded. */
  fractions?: FractionBox[];
  /** How it was found: as written (after normalising), or by fuzzy alignment. */
  match?: 'exact' | 'fuzzy';
  /** Set when the quote was found on a different page from the one claimed. */
  claimedPage?: number;
  /** The rest of the quote on the next page, when it runs across a page break. */
  more?: GroundingPart[];
  /** For ambiguous: the pages it matched on. */
  pages?: number[];
  /** Why, when not grounded and the reason isn't just "not there". */
  note?: string;
  /** Words left out of the boxes because their position looked wrong (far from the rest of the quote). The highlight is approximate. */
  trimmed?: number;
  /** The quote is on the page but too few of its words have a position to draw a highlight. */
  unpositioned?: true;
}

export interface GroundOptions {
  /** Stray words a watermark or stamp drops into the text ("SAMPLE", "COPY"). A page word on this list is skipped
   *  when matching, unless the quote itself contains that word. */
  ignoreTokens?: string[];
}

/** Normalised text, with the page.text range each normalised character came from. */
interface Normalised {
  text: string;
  from: number[];
  to: number[];
}

/** A blank line in a signed copy (runs of 3+ underscores or dots) becomes this one token. */
export const BLANK = '⎵';

const CHAR_MAP: Record<string, string> = {
  '‘': "'", '’': "'", '‚': "'", '‛': "'", '′': "'", '`': "'",
  '“': '"', '”': '"', '„': '"', '‟': '"', '″': '"',
  '–': '-', '—': '-', '‒': '-', '―': '-', '−': '-',
  'ﬀ': 'ff', 'ﬁ': 'fi', 'ﬂ': 'fl', 'ﬃ': 'ffi', 'ﬄ': 'ffl', 'ﬅ': 'st', 'ﬆ': 'st',
};
const TABLE_RULE = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;
const HEADING = /^ {0,3}#{1,6}[ \t]+/;
const LINE_END_HYPHEN = /^-[ \t]*\r?\n[ \t]*(?=\p{Ll})/u;
const LETTER = /\p{L}/u;
const SPACE = /\s/;

/**
 * Lowercase; collapse whitespace; straight quotes and hyphens; expand ligatures; drop soft hyphens and
 * line-end hyphenation; drop markdown emphasis, table pipes and rules, and heading marks; turn blank
 * runs into BLANK. Keeps, for every output character, the range of input characters it came from.
 */
export function normalise(input: string): Normalised {
  const out: string[] = [];
  const from: number[] = [];
  const to: number[] = [];
  const emit = (s: string, a: number, b: number) => {
    for (const ch of s.toLowerCase()) {
      out.push(ch);
      from.push(a);
      to.push(b);
    }
  };
  const space = (a: number, b: number) => {
    if (out.length && out[out.length - 1] !== ' ') emit(' ', a, b);
  };

  let i = 0;
  let lineStart = true;
  while (i < input.length) {
    if (lineStart) {
      lineStart = false;
      const nl = input.indexOf('\n', i);
      const line = input.slice(i, nl < 0 ? input.length : nl);
      if (line.trim() && TABLE_RULE.test(line)) {
        i += line.length;
        continue;
      }
      const h = HEADING.exec(line);
      if (h) {
        i += h[0].length;
        continue;
      }
    }
    const c = input[i]!;
    if (c === '\n') {
      space(i, i + 1);
      lineStart = true;
      i++;
    } else if (c === '-' && i > 0 && LETTER.test(input[i - 1]!) && LINE_END_HYPHEN.test(input.slice(i, i + 12))) {
      i += LINE_END_HYPHEN.exec(input.slice(i, i + 12))![0].length;
    } else if (SPACE.test(c) || c === '|') {
      space(i, i + 1);
      i++;
    } else if (c === '­') {
      i++;
    } else if (c === '_' || c === '.' || c === '*') {
      let j = i;
      while (input[j] === c) j++;
      const n = j - i;
      if (c !== '*' && n >= 3) {
        space(i, i);
        emit(BLANK, i, j);
        emit(' ', j, j);
      } else if (c === '_' && n === 2) {
        // markdown emphasis
      } else if (c === '*' && n >= 2) {
        // markdown emphasis
      } else {
        emit(input.slice(i, j), i, j);
      }
      i = j;
    } else {
      emit(CHAR_MAP[c] ?? c, i, i + 1);
      i++;
    }
  }
  while (out.length && out[out.length - 1] === ' ') {
    out.pop();
    from.pop();
    to.pop();
  }
  return { text: out.join(''), from, to };
}

interface Token {
  text: string;
  start: number; // offsets into the normalised text
  end: number;
}

function tokenise(s: string): Token[] {
  const tokens: Token[] = [];
  const re = /[^ ]+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) tokens.push({ text: m[0], start: m.index, end: m.index + m[0].length });
  return tokens;
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, k) => k);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length]!;
}

/** 1 = identical, 0 = nothing in common. */
export function levenshteinRatio(a: string, b: string): number {
  const len = Math.max(a.length, b.length);
  return len === 0 ? 1 : 1 - levenshtein(a, b) / len;
}

/**
 * Token-level Levenshtein alignment of the quote against every stretch of the page at once (free start and
 * end on the page). A missing or extra token costs 1; a changed token costs 1 − its character similarity,
 * so an OCR slip inside a word costs little. Score = 1 − cost / max(quote tokens, page tokens used).
 */
function fuzzyFind(q: Token[], t: Token[]): { score: number; first: number; last: number } | null {
  const m = q.length;
  const n = t.length;
  if (!m || !n) return null;
  const cache = new Map<string, number>();
  const sub = (a: string, b: string) => {
    if (a === b) return 0;
    if (/\d/.test(a) || /\d/.test(b)) return 1; // a changed number is never a small slip
    const key = a + '\u0000' + b;
    let v = cache.get(key);
    if (v === undefined) {
      v = 1 - levenshteinRatio(a, b);
      cache.set(key, v);
    }
    return v;
  };
  // Row j: cost of aligning the first j quote tokens ending at page position i, and where that stretch starts.
  let cost = new Float64Array(n + 1);
  let start = Int32Array.from({ length: n + 1 }, (_, i) => i);
  for (let j = 1; j <= m; j++) {
    const nextCost = new Float64Array(n + 1);
    const nextStart = new Int32Array(n + 1);
    nextCost[0] = j;
    nextStart[0] = 0;
    for (let i = 1; i <= n; i++) {
      const diag = cost[i - 1]! + sub(q[j - 1]!.text, t[i - 1]!.text);
      const up = cost[i]! + 1; // quote token missing from the page
      const left = nextCost[i - 1]! + 1; // extra page token
      if (diag <= up && diag <= left) {
        nextCost[i] = diag;
        nextStart[i] = start[i - 1]!;
      } else if (up <= left) {
        nextCost[i] = up;
        nextStart[i] = start[i]!;
      } else {
        nextCost[i] = left;
        nextStart[i] = nextStart[i - 1]!;
      }
    }
    cost = nextCost;
    start = nextStart;
  }
  let best: { score: number; first: number; last: number } | null = null;
  for (let i = 1; i <= n; i++) {
    const s = start[i]!;
    if (s >= i) continue;
    const score = 1 - cost[i]! / Math.max(m, i - s);
    if (!best || score > best.score) best = { score, first: s, last: i - 1 };
  }
  return best;
}

/**
 * Merge word boxes into one box per visual line: same line when centres are within half a line-height.
 * Tilted words (a stamp, a rotated label) are not merged: a rectangle round them would not follow them. They are
 * returned as they are, after the merged lines; a tilt under 3 degrees counts as upright.
 */
export function lineBoxes(boxes: Box[]): Box[] {
  const tilted = boxes.filter(isTilted);
  const flat = boxes.filter((b) => !isTilted(b)).map(({ x, y, w, h }) => ({ x, y, w, h }));
  const lines: Box[][] = [];
  for (const b of flat.sort((a, c) => a.y + a.h / 2 - (c.y + c.h / 2) || a.x - c.x)) {
    const line = lines[lines.length - 1];
    const ref = line?.[0];
    if (ref && Math.abs(b.y + b.h / 2 - (ref.y + ref.h / 2)) <= Math.min(ref.h, b.h) / 2) line!.push(b);
    else lines.push([b]);
  }
  return [
    ...lines.map((line) => {
      const x = Math.min(...line.map((b) => b.x));
      const y = Math.min(...line.map((b) => b.y));
      return { x, y, w: Math.max(...line.map((b) => b.x + b.w)) - x, h: Math.max(...line.map((b) => b.y + b.h)) - y };
    }),
    ...tilted.sort((a, c) => a.y + a.h / 2 - (c.y + c.h / 2) || a.x - c.x),
  ];
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/** A place a quote matched, as offsets into the normalised page text. */
interface Hit {
  normStart: number;
  normEnd: number;
  score: number;
  exact: boolean;
}

const stripPunct = (s: string) => s.replace(/[^\p{L}\p{N}]/gu, '');

/**
 * Every exact occurrence of the normalised quote in the normalised page; failing that, the one best fuzzy
 * alignment at or above minScore. `best` is the best score seen, for reporting a near miss.
 */
function locate(q: string, p: Normalised, minScore: number, ignore: Set<string>): { hits: Hit[]; best: number } {
  const hits: Hit[] = [];
  for (let at = p.text.indexOf(q); at >= 0; at = p.text.indexOf(q, at + 1)) hits.push({ normStart: at, normEnd: at + q.length, score: 1, exact: true });
  if (hits.length) return { hits, best: 1 };

  const qTokens = tokenise(q);
  let pageTokens = tokenise(p.text);
  if (ignore.size) {
    // Skip a stray watermark word on the page, unless the quote itself has that word.
    const inQuote = new Set(qTokens.map((t) => stripPunct(t.text)));
    pageTokens = pageTokens.filter((t) => {
      const w = stripPunct(t.text);
      return !(ignore.has(w) && !inQuote.has(w));
    });
  }
  const found = fuzzyFind(qTokens, pageTokens);
  if (!found || found.score < minScore) return { hits: [], best: found?.score ?? 0 };
  return { hits: [{ normStart: pageTokens[found.first]!.start, normEnd: pageTokens[found.last]!.end, score: found.score, exact: false }], best: found.score };
}

const normalisedIgnore = (o?: GroundOptions) => new Set((o?.ignoreTokens ?? []).map((t) => stripPunct(t.toLowerCase())).filter(Boolean));

/** Part of a quote's text with fewer boxes than this share of its words is not highlighted at all. */
const MIN_COVERAGE = 0.6;
/** A word farther than this many word-heights from every other word of the quote is taken to be mis-placed. */
const OUTLIER_HEIGHTS = 4;

interface Positioned {
  boxes: Box[];
  /** Words left out of the boxes because their position looked wrong. */
  trimmed: number;
  /** The text is there but too few of its words have positions to draw a highlight. */
  unpositioned: boolean;
}

/**
 * One page's words that fall in [start, end) of its text, as line boxes. Parsers are sometimes wrong about positions,
 * and a highlight in the wrong place is worse than none:
 *   - if under 60% of the words have a position (LlamaParse gives none for the second column of a paragraph that
 *     runs across columns), nothing is drawn and the part is marked unpositioned;
 *   - a word far from all the others (a stamp confuses the parser into placing one word 80 pt away) is left out.
 */
function positioned(page: ParsedPage, start: number, end: number): Positioned {
  const words = page.words.filter((w) => w.start < end && w.end > start);
  const tokens = (page.text.slice(start, end).match(/[^\s*#|_]*[\p{L}\p{N}][^\s*#|_]*/gu) ?? []).length;
  if (tokens >= 3 && words.length / tokens < MIN_COVERAGE) return { boxes: [], trimmed: 0, unpositioned: true };
  if (!words.length) return { boxes: [], trimmed: 0, unpositioned: tokens > 0 };

  let kept = words;
  if (words.length >= 4) {
    const mid = (w: (typeof words)[number]) => w.box.y + w.box.h / 2;
    const heights = words.map((w) => w.box.h).sort((a, b) => a - b);
    const limit = OUTLIER_HEIGHTS * heights[Math.floor(heights.length / 2)]!;
    kept = words.filter((w) => words.some((o) => o !== w && Math.abs(mid(o) - mid(w)) <= limit));
    if (kept.length < 3) kept = words; // nothing sensible to keep: don't guess
  }
  return { boxes: lineBoxes(kept.map((w) => w.box)), trimmed: words.length - kept.length, unpositioned: false };
}

function groundedOn(page: ParsedPage, p: Normalised, hit: Hit, count: number): GroundingResult {
  const start = p.from[hit.normStart]!;
  const end = p.to[hit.normEnd - 1]!;
  const { boxes, trimmed, unpositioned } = positioned(page, start, end);
  return {
    status: 'grounded',
    score: round3(hit.exact && count > 1 ? 0.99 : hit.score),
    page: page.page,
    start,
    end,
    boxes,
    fractions: boxes.map((b) => toFraction(b, page)),
    match: hit.exact ? 'exact' : 'fuzzy',
    ...(trimmed ? { trimmed } : {}),
    ...(unpositioned ? { unpositioned: true } : {}),
  };
}

/**
 * Finds a quote on one page. The first place it matches is taken; the score is 0.99 when an exact quote
 * occurs more than once. Use groundInDocument to look further and to refuse a repeated quote.
 */
export function ground(quote: string, page: ParsedPage, minScore: number, options?: GroundOptions): GroundingResult {
  const notFound = (score = 0): GroundingResult => ({ status: 'not_found', score: round3(score), page: page.page, boxes: [] });
  const q = normalise(quote).text;
  if (!q.trim()) return notFound();
  const p = normalise(page.text);
  const { hits, best } = locate(q, p, minScore, normalisedIgnore(options));
  if (!hits.length) return notFound(best);
  return groundedOn(page, p, hits[0]!, hits.length);
}

/** A quote that starts at the end of page a and carries on at the start of the page after it. */
function acrossBreak(q: string, a: ParsedPage, b: ParsedPage, minScore: number, ignore: Set<string>): GroundingResult | null {
  const offset = a.text.length + 1;
  const joined: ParsedPage = {
    page: a.page,
    width: a.width,
    height: a.height,
    text: `${a.text}\n${b.text}`,
    words: [...a.words, ...b.words.map((w) => ({ ...w, start: w.start + offset, end: w.end + offset }))],
  };
  const p = normalise(joined.text);
  const { hits } = locate(q, p, minScore, ignore);
  const crossing = hits.filter((h) => p.from[h.normStart]! < a.text.length && p.to[h.normEnd - 1]! > offset);
  if (crossing.length !== 1) return null;
  const hit = crossing[0]!;
  const start = p.from[hit.normStart]!;
  const end = p.to[hit.normEnd - 1]! - offset;
  const pa = positioned(a, start, a.text.length);
  const pb = positioned(b, 0, end);
  const first = pa.boxes;
  const second = pb.boxes;
  const trimmed = pa.trimmed + pb.trimmed;
  return {
    status: 'grounded',
    score: round3(hit.score),
    page: a.page,
    start,
    end: a.text.length,
    boxes: first,
    fractions: first.map((x) => toFraction(x, a)),
    match: hit.exact ? 'exact' : 'fuzzy',
    more: [{ page: b.page, start: 0, end, boxes: second, fractions: second.map((x) => toFraction(x, b)) }],
    ...(trimmed ? { trimmed } : {}),
    ...(pa.unpositioned && pb.unpositioned ? { unpositioned: true } : {}),
  };
}

/**
 * Finds a quote in a document, starting where the extractor said it was.
 *   1. On the claimed page. Once: found. More than once: ambiguous, nothing is taken.
 *   2. Running across the break between the claimed page and the one before or after it.
 *   3. On any other page. Found only if it is in exactly one place in the whole document; the page it is really
 *      on is reported, with the page that was claimed kept in claimedPage.
 * Anything else is not found. A page the parser could not read has no text, so a quote claimed on it is not found.
 */
export function groundInDocument(quote: string, pages: ParsedPage[], claimedPage: number, minScore: number, options?: GroundOptions): GroundingResult {
  const notFound = (score = 0, note?: string): GroundingResult => ({ status: 'not_found', score: round3(score), page: claimedPage, boxes: [], ...(note ? { note } : {}) });
  const q = normalise(quote).text;
  if (!q.trim()) return notFound();
  const ignore = normalisedIgnore(options);
  const readable = pages.filter((p) => p.positionsOk !== false);
  const claimed = pages.find((p) => p.page === claimedPage);
  if (claimed && claimed.positionsOk === false) return notFound(0, 'page could not be read for positions');

  const norms = new Map<ParsedPage, Normalised>();
  const norm = (p: ParsedPage) => norms.get(p) ?? (norms.set(p, normalise(p.text)), norms.get(p)!);
  const withClaim = (r: GroundingResult): GroundingResult => (r.page === claimedPage ? r : { ...r, claimedPage });
  let best = 0;

  // 1. The claimed page.
  if (claimed) {
    const { hits, best: b } = locate(q, norm(claimed), minScore, ignore);
    best = b;
    if (hits.length > 1) return { status: 'ambiguous', score: 1, page: claimedPage, boxes: [], pages: [claimedPage] };
    if (hits.length === 1) return groundedOn(claimed, norm(claimed), hits[0]!, 1);
  }

  // 2. Across a page break next to the claimed page.
  const byNumber = (n: number) => readable.find((p) => p.page === n);
  for (const [a, b] of [[claimedPage - 1, claimedPage], [claimedPage, claimedPage + 1]] as const) {
    const pa = byNumber(a);
    const pb = byNumber(b);
    const r = pa && pb ? acrossBreak(q, pa, pb, minScore, ignore) : null;
    if (r) return withClaim(r);
  }

  // 3. Any other page: only if it is in one place in the whole document.
  const elsewhere: { page: ParsedPage; hit: Hit; count: number }[] = [];
  for (const p of readable) {
    if (p.page === claimedPage) continue;
    const { hits, best: b } = locate(q, norm(p), minScore, ignore);
    best = Math.max(best, b);
    for (const hit of hits) elsewhere.push({ page: p, hit, count: hits.length });
  }
  const pagesHit = [...new Set(elsewhere.map((e) => e.page.page))];
  if (elsewhere.length > 1) return { status: 'ambiguous', score: 1, page: claimedPage, boxes: [], pages: pagesHit };
  if (elsewhere.length === 1) {
    const e = elsewhere[0]!;
    return withClaim(groundedOn(e.page, norm(e.page), e.hit, 1));
  }

  // A quote across a page break away from the claimed page.
  const crossings: GroundingResult[] = [];
  for (let i = 0; i + 1 < readable.length; i++) {
    const a = readable[i]!;
    const b = readable[i + 1]!;
    if (b.page !== a.page + 1 || [a.page, b.page].includes(claimedPage)) continue;
    const r = acrossBreak(q, a, b, minScore, ignore);
    if (r) crossings.push(r);
  }
  if (crossings.length > 1) return { status: 'ambiguous', score: 1, page: claimedPage, boxes: [], pages: crossings.map((c) => c.page) };
  if (crossings.length === 1) return withClaim(crossings[0]!);

  return notFound(best);
}
