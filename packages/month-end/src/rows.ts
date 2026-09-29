// Rebuilds engine state from stored database rows, so the server (approve-run) and the review
// screen compute the reconciliation from exactly the same inputs. Pure: rows in, state out.

import type { MatchException, MatchResult } from './match.ts';
import type { Decisions } from './reconcile.ts';
import type { ProposedJournal } from './review.ts';
import type { Line, Side } from './types.ts';

type Amount = number | string; // PostgREST returns bigint as number; be tolerant of strings

export interface LineRow {
  id: string;
  side: Side;
  ext_id: string;
  date: string;
  description: string;
  reference: string;
  amount: Amount;
}
export interface MatchRow {
  bank_line_id: string;
  ledger_line_id: string;
  rule: 1 | 2;
}
export interface ExceptionRow {
  id: string;
  engine_id: string;
  type: MatchException['type'];
  bank_line_id: string | null;
  ledger_line_id: string | null;
  duplicate_of_line_id: string | null;
  timing_kind: MatchException['timingKind'] | null;
  amount: Amount;
  reason: string;
}
export interface PartRow {
  exception_id: string;
  line_id: string;
}
export interface JournalRow {
  id: string;
  exception_id: string;
  bank_line_id: string;
  label: string;
  amount: Amount;
  approved_at: string | null;
}
export interface DecisionRow {
  exception_id: string;
  option_id: string;
  note: string | null;
}

export interface RunRows {
  lines: LineRow[];
  matches: MatchRow[];
  exceptions: ExceptionRow[];
  parts: PartRow[];
  journals: JournalRow[];
  decisions: DecisionRow[];
}

export interface RunState {
  bank: Line[];
  ledger: Line[];
  result: MatchResult;
  journals: ProposedJournal[];
  approvedJournalIds: string[];
  /** Keyed by engine exception id (x1, x2 …). */
  decisions: Decisions;
  /** Engine exception id → database exception id, for calling the review RPCs. */
  exceptionDbId: Map<string, string>;
}

const byExt = (a: string, b: string) => Number(a.slice(1)) - Number(b.slice(1));

export function stateFromRows(rows: RunRows): RunState {
  const ext = new Map(rows.lines.map((l) => [l.id, l.ext_id]));
  const engineId = new Map(rows.exceptions.map((e) => [e.id, e.engine_id]));
  const extOf = (id: string | null) => (id ? ext.get(id) : undefined);

  const toLine = (l: LineRow): Line => ({
    id: l.ext_id,
    side: l.side,
    date: l.date,
    description: l.description,
    reference: l.reference,
    amount: Number(l.amount),
  });
  const bank = rows.lines.filter((l) => l.side === 'bank').map(toLine).sort((a, b) => byExt(a.id, b.id));
  const ledger = rows.lines.filter((l) => l.side === 'ledger').map(toLine).sort((a, b) => byExt(a.id, b.id));

  const partsOf = (exceptionId: string) =>
    rows.parts.filter((p) => p.exception_id === exceptionId).map((p) => ext.get(p.line_id)!).sort(byExt);

  const exceptions = rows.exceptions
    .map(
      (e): MatchException => ({
        id: e.engine_id,
        type: e.type,
        bankId: extOf(e.bank_line_id),
        ledgerId: extOf(e.ledger_line_id),
        ledgerIds: e.type === 'suggested_split' ? partsOf(e.id) : undefined,
        duplicateOf: extOf(e.duplicate_of_line_id),
        timingKind: e.timing_kind ?? undefined,
        amount: Number(e.amount),
        reason: e.reason,
      }),
    )
    .sort((a, b) => byExt(a.id, b.id));

  return {
    bank,
    ledger,
    result: {
      matched: rows.matches.map((m) => ({ bankId: ext.get(m.bank_line_id)!, ledgerId: ext.get(m.ledger_line_id)!, rule: m.rule })),
      exceptions,
    },
    journals: rows.journals.map((j) => ({
      id: j.id,
      exceptionId: engineId.get(j.exception_id)!,
      bankId: ext.get(j.bank_line_id)!,
      label: j.label,
      amount: Number(j.amount),
    })),
    approvedJournalIds: rows.journals.filter((j) => j.approved_at).map((j) => j.id),
    decisions: Object.fromEntries(
      rows.decisions.map((d) => [engineId.get(d.exception_id)!, { optionId: d.option_id, note: d.note ?? undefined }]),
    ),
    exceptionDbId: new Map(rows.exceptions.map((e) => [e.engine_id, e.id])),
  };
}
