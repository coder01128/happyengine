import type { MatchResult } from './match.ts';
import type { Cents } from './money.ts';
import type { MonthEndPreset } from './preset.ts';
import { chosenOption, isReviewed, type Decisions, type ReconPanel } from './reconcile.ts';
import type { Line } from './types.ts';

export interface ProposedJournal {
  id: string;
  exceptionId: string;
  bankId: string;
  label: string;
  amount: Cents;
}

/** One proposed journal per statement line missing from the cash book. A person approves each. */
export function proposeJournals(result: MatchResult, bank: Line[], preset: MonthEndPreset): ProposedJournal[] {
  const rules = preset.journals.map((j) => ({ re: new RegExp(j.match, 'i'), label: j.label }));
  return result.exceptions
    .filter((e) => e.type === 'not_in_ledger' && e.bankId)
    .map((e) => {
      const line = bank.find((l) => l.id === e.bankId)!;
      const hit = rules.find((r) => r.re.test(`${line.reference} ${line.description}`));
      return {
        id: `j-${line.id}`,
        exceptionId: e.id,
        bankId: line.id,
        label: hit?.label ?? preset.journalFallbackLabel,
        amount: line.amount,
      };
    });
}

export interface ApprovalStatus {
  canApprove: boolean;
  openJournals: number;
  openDifferences: number;
  /** Rule 5 and Rule 6 suggestions not yet confirmed or rejected. */
  openSuggestions: number;
  message: string;
}

const plural = (n: number, word: string, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;

/**
 * Approval needs every journal approved, every reviewed exception decided (with a note where
 * required), and an unexplained difference of exactly 0. "Other" is a decision, but it moves
 * no money, so it leaves the difference open and approval stays blocked.
 */
export function approvalStatus(args: {
  panel: ReconPanel;
  journals: ProposedJournal[];
  approvedJournalIds: Iterable<string>;
  result: MatchResult;
  preset: MonthEndPreset;
  decisions: Decisions;
}): ApprovalStatus {
  const approved = new Set(args.approvedJournalIds);
  const openJournals = args.journals.filter((j) => !approved.has(j.id)).length;
  const undecided = args.result.exceptions.filter((e) => {
    if (!isReviewed(e)) return false;
    const d = args.decisions[e.id];
    const option = chosenOption(args.preset, e, d);
    if (!option) return true;
    return option.noteRequired && !d?.note?.trim();
  });
  const openSuggestions = undecided.filter((e) => e.type === 'suggested_match' || e.type === 'suggested_split').length;
  const openDifferences = undecided.length - openSuggestions;

  const open = openJournals + openDifferences + openSuggestions;
  let message: string;
  if (open > 0) {
    const parts = [
      openJournals ? plural(openJournals, 'journal') : '',
      openDifferences ? plural(openDifferences, 'difference') : '',
      openSuggestions ? plural(openSuggestions, 'suggested match', 'suggested matches') : '',
    ].filter(Boolean);
    message = `${plural(open, 'item')} still open: ${parts.join(', ')}.`;
  } else if (args.panel.difference !== 0) {
    message = 'The unexplained difference is not zero.';
  } else {
    message = 'Ready for approval.';
  }
  return {
    canApprove: open === 0 && args.panel.difference === 0,
    openJournals,
    openDifferences,
    openSuggestions,
    message,
  };
}
