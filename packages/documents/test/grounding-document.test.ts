// The matcher across a whole document (handoff 7.2). Each `describe` is one numbered case; each row is one input.
import { describe, expect, it } from 'vitest';
import { groundInDocument, type ParsedPage, type Word } from '../src/index.ts';

/** A page whose word boxes follow a simple grid: 6 units per character, 20 per line, 12 high. */
function pageOf(text: string, page = 1, extra: Partial<ParsedPage> = {}): ParsedPage {
  const words: Word[] = [];
  let lineStart = 0;
  text.split('\n').forEach((line, n) => {
    for (const m of line.matchAll(/\S+/g)) {
      words.push({ text: m[0], start: lineStart + m.index, end: lineStart + m.index + m[0].length, box: { x: m.index * 6, y: n * 20, w: m[0].length * 6, h: 12 } });
    }
    lineStart += line.length + 1;
  });
  return { page, width: 600, height: 800, text, words, ...extra };
}
const doc = (...texts: string[]) => texts.map((t, i) => pageOf(t, i + 1));
const MIN = 0.9;

describe('case 1: exact match', () => {
  const pages = doc('1.1 Parties.\n2.1 The Lease Period commences on the Commencement Date and ends on 31 January 2027.\n2.2 Rent.');
  it.each([
    ['a whole sentence', 'The Lease Period commences on the Commencement Date and ends on 31 January 2027.'],
    ['a part of a sentence', 'ends on 31 January 2027'],
    ['different case and spacing', 'the LEASE  period commences on the  commencement date'],
  ])('finds %s, on the claimed page, as exact', (_name, quote) => {
    const r = groundInDocument(quote, pages, 1, MIN);
    expect(r).toMatchObject({ status: 'grounded', match: 'exact', score: 1, page: 1 });
    expect(r.claimedPage).toBeUndefined();
    expect(r.boxes.length).toBeGreaterThan(0);
  });
  it('gives page fractions of the boxes: 0–1 of the page', () => {
    const r = groundInDocument('ends on 31 January 2027', pages, 1, MIN);
    expect(r.fractions).toHaveLength(r.boxes.length);
    for (const [i, b] of r.boxes.entries()) expect(r.fractions![i]).toEqual({ x: b.x / 600, y: b.y / 800, w: b.w / 600, h: b.h / 800 });
  });
});

describe('case 2: curly quotes versus straight', () => {
  const pages = doc('The “Premises” means Unit 4 – Oakridge Business Park; the tenant’s address is ‘as stated’.');
  it.each([
    ['straight double quotes and a hyphen for the dashes', 'The "Premises" means Unit 4 - Oakridge Business Park'],
    ['a straight apostrophe', "the tenant's address is 'as stated'"],
    ['an em dash for the en dash', 'Unit 4 — Oakridge'],
  ])('matches %s as exact', (_name, quote) => {
    expect(groundInDocument(quote, pages, 1, MIN)).toMatchObject({ status: 'grounded', match: 'exact', score: 1 });
  });
  it('and the other way round', () => {
    const straight = doc('The "Premises" means Unit 4 - Oakridge Business Park.');
    expect(groundInDocument('The “Premises” means Unit 4 – Oakridge', straight, 1, MIN)).toMatchObject({ status: 'grounded', match: 'exact' });
  });
});

describe('case 3: hyphenation at a line break', () => {
  it.each([
    ['a word split by a hyphen', 'three months before the termi-\nnation date of this lease', 'three months before the termination date'],
    ['two split words', 'the Land-\nlord shall give not-\nice in writing', 'the Landlord shall give notice in writing'],
    ['a real hyphen kept as it is', 'a month-to-month tenancy\ncontinues after expiry', 'a month-to-month tenancy continues'],
  ])('%s', (_name, text, quote) => {
    const r = groundInDocument(quote, doc(text), 1, MIN);
    expect(r).toMatchObject({ status: 'grounded', match: 'exact', score: 1 });
    expect(r.boxes.length).toBeGreaterThanOrEqual(1);
  });
  it('gives one box per line', () => {
    expect(groundInDocument('before the termination date', doc('three months before the termi-\nnation date of this lease'), 1, MIN).boxes).toHaveLength(2);
  });
});

