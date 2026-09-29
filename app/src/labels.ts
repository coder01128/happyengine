import { formatRand } from '@happy/core';
import type { ExceptionType, MatchException, ResolutionEffect } from '@happy/month-end';

/** Status is always colour plus a text label. */
export const EXCEPTION_LABEL: Record<ExceptionType, { text: string; cls: string }> = {
  suggested_match: { text: 'Suggested match', cls: 'b-rev' },
  suggested_split: { text: 'Suggested split', cls: 'b-rev' },
  amount_difference: { text: 'Amount difference', cls: 'b-mis' },
  possible_duplicate: { text: 'Possible duplicate', cls: 'b-exp' },
  not_on_statement: { text: 'Not on statement', cls: 'b-exp' },
  not_in_ledger: { text: 'Not in cash book', cls: 'b-inc' },
  timing: { text: 'Timing', cls: 'b-neutral' },
};

/** Order the list is shown in: things a person must decide first, read-only timing last. */
export const EXCEPTION_ORDER: ExceptionType[] = [
  'suggested_match',
  'suggested_split',
  'amount_difference',
  'possible_duplicate',
  'not_on_statement',
  'not_in_ledger',
  'timing',
];

export const RUN_STATUS: Record<string, { text: string; cls: string }> = {
  draft: { text: 'Draft — not matched yet', cls: 'b-neutral' },
  matched: { text: 'In review', cls: 'b-inc' },
  approved: { text: 'Approved', cls: 'b-ok' },
};

export const CHECK_STATUS: Record<string, { text: string; cls: string }> = {
  open: { text: 'Open', cls: 'b-neutral' },
  in_progress: { text: 'In progress', cls: 'b-inc' },
  waiting: { text: 'Waiting on information', cls: 'b-exp' },
  done: { text: 'Done', cls: 'b-ok' },
};

/** What a resolution option will do to the reconciliation, in plain words. */
export function effectText(effect: ResolutionEffect, e: MatchException, ledgerAmount: number | undefined): string {
  switch (effect) {
    case 'adjust_ledger_to_bank':
      return `Cash book side adjusts by ${formatRand(e.amount)}.`;
    case 'reverse_ledger_entry':
      return `Cash book entry reversed (${formatRand(-(ledgerAmount ?? 0))}).`;
    case 'treat_as_outstanding':
      return 'Carried on the bank side as outstanding until it clears.';
    case 'confirm_match':
      return 'Treated as matched.';
    case 'reject_match':
      return 'Statement line counted as unrecorded; the difference stays open for investigation.';
    case 'none':
      return 'No change to the figures; the difference stays open.';
  }
}

export function timelineText(
  event: string,
  detail: Record<string, any>,
  optionText: (exceptionId: string, optionId: string) => string = (_e, o) => o,
): { label: string; detail?: string } {
  switch (event) {
    case 'document_received':
      return { label: `${detail.side === 'bank' ? 'Bank statement' : 'Cash book export'} received`, detail: detail.filename };
    case 'document_removed':
      return { label: `${detail.side === 'bank' ? 'Bank statement' : 'Cash book export'} removed`, detail: detail.filename };
    case 'matching_run':
    case 'matching_rerun': {
      const excs = Object.entries((detail.exceptions ?? {}) as Record<string, number>)
        .map(([t, n]) => `${n} ${EXCEPTION_LABEL[t as ExceptionType]?.text.toLowerCase() ?? t}`)
        .join(', ');
      return {
        label: event === 'matching_rerun' ? 'Matching run again' : 'Matching run',
        detail: `${detail.matched} matched${excs ? ` · ${excs}` : ''}`,
      };
    }
    case 'decision_recorded':
      return {
        label: 'Decision recorded',
        detail: `${EXCEPTION_LABEL[detail.type as ExceptionType]?.text ?? detail.type}: ${optionText(detail.exception, detail.option)}${detail.note ? ` — “${detail.note}”` : ''}`,
      };
    case 'journal_approved':
      return { label: 'Journal approved', detail: `${detail.label} ${formatRand(detail.amount)} · not posted` };
    case 'reconciliation_approved':
      return { label: 'Reconciliation approved', detail: 'Unexplained difference R0.00 · nothing was posted' };
    default:
      return { label: event };
  }
}

export function formatTimestamp(iso: string): string {
  return new Intl.DateTimeFormat('en-ZA', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(
    new Date(iso),
  );
}
