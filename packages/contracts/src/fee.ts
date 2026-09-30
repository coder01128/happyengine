// The fee as lines: one amount for one charge, optionally from a date; a charge stated in words is a text entry.
// A rent that steps up by year is a line per year; a parking charge is a line of its own. Code merges the lines an
// extractor gave and calculates the current fee as at a date. The extractor never chooses between them.
// Pure: no database, no network.

import type { IsoDate } from '../../core/src/index.ts';
import type { CandidateValue, Fee, FeeEntry, FeeLine, FeeText } from './types.ts';

const clean = (s: string | undefined) => (s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

// A bracket that only says which period a line is for: "(year 1)", "(months 13–24)", "(from 1 Feb 2025)", "(2025/26)".
// "(office)" and "(warehouse)" say which charge it is, so they stay.
const PERIOD_WORDS = /^(?:the\s+)?(?:years?|yrs?|months?|mths?|periods?|terms?|from|with effect|w\.?e\.?f\.?|until|till|to|ends?|starting|starts?|after|before|first|second|third|fourth|fifth|initial|renewal|final|last|current|new|previous|prior)\b/;
const PERIOD_DATES = /\b(?:19|20)\d\d\b|\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b|^\d+(?:st|nd|rd|th)?\s*(?:year|yr|month)/;
const isPeriodQualifier = (inner: string) => PERIOD_WORDS.test(inner.trim().toLowerCase()) || PERIOD_DATES.test(inner.trim().toLowerCase());

/** The charge a `what` names: lower case, single spaces, and without bracketed period qualifiers. */
export const chargeName = (what: string | undefined) =>
  clean((what ?? '').replace(/\(([^()]*)\)|\[([^[\]]*)\]/g, (m, a, b) => (isPeriodQualifier(a ?? b ?? '') ? ' ' : m)));

/** A fee line: an amount with a unit. Words ({ text }) and merged records ({ lines }) are not lines. */
export function isFeeLine(v: unknown): v is FeeLine {
  const o = v as Partial<FeeLine> | null;
  return typeof v === 'object' && v !== null && typeof o!.cents === 'number' && typeof o!.per === 'string';
}

/** A charge in words. */
export function isFeeText(v: unknown): v is FeeText {
  return typeof v === 'object' && v !== null && typeof (v as FeeText).text === 'string' && !('lines' in v);
}

/** The entries of a fee value: the entries of a merged record, or the one line (or text) of a single fee. */
export function feeEntriesOf(v: CandidateValue | undefined): FeeEntry[] {
  if (typeof v !== 'object' || v === null) return [];
  const f = v as Fee;
  if ('lines' in f) return f.lines;
  return isFeeLine(f) || isFeeText(f) ? [f] : [];
}

/** Only the amount lines of a fee value (the charges in words are left out). */
export const feeLinesOf = (v: CandidateValue | undefined): FeeLine[] => feeEntriesOf(v).filter(isFeeLine);

const sameAmount = (a: FeeLine, b: FeeLine) => a.cents === b.cents && clean(a.per) === clean(b.per) && (a.vat ?? '') === (b.vat ?? '');

const wordsOf = (t: string) => new Set(clean(t).match(/[\p{L}\p{N}%.]+/gu) ?? []);
/** Two wordings of one charge are the same when every word of the shorter is in the longer. */
function sameWording(a: string, b: string): boolean {
  const x = wordsOf(a);
  const y = wordsOf(b);
  const [small, big] = x.size <= y.size ? [x, y] : [y, x];
  return [...small].every((w) => big.has(w));
}

export interface MergedLine { line: FeeEntry; /** Index of the candidate the entry came from, in the order given. */ index: number }
export type MergedFee =
  /** Every entry carries a charge name and none disagrees with another. */
  | { kind: 'lines'; lines: MergedLine[] }
  /** Two entries for the same charge and the same start give different amounts (or different wording). */
  | { kind: 'conflict' }
  /** Something has no charge name: the generic rules decide. */
  | { kind: 'not_lines' };

/**
 * Merges the entries from every supported candidate. Entries with different `what` are separate charges and never
 * replace each other. Within a charge, lines with different `from` dates are steps. Only the same charge from the
 * same date (or both undated) with different amounts is a conflict, and so is an undated amount that matches none of
 * the dated steps. A charge in words sits beside the amount lines and never conflicts with them; two different
 * wordings of the same charge do. An entry with no `what` can't be told from another charge, so it is left to the
 * generic rules.
 */
export function mergeFee(values: CandidateValue[]): MergedFee {
  const amounts: MergedLine[] = [];
  const words: MergedLine[] = [];
  for (const [index, v] of values.entries()) {
    if (isFeeLine(v) && chargeName(v.what)) amounts.push({ line: v, index });
    else if (isFeeText(v) && chargeName(v.what)) words.push({ line: v, index });
    else return { kind: 'not_lines' };
  }
  const groups = new Map<string, MergedLine[]>();
  for (const l of amounts) {
    const k = chargeName((l.line as FeeLine).what);
    groups.set(k, [...(groups.get(k) ?? []), l]);
  }

  const out: MergedLine[] = [];
  for (const entries of groups.values()) {
    const line = (m: MergedLine) => m.line as FeeLine;
    const dated: MergedLine[] = [];
    for (const e of entries.filter((x) => line(x).from)) {
      const same = dated.find((d) => line(d).from === line(e).from);
      if (!same) dated.push(e);
      else if (!sameAmount(line(same), line(e))) return { kind: 'conflict' };
    }
    const undated: MergedLine[] = [];
    for (const e of entries.filter((x) => !line(x).from)) {
      if (dated.length) {
        if (!dated.some((d) => sameAmount(line(d), line(e)))) return { kind: 'conflict' };
      } else if (!undated.length) undated.push(e);
      else if (!sameAmount(line(undated[0]!), line(e))) return { kind: 'conflict' };
    }
    dated.sort((a, b) => (line(a).from! < line(b).from! ? -1 : 1));
    out.push(...undated, ...dated);
  }

  const kept: MergedLine[] = [];
  for (const w of words) {
    const same = kept.find((k) => chargeName((k.line as FeeText).what) === chargeName((w.line as FeeText).what));
    if (!same) kept.push(w);
    else if (!sameWording((same.line as FeeText).text, (w.line as FeeText).text)) return { kind: 'conflict' };
  }
  return { kind: 'lines', lines: [...out, ...kept] };
}

/** The value a record holds for merged entries: the entry itself when there is one, `{ lines }` when there are several. */
export const feeValueOf = (entries: FeeEntry[]): Fee => (entries.length === 1 ? entries[0]! : { lines: entries });

/** One charge as at a date: the latest step that has started; when none has yet, the first step, marked not started. */
export interface CurrentFee { line: FeeLine; started: boolean }

export function currentFee(v: CandidateValue | undefined, asAt: IsoDate): CurrentFee[] {
  const groups = new Map<string, FeeLine[]>();
  const ordered: string[] = [];
  for (const [n, l] of feeLinesOf(v).entries()) {
    const k = chargeName(l.what) || `#${n}`;
    if (!groups.has(k)) ordered.push(k);
    groups.set(k, [...(groups.get(k) ?? []), l]);
  }
  return ordered.map((k): CurrentFee => {
    const ls = groups.get(k)!;
    const dated = ls.filter((l) => l.from).sort((a, b) => (a.from! < b.from! ? -1 : 1));
    if (!dated.length) return { line: ls[0]!, started: true };
    const begun = dated.filter((l) => l.from! <= asAt);
    return begun.length ? { line: begun[begun.length - 1]!, started: true } : { line: dated[0]!, started: false };
  });
}

/** The steps of the one charge that has two or more dated lines, in date order (cents). Nothing when no charge, or more than one, steps. */
export function scheduleSteps(lines: MergedLine[]): { steps: number[]; indexes: number[] } | undefined {
  const byCharge = new Map<string, MergedLine[]>();
  for (const m of lines) {
    if (!isFeeLine(m.line) || !m.line.from) continue;
    const k = chargeName(m.line.what);
    byCharge.set(k, [...(byCharge.get(k) ?? []), m]);
  }
  const stepped = [...byCharge.values()].filter((g) => g.length >= 2);
  if (stepped.length !== 1) return undefined;
  return { steps: stepped[0]!.map((m) => (m.line as FeeLine).cents), indexes: stepped[0]!.map((m) => m.index) };
}