describe('case 4: a watermark word inserted mid-quote', () => {
  const ignore = ['sample', 'copy', 'draft'];
  it.each([
    ['one SAMPLE in a long quote', 'The Tenant shall pay the Rent monthly SAMPLE in advance on the first Business Day of each month', 'The Tenant shall pay the Rent monthly in advance on the first Business Day of each month'],
    ['one SAMPLE in a short quote (8 words)', 'Either party may cancel on SAMPLE sixty days notice', 'Either party may cancel on sixty days notice'],
    ['a COPY on each of two lines', 'The Landlord shall COPY\nreturn the deposit within COPY\nfourteen days of vacation', 'The Landlord shall return the deposit within fourteen days'],
  ])('finds %s', (_name, text, quote) => {
    const r = groundInDocument(quote, doc(text), 1, MIN, { ignoreTokens: ignore });
    expect(r.status).toBe('grounded');
    expect(r.match).toBe('fuzzy');
    expect(r.score).toBe(1);
  });
  it('without the ignore list, a short quote falls below the threshold (why the list exists)', () => {
    const r = groundInDocument('Either party may cancel on sixty days notice', doc('Either party may cancel on SAMPLE sixty days notice'), 1, MIN);
    expect(r.status).toBe('not_found');
    expect(r.score).toBeGreaterThan(0.8);
  });
  it('a watermark word that the quote itself contains is not ignored', () => {
    const r = groundInDocument('This is a draft agreement between the parties', doc('This is a draft agreement between the parties'), 1, MIN, { ignoreTokens: ignore });
    expect(r).toMatchObject({ status: 'grounded', match: 'exact' });
    const other = groundInDocument('This is a draft agreement between the parties', doc('This is a agreement between the parties'), 1, MIN, { ignoreTokens: ignore });
    expect(other.status).toBe('not_found'); // the quote needs "draft"; the page doesn't have it
  });
  it('a listed word that the quote contains is matched like any other word', () => {
    const r = groundInDocument('keep a copy of this lease', doc('keep a copy of this lease'), 1, MIN, { ignoreTokens: ignore });
    expect(r).toMatchObject({ status: 'grounded', match: 'exact' });
  });
});

describe('case 5: a quote split across two pages', () => {
  const pages = doc(
    'Renewal\n5.1 The Tenant shall exercise the option by written notice',
    'to the Landlord given not less than three months before expiry.\n5.2 Rent.',
    'Schedule 1',
  );
  const quote = 'exercise the option by written notice to the Landlord given not less than three months';
  it('is found where it starts, with the rest of it on the next page', () => {
    const r = groundInDocument(quote, pages, 1, MIN);
    expect(r).toMatchObject({ status: 'grounded', match: 'exact', page: 1 });
    expect(r.boxes).toHaveLength(1); // the part on page 1
    expect(r.more).toHaveLength(1);
    expect(r.more![0]).toMatchObject({ page: 2 });
    expect(r.more![0]!.boxes).toHaveLength(1);
    expect(r.more![0]!.fractions).toHaveLength(1);
  });
  it('is found when the claimed page is the second one', () => {
    expect(groundInDocument(quote, pages, 2, MIN)).toMatchObject({ status: 'grounded', page: 1, claimedPage: 2 });
  });
  it('a quote that only looks split, because its two halves are on pages far apart, is not found', () => {
    const far = doc('The Tenant shall exercise the option by written notice', 'Rent', 'to the Landlord given not less than three months before expiry.');
    expect(groundInDocument(quote, far, 1, MIN).status).toBe('not_found');
  });
});

describe('case 6: a quote on the wrong claimed page', () => {
  const pages = doc('Parties and definitions', 'Schedule of rent', '9.1 The notice period is not less than thirty days written notice before expiry.');
  const quote = 'The notice period is not less than thirty days written notice';
  it.each([[1], [2], [40]])('finds it on page 3 when page %i was claimed, and keeps what was claimed', (claimed) => {
    expect(groundInDocument(quote, pages, claimed, MIN)).toMatchObject({ status: 'grounded', match: 'exact', page: 3, claimedPage: claimed });
  });
  it('says nothing about a claimed page that was right', () => {
    const r = groundInDocument(quote, pages, 3, MIN);
    expect(r).toMatchObject({ status: 'grounded', page: 3 });
    expect(r.claimedPage).toBeUndefined();
  });
  it('a fuzzy find on another page is reported as fuzzy', () => {
    const r = groundInDocument('The notice period is not less than thirty days written notise before expiry', pages, 2, MIN);
    expect(r).toMatchObject({ status: 'grounded', match: 'fuzzy', page: 3, claimedPage: 2 });
    expect(r.score).toBeLessThan(1);
  });
  it('a quote that is on no page is still not found', () => {
    expect(groundInDocument('The Landlord may increase the rent at any time', pages, 2, MIN).status).toBe('not_found');
  });
});

