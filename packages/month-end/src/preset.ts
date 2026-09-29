import type { DateFormat } from '../../core/src/index.ts';

/** How to read one CSV export. Column names are matched case-insensitively. */
export interface ColumnMapping {
  delimiter?: string;
  dateFormat: DateFormat;
  date: string;
  description: string;
  reference?: string;
  /** Either one signed amount column... */
  amount?: string;
  /** Flip the sign of `amount` when the export uses the opposite convention. */
  invertSign?: boolean;
  /** ...or separate money-in / money-out columns (both read as positive numbers). */
  inflow?: string;
  outflow?: string;
}

export type ResolutionEffect =
  /** Cash book side moves by (bank amount − ledger amount). */
  | 'adjust_ledger_to_bank'
  /** Cash book side reverses the ledger entry. */
  | 'reverse_ledger_entry'
  /** Ledger entry is carried on the bank side as in transit / outstanding. */
  | 'treat_as_outstanding'
  /** Recorded with a note; does not change either balance. */
  | 'none'
  /** Suggested match (Rule 5) confirmed: treated as a matched pair. */
  | 'confirm_match'
  /** Suggested match (Rule 5) rejected: the bank line counts as unrecorded, so the difference stays open. */
  | 'reject_match';

export interface ResolutionOption {
  id: string;
  /** May contain {difference}, {bankAmount}, {ledgerAmount}. */
  label: string;
  effect: ResolutionEffect;
  noteRequired: boolean;
}

export type ReviewedExceptionType =
  | 'amount_difference'
  | 'possible_duplicate'
  | 'not_on_statement'
  | 'suggested_match'
  | 'suggested_split';

export interface ChecklistItem {
  id: string;
  task: string;
  owner: string;
  due: string;
  /** Set when this engine's approval completes the task. */
  completedBy?: 'bank_reconciliation';
}

export interface MonthEndPreset {
  service: 'Happy Month-End';
  version: number;
  sources: { bank: ColumnMapping; ledger: ColumnMapping };
  matching: {
    /** Rule 2: same amount and reference, dates within this many days. */
    dateToleranceDays: number;
    /** Regexes that pull a reference out of reference + description, tried in order. */
    referencePatterns: string[];
    /** Unmatched cash book entries this close to period end are timing items; older ones need review. */
    timingWindowDays: number;
    /** Rule 5: same amount, dates within this many days, one candidate each way → suggested for a person to confirm. */
    suggestionWindowDays: number;
    /** Rule 6: most cash book entries one statement line may be split across (2–6). */
    splitMaxParts: number;
  };
  /** Proposed journal label for a bank line not in the cash book: first regex on the description wins. */
  journals: { match: string; label: string }[];
  journalFallbackLabel: string;
  resolutions: Record<ReviewedExceptionType, ResolutionOption[]>;
  checklist: ChecklistItem[];
}

const EFFECTS: ResolutionEffect[] = [
  'adjust_ledger_to_bank',
  'reverse_ledger_entry',
  'treat_as_outstanding',
  'none',
  'confirm_match',
  'reject_match',
];
const REVIEWED: ReviewedExceptionType[] = [
  'amount_difference',
  'possible_duplicate',
  'not_on_statement',
  'suggested_match',
  'suggested_split',
];
const SUGGESTED: ReviewedExceptionType[] = ['suggested_match', 'suggested_split'];
const MATCH_EFFECTS: ResolutionEffect[] = ['confirm_match', 'reject_match'];

/** Presets are hand-edited JSON rows, so check them before use. Returns a list of problems (empty = valid). */
export function validatePreset(p: MonthEndPreset): string[] {
  const problems: string[] = [];
  const regexes = [...p.matching.referencePatterns, ...p.journals.map((j) => j.match)];
  for (const r of regexes) {
    try {
      new RegExp(r, 'i');
    } catch {
      problems.push(`Invalid regex: ${r}`);
    }
  }
  for (const side of ['bank', 'ledger'] as const) {
    const m = p.sources[side];
    if (!m.amount && !(m.inflow && m.outflow)) {
      problems.push(`sources.${side}: needs "amount" or both "inflow" and "outflow"`);
    }
  }
  for (const type of REVIEWED) {
    const options = p.resolutions[type];
    if (!options?.length) {
      problems.push(`resolutions.${type}: no options`);
      continue;
    }
    for (const o of options) {
      if (!EFFECTS.includes(o.effect)) problems.push(`resolutions.${type}.${o.id}: unknown effect "${o.effect}"`);
      if (o.effect === 'none' && !o.noteRequired) problems.push(`resolutions.${type}.${o.id}: "none" must require a note`);
      if (SUGGESTED.includes(type) !== MATCH_EFFECTS.includes(o.effect)) {
        problems.push(`resolutions.${type}.${o.id}: "${o.effect}" can't be used here`);
      }
    }
    if (SUGGESTED.includes(type) && !options.some((o) => o.effect === 'confirm_match')) {
      problems.push(`resolutions.${type}: needs a "confirm_match" option`);
    }
  }
  const { dateToleranceDays, timingWindowDays, suggestionWindowDays, splitMaxParts } = p.matching;
  if (!(suggestionWindowDays >= 0)) problems.push('matching.suggestionWindowDays: missing');
  if (!(Number.isInteger(splitMaxParts) && splitMaxParts >= 2 && splitMaxParts <= 6)) {
    problems.push('matching.splitMaxParts: must be a whole number from 2 to 6');
  }
  if (dateToleranceDays < 0 || timingWindowDays < 0) {
    problems.push('matching: day windows must be 0 or more');
  }
  return problems;
}
