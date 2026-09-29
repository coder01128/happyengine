import { daysBetween, dayNumber, type IsoDate } from '../../core/src/index.ts';
import { formatRand, type Cents } from '../../core/src/index.ts';
import type { MonthEndPreset } from './preset.ts';
import { compilePatterns, normaliseRef, referenceKey } from './refs.ts';
import { chooseSplit, mentions, subsetsSummingTo } from './split.ts';
import type { Line } from './types.ts';

export interface MatchedPair {
  bankId: string;
  ledgerId: string;
  /** 1 = same amount, date and reference. 2 = same amount and reference, dates within tolerance. */
  rule: 1 | 2;
}

export type ExceptionType =
  | 'suggested_match'
  | 'suggested_split'
  | 'amount_difference'
  | 'possible_duplicate'
  | 'timing'
  | 'not_in_ledger'
  | 'not_on_statement';

export interface MatchException {
  id: string;
  type: ExceptionType;
  bankId?: string;
  ledgerId?: string;
  /** suggested_split: the cash book entries that together make up the statement line, in file order. */
  ledgerIds?: string[];
  /** possible_duplicate: the entry it duplicates. */
  duplicateOf?: string;
  timingKind?: 'deposit_in_transit' | 'outstanding_payment';
  /**
   * amount_difference: bank − ledger. not_in_ledger, suggested_match, suggested_split: bank amount.
   * Everything else: the ledger amount.
   */
  amount: Cents;
  reason: string;
}

export interface MatchResult {
  matched: MatchedPair[];
  exceptions: MatchException[];
}

export interface MatchInput {
  bank: Line[];
  ledger: Line[];
  preset: MonthEndPreset;
  periodEnd: IsoDate;
}

/** Only the closest candidates by date are searched, which keeps the combination search small. */
const SPLIT_CANDIDATE_LIMIT = 20;

interface Keyed {
  line: Line;
  key: string;
}

/**
 * Applies the preset's matching rules. Deterministic: same input, same output.
 * The rules run as passes (all Rule 1 first, then Rule 2, then Rule 3) so a loose
 * match can never take a ledger entry that an exact match needed.
 */
