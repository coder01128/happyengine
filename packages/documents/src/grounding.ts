// The quote check: find an extracted quote on the page it was cited from, and return the boxes of the
// words it covers. A quote that isn't found on its page is "not verified" — never searched for elsewhere.

import type { Box, ParsedPage } from './types.ts';

export interface GroundingResult {
  status: 'grounded' | 'not_found';
  /** 1 = exact, 0.99 = exact but the text occurs more than once (first taken), below that = fuzzy. */
  score: number;
  page: number;
  /** Offsets into page.text. */
  start?: number;
  end?: number;
  /** One box per visual line. */
  boxes: Box[];
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

/** Merge word boxes into one box per visual line: same line when centres are within half a line-height. */
export function lineBoxes(boxes: Box[]): Box[] {
  const lines: Box[][] = [];
  for (const b of [...boxes].sort((a, c) => a.y + a.h / 2 - (c.y + c.h / 2) || a.x - c.x)) {
    const line = lines[lines.length - 1];
    const ref = line?.[0];
    if (ref && Math.abs(b.y + b.h / 2 - (ref.y + ref.h / 2)) <= Math.min(ref.h, b.h) / 2) line!.push(b);
    else lines.push([b]);
  }
  return lines.map((line) => {
    const x = Math.min(...line.map((b) => b.x));
    const y = Math.min(...line.map((b) => b.y));
    return { x, y, w: Math.max(...line.map((b) => b.x + b.w)) - x, h: Math.max(...line.map((b) => b.y + b.h)) - y };
  });
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

export function ground(quote: string, page: ParsedPage, minScore: number): GroundingResult {
  const notFound = (score = 0): GroundingResult => ({ status: 'not_found', score: round3(score), page: page.page, boxes: [] });
  const q = normalise(quote).text;
  if (!q.trim()) return notFound();
  const p = normalise(page.text);

  let normStart: number;
  let normEnd: number;
  let score: number;
  const at = p.text.indexOf(q);
  if (at >= 0) {
    normStart = at;
    normEnd = at + q.length;
    score = p.text.indexOf(q, at + 1) >= 0 ? 0.99 : 1;
  } else {
    const pageTokens = tokenise(p.text);
    const found = fuzzyFind(tokenise(q), pageTokens);
    if (!found || found.score < minScore) return notFound(found?.score);
    normStart = pageTokens[found.first]!.start;
    normEnd = pageTokens[found.last]!.end;
    score = found.score;
  }

  const start = p.from[normStart]!;
  const end = p.to[normEnd - 1]!;
  const words = page.words.filter((w) => w.start < end && w.end > start);
  return { status: 'grounded', score: round3(score), page: page.page, start, end, boxes: lineBoxes(words.map((w) => w.box)) };
}