describe('case 7: a repeated quote', () => {
  it('twice on the claimed page: ambiguous, nothing is guessed', () => {
    const r = groundInDocument('excluding VAT', doc('The Rent excluding VAT is payable. The Deposit excluding VAT is refundable.'), 1, MIN);
    expect(r).toMatchObject({ status: 'ambiguous', boxes: [] });
    expect(r.pages).toEqual([1]);
  });
  it('on two other pages when the claimed page has none: ambiguous, listing the pages', () => {
    const pages = doc('Cover', 'Fees apply per the schedule below.', 'Cover again', 'Fees apply per the schedule below.');
    const r = groundInDocument('Fees apply per the schedule below', pages, 1, MIN);
    expect(r).toMatchObject({ status: 'ambiguous' });
    expect(r.pages).toEqual([2, 4]);
  });
  it('once on the claimed page and again on another page: the claimed page wins', () => {
    const pages = doc('Fees apply per the schedule below.', 'Fees apply per the schedule below.');
    expect(groundInDocument('Fees apply per the schedule below', pages, 1, MIN)).toMatchObject({ status: 'grounded', page: 1, match: 'exact' });
  });
  it('firstOfMany takes the first place instead (for a title or a scope, where any place will do), scored 0.99 as repeated', () => {
    const twice = groundInDocument('excluding VAT', doc('The Rent excluding VAT is payable. The Deposit excluding VAT is refundable.'), 1, MIN, { firstOfMany: true });
    expect(twice).toMatchObject({ status: 'grounded', page: 1, match: 'exact', score: 0.99 });
    expect(twice.start).toBe(9);
    const pages = doc('Cover', 'Fees apply per the schedule below.', 'Cover again', 'Fees apply per the schedule below.');
    expect(groundInDocument('Fees apply per the schedule below', pages, 1, MIN, { firstOfMany: true })).toMatchObject({ status: 'grounded', page: 2, claimedPage: 1, score: 0.99 });
  });
  it('firstOfMany still says not found for a quote that is nowhere', () => {
    expect(groundInDocument('No such wording anywhere in this document', doc('Cover', 'Other text'), 1, MIN, { firstOfMany: true }).status).toBe('not_found');
  });
  it('a word repeated in a longer, unique quote is not ambiguous', () => {
    expect(groundInDocument('The Rent excluding VAT is payable', doc('The Rent excluding VAT is payable. The Deposit excluding VAT is refundable.'), 1, MIN).status).toBe('grounded');
  });
});

describe('case 8: a paraphrased quote', () => {
  const pages = doc('4.1 The Tenant shall pay the Rent monthly in advance on the first Business Day of each month.', '9.2 Either party may cancel on not less than sixty days written notice.');
  it.each([
    ['reworded', 'Rent must be paid at the start of every month by the Tenant'],
    ['summarised', 'The tenant pays rent monthly and in advance'],
    ['reordered clauses', 'sixty days written notice may be given by either party to cancel'],
  ])('%s is not found', (_name, quote) => {
    const r = groundInDocument(quote, pages, 1, MIN);
    expect(r.status).toBe('not_found');
    expect(r.boxes).toEqual([]);
  });
  it('one changed number in a long quote still aligns, but scores below 1: the value check on the matched page text is what catches it', () => {
    const r = groundInDocument('Either party may cancel on not less than 90 days written notice', doc('9.2 Either party may cancel on not less than 60 days written notice.'), 1, MIN);
    expect(r).toMatchObject({ status: 'grounded', match: 'fuzzy' });
    expect(r.score).toBeLessThan(0.95);
    expect(r.score).toBeGreaterThanOrEqual(0.9);
  });
  it('an empty quote is never found', () => expect(groundInDocument('   ', pages, 1, MIN).status).toBe('not_found'));
});

describe('unreadable pages', () => {
  it('a quote claimed on a page the parser could not read is not found, with the reason', () => {
    const pages = [pageOf('Cover', 1), pageOf('', 2, { positionsOk: false, positionsError: 'render failed', words: [] }), pageOf('The fee is R4 850.00 per month.', 3)];
    const r = groundInDocument('The fee is R4 850.00 per month', pages, 2, MIN);
    expect(r).toMatchObject({ status: 'not_found', page: 2, note: 'page could not be read for positions' });
  });
  it('an unreadable page is skipped when searching other pages', () => {
    const pages = [pageOf('The fee is R4 850.00 per month.', 1), pageOf('', 2, { positionsOk: false, positionsError: 'x', words: [] })];
    expect(groundInDocument('The fee is R4 850.00 per month', pages, 1, MIN).status).toBe('grounded');
  });
});