export function runMatching({ bank, ledger, preset, periodEnd }: MatchInput): MatchResult {
  const patterns = compilePatterns(preset.matching.referencePatterns);
  const keyed = (l: Line): Keyed => ({ line: l, key: referenceKey(l.reference, l.description, patterns) });
  const bankK = bank.map(keyed);
  const ledgerK = ledger.map(keyed);

  const matched: MatchedPair[] = [];
  const exceptions: MatchException[] = [];
  const usedBank = new Set<string>();
  const usedLedger = new Set<string>();
  let seq = 0;
  const nextId = () => `x${++seq}`;

  const openLedger = () => ledgerK.filter((l) => !usedLedger.has(l.line.id));
  const openBank = () => bankK.filter((b) => !usedBank.has(b.line.id));

  const pass = (pick: (b: Keyed, candidates: Keyed[]) => Keyed | undefined, onPick: (b: Keyed, l: Keyed) => void) => {
    for (const b of openBank()) {
      if (!b.key) continue;
      const l = pick(b, openLedger().filter((c) => c.key === b.key));
      if (!l) continue;
      usedBank.add(b.line.id);
      usedLedger.add(l.line.id);
      onPick(b, l);
    }
  };
  const closestDate = (b: Keyed, cs: Keyed[]) =>
    cs.reduce<Keyed | undefined>(
      (best, c) => (!best || daysBetween(c.line.date, b.line.date) < daysBetween(best.line.date, b.line.date) ? c : best),
      undefined,
    );

  // Rule 1: same amount, same date, same reference.
  pass(
    (b, cs) => cs.find((c) => c.line.amount === b.line.amount && c.line.date === b.line.date),
    (b, l) => matched.push({ bankId: b.line.id, ledgerId: l.line.id, rule: 1 }),
  );

  // Rule 2: same amount and reference, dates within tolerance. Closest date wins, then input order.
  pass(
    (b, cs) =>
      closestDate(
        b,
        cs.filter(
          (c) =>
            c.line.amount === b.line.amount &&
            daysBetween(c.line.date, b.line.date) <= preset.matching.dateToleranceDays,
        ),
      ),
    (b, l) => matched.push({ bankId: b.line.id, ledgerId: l.line.id, rule: 2 }),
  );

  // Rule 6: one statement line equals the sum of 2..splitMaxParts cash book entries of the same
  // sign within the suggestion window (a customer paying several invoices at once). Runs before
  // Rule 3 so a split isn't mistaken for an amount difference. Suggested only, and only when
  // exactly one combination fits. A single same-amount candidate is left for Rule 5.
  {
    const window = preset.matching.suggestionWindowDays;
    const order = new Map(ledgerK.map((l, i) => [l.line.id, i]));
    for (const b of openBank()) {
      const amount = b.line.amount;
      if (amount === 0) continue;
      const days = (l: Keyed) => daysBetween(l.line.date, b.line.date);
      const open = openLedger().filter((l) => days(l) <= window);
      if (open.some((l) => l.line.amount === amount)) continue;
      const text = normaliseRef(`${b.line.reference} ${b.line.description}`);
      const candidates = open
        .filter((l) => Math.sign(l.line.amount) === Math.sign(amount) && Math.abs(l.line.amount) < Math.abs(amount))
        .sort((x, y) => days(x) - days(y) || order.get(x.line.id)! - order.get(y.line.id)!)
        .slice(0, SPLIT_CANDIDATE_LIMIT)
        .map((l) => ({
          id: l.line.id,
          amount: l.line.amount,
          anchor: !!b.key && l.key === b.key,
          mentioned: mentions(text, l.key),
        }));
      const chosen = chooseSplit(
        subsetsSummingTo(candidates, amount, preset.matching.splitMaxParts),
        candidates.some((c) => c.anchor),
      );
      if (!chosen) continue;
      const parts = chosen
        .map((c) => ledgerK.find((l) => l.line.id === c.id)!)
        .sort((x, y) => order.get(x.line.id)! - order.get(y.line.id)!);
      usedBank.add(b.line.id);
      for (const p of parts) usedLedger.add(p.line.id);
      const refs = parts.map((p) => p.line.reference || p.key || p.line.description).join(' + ');
      const spread = Math.max(...parts.map(days));
      const apart = spread === 0 ? 'same date' : `up to ${spread} day${spread === 1 ? '' : 's'} apart`;
      exceptions.push({
        id: nextId(),
        type: 'suggested_split',
        bankId: b.line.id,
        ledgerIds: parts.map((p) => p.line.id),
        amount,
        reason: `Equals the sum of ${parts.length} cash book entries (${refs}), ${apart}.`,
      });
    }
  }

  // Rule 3: same reference, different amount. Flagged, never matched.
  pass(
    (b, cs) => closestDate(b, cs.filter((c) => c.line.amount !== b.line.amount)),
    (b, l) => {
      const diff = b.line.amount - l.line.amount;
      exceptions.push({
        id: nextId(),
        type: 'amount_difference',
        bankId: b.line.id,
        ledgerId: l.line.id,
        amount: diff,
        reason: `Same reference ${b.line.reference || b.key}; statement and cash book differ by ${formatRand(Math.abs(diff))}.`,
      });
    },
  );

  // Rule 4: an unmatched ledger entry with the same reference, amount and date as another entry.
  // Its twin is either the matched copy, or (when neither matched) the earlier copy, which is kept.
  const flagged = new Set<string>();
  const matchedLedger = new Set(matched.map((m) => m.ledgerId));
  for (const l of openLedger()) {
    if (!l.key) continue;
    const twin = ledgerK.find(
      (o) =>
        o.line.id !== l.line.id &&
        !flagged.has(o.line.id) &&
        o.key === l.key &&
        o.line.amount === l.line.amount &&
        o.line.date === l.line.date &&
        (matchedLedger.has(o.line.id) || ledgerK.indexOf(o) < ledgerK.indexOf(l)),
    );
    if (!twin) continue;
    flagged.add(l.line.id);
    usedLedger.add(l.line.id);
    exceptions.push({
      id: nextId(),
      type: 'possible_duplicate',
      ledgerId: l.line.id,
      duplicateOf: twin.line.id,
      amount: l.line.amount,
      reason: matchedLedger.has(twin.line.id)
        ? 'Same reference, amount and date as another cash book entry; only one appears on the statement.'
        : 'Same reference, amount and date as another cash book entry; neither appears on the statement.',
    });
  }

  // Rule 5: same amount, dates within the suggestion window, and exactly one candidate each way.
  // References may be missing or differ (card lines, debit orders, mistyped references), so this
  // is only ever a suggestion: a person confirms or rejects it. Ambiguous amounts are not suggested.
  {
    const window = preset.matching.suggestionWindowDays;
    const near = (a: Keyed, b: Keyed) =>
      a.line.amount === b.line.amount && daysBetween(a.line.date, b.line.date) <= window;
    const banks = openBank();
    const ledgers = openLedger();
    for (const b of banks) {
      const candidates = ledgers.filter((l) => near(b, l));
      if (candidates.length !== 1) continue;
      const l = candidates[0]!;
      if (banks.filter((x) => near(x, l)).length !== 1) continue;
      usedBank.add(b.line.id);
      usedLedger.add(l.line.id);
      const days = daysBetween(b.line.date, l.line.date);
      const apart = days === 0 ? 'same date' : `${days} day${days === 1 ? '' : 's'} apart`;
      let reason: string;
      if (b.key && b.key === l.key) {
        reason = `Same reference and amount, ${apart} (outside the ${preset.matching.dateToleranceDays}-day rule).`;
      } else if (b.key && l.key) {
        reason = `Same amount, ${apart}; references differ (${b.key} / ${l.key}).`;
      } else {
        reason = `Same amount, ${apart}; no reference to match on.`;
      }
      exceptions.push({ id: nextId(), type: 'suggested_match', bankId: b.line.id, ledgerId: l.line.id, amount: b.line.amount, reason });
    }
  }

  for (const b of openBank()) {
    exceptions.push({
      id: nextId(),
      type: 'not_in_ledger',
      bankId: b.line.id,
      amount: b.line.amount,
      reason: 'On the statement but not in the cash book.',
    });
  }

  const endDay = dayNumber(periodEnd);
  for (const l of openLedger()) {
    const age = endDay - dayNumber(l.line.date);
    const inflow = l.line.amount > 0;
    if (age >= 0 && age <= preset.matching.timingWindowDays) {
      exceptions.push({
        id: nextId(),
        type: 'timing',
        ledgerId: l.line.id,
        timingKind: inflow ? 'deposit_in_transit' : 'outstanding_payment',
        amount: l.line.amount,
        reason: inflow
          ? 'Deposit in transit: in the cash book, not yet on the statement.'
          : 'Outstanding payment: in the cash book, not yet cleared by the bank.',
      });
    } else {
      exceptions.push({
        id: nextId(),
        type: 'not_on_statement',
        ledgerId: l.line.id,
        amount: l.line.amount,
        reason:
          age < 0
            ? 'In the cash book but dated after the period end.'
            : `In the cash book, not on the statement, and dated ${age} days before period end.`,
      });
    }
  }

  return { matched, exceptions };
}
