// The fee as lines: one amount for one charge, optionally from a date. A rent that steps up by year is a line per year;
// a parking charge is a line of its own. Code merges the lines an extractor gave and calculates the current fee as at
// a date. The extractor never chooses between them. Pure: no database, no network.

import type { IsoDate } from '../../core/src/index.ts';
import type { CandidateValue, Fee, FeeLine } from './types.ts';

const clean = (s: string | undefined) => (s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

/** A fee line: an amount with a unit. Words ({ text }) and merged records ({ lines }) are not lines. */
export function isFeeLine(v: unknown): v is FeeLine {
  const o = v as Partial<FeeLine> | null;
  return typeof v === 'object' && v !== null && typeof o!.cents === 'number' && typeof o!.per === 'string';
}

/** The lines of a fee value: the lines of a merged record, or the one line of a single amount. Words have none. */
export function feeLinesOf(v: CandidateValue | undefined): FeeLine[] {
  if (typeof v !== 'object' || v === null) return [];
  const f = v as Fee;
  if ('lines' in f) return f.lines;
  return isFeeLine(f) ? [f] : [];
}

const sameAmount = (a: FeeLine, b: FeeLine) => a.cents === b.cents && clean(a.per) === clean(b.per) && (a.vat ?? '') === (b.vat ?? '');

export interface MergedLine { line: FeeLine; /** Index of the candidate the line came from, in the order given. */ index: number }
export type MergedFee =
  /** Every line carries a charge name and none disagrees with another. */
  | { kind: 'lines'; lines: MergedLine[] }
  /** Two lines for the same charge and the same start give different amounts. */
  | { kind: 'conflict' }
  /** Something isn't a labelled line (words, or no `what`): the generic rules decide. */
  | { kind: 'not_lines' };

/**
 * Merges the lines from every supported candidate. Lines with different `what` are separate charges and never replace
 * each other. Within a charge, lines with different `from` dates are steps. Only the same charge from the same date
 * (or both undated) with different amounts is a conflict, and so is an undated amount that matches none of the dated
 * steps. A line with no `what` can't be told from another charge, so it is left to the generic rules.
 */
export function mergeFee(values: CandidateValue[]): MergedFee {
  const lines: { line: FeeLine; index: number }[] = [];
  for (const [index, v] of values.entries()) {
    if (!isFeeLine(v) || !clean(v.what)) return { kind: 'not_lines' };
    lines.push({ line: v, index });
  }
  const groups = new Map<string, { line: FeeLine; index: number }[]>();
  for (const l of lines) {
    const k = clean(l.line.what);
    groups.set(k, [...(groups.get(k) ?? []), l]);
  }

  const out: MergedLine[] = [];
  for (const entries of groups.values()) {
    const dated: MergedLine[] = [];
    for (const e of entries.filter((x) => x.line.from)) {
      const same = dated.find((d) => d.line.from === e.line.from);
      if (!same) dated.push(e);
      else if (!sameAmount(same.line, e.line)) return { kind: 'conflict' };
    }
    const undated: MergedLine[] = [];
    for (const e of entries.filter((x) => !x.line.from)) {
      if (dated.length) {
        if (!dated.some((d) => sameAmount(d.line, e.line))) return { kind: 'conflict' };
      } else if (!undated.length) undated.push(e);
      else if (!sameAmount(undated[0]!.line, e.line)) return { kind: 'conflict' };
    }
    dated.sort((a, b) => (a.line.from! < b.line.from! ? -1 : 1));
    out.push(...undated, ...dated);
  }
  return { kind: 'lines', lines: out };
}

/** The value a record holds for merged lines: the line itself when there is one, `{ lines }` when there are several. */
export const feeValueOf = (lines: FeeLine[]): Fee => (lines.length === 1 ? lines[0]! : { lines });

/** One charge as at a date: the latest step that has started; when none has yet, the first step, marked not started. */
export interface CurrentFee { line: FeeLine; started: boolean }

export function currentFee(v: CandidateValue | undefined, asAt: IsoDate): CurrentFee[] {
  const groups = new Map<string, FeeLine[]>();
  const ordered: string[] = [];
  for (const [n, l] of feeLinesOf(v).entries()) {
    const k = clean(l.what) || `#${n}`;
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
  for (const m of lines) if (m.line.from) byCharge.set(clean(m.line.what), [...(byCharge.get(clean(m.line.what)) ?? []), m]);
  const stepped = [...byCharge.values()].filter((g) => g.length >= 2);
  if (stepped.length !== 1) return undefined;
  return { steps: stepped[0]!.map((m) => m.line.cents), indexes: stepped[0]!.map((m) => m.index) };
}