// Parsers are sometimes wrong about where words are. A highlight in the wrong place is worse than none.
describe('positions that cannot be trusted', () => {
  /** A one-line page whose word boxes are given as [x, y] per word, 40 wide and 12 high. */
  const line = (text: string, at: ([number, number] | null)[]): ParsedPage => {
    const words: Word[] = [];
    let i = 0;
    for (const m of text.matchAll(/\S+/g)) {
      const pos = at[i++];
      if (pos) words.push({ text: m[0], start: m.index, end: m.index + m[0].length, box: { x: pos[0], y: pos[1], w: 40, h: 12 } });
    }
    return { page: 1, width: 600, height: 800, text, words };
  };
  const QUOTE = 'The Sublessee shall pay a deposit of R37 000.00 on signature';

  it('a quote whose words have no positions is found but not highlighted (marked unpositioned)', () => {
    const page = line(`3.2 ${QUOTE}`, [[10, 10]]); // only the clause number has a box
    const r = groundInDocument(QUOTE, [page], 1, MIN);
    expect(r).toMatchObject({ status: 'grounded', match: 'exact', unpositioned: true, boxes: [] });
    expect(r.fractions).toEqual([]);
  });

  it('a quote with fewer than 60% of its words positioned is not highlighted, with 60% or more it is', () => {
    const at = (n: number) => Array.from({ length: 10 }, (_, i) => (i < n ? ([10 + i * 45, 100] as [number, number]) : null));
    const text = 'one two three four five six seven eight nine ten';
    expect(groundInDocument(text, [line(text, at(5))], 1, MIN)).toMatchObject({ unpositioned: true, boxes: [] });
    const six = groundInDocument(text, [line(text, at(6))], 1, MIN);
    expect(six.unpositioned).toBeUndefined();
    expect(six.boxes).toHaveLength(1);
  });

  it('a word placed far from the rest of its sentence is left out of the highlight, and the count is kept', () => {
    // "deposit" was given a box 82 points above the others, as happened beside a rubber stamp.
    const at: [number, number][] = [[10, 300], [50, 301], [90, 300], [130, 301], [170, 218], [210, 301], [250, 300], [290, 301], [330, 300], [370, 301]];
    const r = groundInDocument(QUOTE, [line(QUOTE, at)], 1, MIN);
    expect(r).toMatchObject({ status: 'grounded', trimmed: 1 });
    expect(r.boxes).toHaveLength(1);
    expect(r.boxes[0]!.y).toBeGreaterThan(290);
    expect(r.boxes[0]!.h).toBeLessThan(30);
  });

  it('does not trim a quote that wraps over several lines, or one that runs from the foot of one column to the top of the next', () => {
    const wrap: [number, number][] = [[10, 100], [50, 100], [90, 100], [130, 100], [170, 100], [10, 114], [50, 114], [90, 114], [130, 114], [170, 114]];
    expect(groundInDocument(QUOTE, [line(QUOTE, wrap)], 1, MIN).trimmed).toBeUndefined();
    const columns: [number, number][] = [[10, 362], [50, 362], [90, 362], [130, 362], [309, 118], [349, 118], [389, 118], [429, 118], [469, 118], [509, 118]];
    const r = groundInDocument(QUOTE, [line(QUOTE, columns)], 1, MIN);
    expect(r.trimmed).toBeUndefined();
    expect(r.boxes).toHaveLength(2);
  });

  it('a quote of fewer than four positioned words is never trimmed (nothing to compare against)', () => {
    const text = 'deposit of R37';
    const r = groundInDocument(text, [line(text, [[10, 300], [50, 218], [90, 300]])], 1, MIN);
    expect(r.trimmed).toBeUndefined();
    expect(r.boxes.length).toBeGreaterThan(0);
  });
});

describe('tilted words', () => {
  const words = (rs: (number | undefined)[]): ParsedPage => {
    const text = 'The Sublessee shall pay a deposit of R37 000.00';
    const ws: Word[] = [];
    let i = 0;
    for (const m of text.matchAll(/\S+/g)) ws.push({ text: m[0], start: m.index, end: m.index + m[0].length, box: { x: 10 + i * 45, y: 300, w: 40, h: 12, ...(rs[i] ? { r: rs[i] } : {}) } }), i++;
    return { page: 1, width: 600, height: 800, text, words: ws };
  };
  const QUOTE = 'The Sublessee shall pay a deposit of R37 000.00';

  it('a tilt under 3 degrees (scan skew) counts as upright: the line is merged into one box', () => {
    const r = groundInDocument(QUOTE, [words([1.2, undefined, 0.4, undefined, undefined, 2.9, undefined, undefined, undefined])], 1, MIN);
    expect(r.boxes).toHaveLength(1);
    expect(r.boxes[0]!.r).toBeUndefined();
  });

  it('a few tilted words (a stamp) do not stop the upright words being merged into one line', () => {
    const r = groundInDocument(QUOTE, [words([undefined, undefined, undefined, undefined, 9, 9, undefined, undefined, undefined])], 1, MIN);
    expect(r.boxes).toHaveLength(3); // one merged line of upright words + the two tilted words as they are
    expect(r.boxes.filter((b) => b.r === 9)).toHaveLength(2);
  });
});
