import type { MatchException, MatchResult } from './match.ts';
import { formatRand, type Cents } from '../../core/src/index.ts';
import type { MonthEndPreset, ResolutionOption, ReviewedExceptionType } from './preset.ts';
import type { Line } from './types.ts';

/** A reviewer's choice for one exception, keyed by exception id. */
export interface Decision {
  optionId: string;
  note?: string;
}
export type Decisions = Record<string, Decision>;

export interface ReconInput {
  openingBank: Cents;
  openingLedger: Cents;
  bank: Line[];
  ledger: Line[];
  result: MatchResult;
  preset: MonthEndPreset;
  decisions: Decisions;
}

export interface ReconPanel {
  bankClosing: Cents;
  /** Positive cash book items not yet on the statement. */
  depositsInTransit: Cents;
  /** Negative cash book items not yet cleared (a negative number). */
  outstandingPayments: Cents;
  adjustedBank: Cents;
  ledgerClosing: Cents;
  /** Bank credits not yet in the cash book, e.g. interest. */
  unrecordedCredits: Cents;
  /** Bank debits not yet in the cash book, e.g. service fees (a negative number). */
  unrecordedDebits: Cents;
  /** Corrections from reviewer decisions. */
  ledgerAdjustments: Cents;
  adjustedLedger: Cents;
  /** Adjusted cash book − adjusted bank. Must be 0 before approval. */
  difference: Cents;
}

const REVIEWED = new Set<string>([
  'amount_difference',
  'possible_duplicate',
  'not_on_statement',
  'suggested_match',
  'suggested_split',
]);

export function isReviewed(e: MatchException): e is MatchException & { type: ReviewedExceptionType } {
  return REVIEWED.has(e.type);
}

export function chosenOption(preset: MonthEndPreset, e: MatchException, d: Decision | undefined) {
  if (!d || !isReviewed(e)) return undefined;
  return preset.resolutions[e.type].find((o) => o.id === d.optionId);
}

const sum = (xs: Cents[]) => xs.reduce((a, b) => a + b, 0);

/** Recomputed from scratch on every call, so the panel can never drift from the data. */
export function reconcile(input: ReconInput): ReconPanel {
  const { bank, ledger, result, preset, decisions } = input;
  const ledgerById = new Map(ledger.map((l) => [l.id, l]));
  const bankSide: Cents[] = [];
  let ledgerAdjustments = 0;
  let unrecordedCredits = 0;
  let unrecordedDebits = 0;

  for (const e of result.exceptions) {
    if (e.type === 'timing') bankSide.push(e.amount);
    if (e.type === 'not_in_ledger') {
      if (e.amount >= 0) unrecordedCredits += e.amount;
      else unrecordedDebits += e.amount;
    }
    const option = chosenOption(preset, e, decisions[e.id]);
    if (!option) continue;
    const ledgerAmount = e.ledgerId ? ledgerById.get(e.ledgerId)?.amount ?? 0 : 0;
    switch (option.effect) {
      case 'adjust_ledger_to_bank':
        if (e.type === 'amount_difference') ledgerAdjustments += e.amount;
        break;
      case 'reverse_ledger_entry':
        ledgerAdjustments -= ledgerAmount;
        break;
      case 'treat_as_outstanding':
        bankSide.push(ledgerAmount);
        break;
      case 'reject_match':
        // The pair was not the same transaction: the bank line is unrecorded, the ledger entry unexplained.
        if (e.amount >= 0) unrecordedCredits += e.amount;
        else unrecordedDebits += e.amount;
        break;
      case 'confirm_match':
      case 'none':
        break;
    }
  }

  const bankClosing = input.openingBank + sum(bank.map((l) => l.amount));
  const ledgerClosing = input.openingLedger + sum(ledger.map((l) => l.amount));
  const depositsInTransit = sum(bankSide.filter((a) => a > 0));
  const outstandingPayments = sum(bankSide.filter((a) => a < 0));
  const adjustedBank = bankClosing + depositsInTransit + outstandingPayments;
  const adjustedLedger = ledgerClosing + unrecordedCredits + unrecordedDebits + ledgerAdjustments;

  return {
    bankClosing,
    depositsInTransit,
    outstandingPayments,
    adjustedBank,
    ledgerClosing,
    unrecordedCredits,
    unrecordedDebits,
    ledgerAdjustments,
    adjustedLedger,
    difference: adjustedLedger - adjustedBank,
  };
}

/** Resolution options for one exception, labels filled in, sorted alphabetically. */
export function optionsFor(
  preset: MonthEndPreset,
  e: MatchException,
  bank: Line[],
  ledger: Line[],
): (ResolutionOption & { text: string })[] {
  if (!isReviewed(e)) return [];
  const b = bank.find((l) => l.id === e.bankId);
  const l = ledger.find((x) => x.id === e.ledgerId);
  const fill = (label: string) =>
    label
      .replaceAll('{difference}', formatRand(Math.abs(b && l ? b.amount - l.amount : e.amount)))
      .replaceAll('{bankAmount}', b ? formatRand(Math.abs(b.amount)) : '')
      .replaceAll('{ledgerAmount}', l ? formatRand(Math.abs(l.amount)) : '');
  return preset.resolutions[e.type]
    .map((o) => ({ ...o, text: fill(o.label) }))
    .sort((x, y) => x.text.localeCompare(y.text, 'en'));
}
