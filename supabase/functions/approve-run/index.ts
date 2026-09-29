// POST { runId } — re-checks the reconciliation from stored data with the engine and, only if
// the difference is R0.00 and nothing is open, approves it. Approval never posts anything and
// does not close the month: the rest of the close checklist stays as it is.

import {
  approvalStatus,
  reconcile,
  type Decisions,
  type Line,
  type MatchException,
  type MatchResult,
  type MonthEndPreset,
  type ProposedJournal,
} from '../_shared/engine.ts';
import { HttpError, handle, json, loadRun, readRunId, requireRole, requireUser } from '../_shared/http.ts';

Deno.serve(
  handle(async (req) => {
    const { user, admin } = await requireUser(req);
    const runId = await readRunId(req);
    const run = await loadRun(admin, runId);
    await requireRole(admin, run.org_id, user.id, ['reviewer', 'admin']);
    if (run.status !== 'matched') throw new HttpError(409, `This reconciliation is ${run.status}, not ready for approval.`);

    const q = async (table: string, columns = '*') => {
      const { data, error } = await admin.from(table).select(columns).eq('run_id', runId);
      if (error) throw error;
      return data as unknown as Record<string, any>[];
    };
    const [lineRows, matchRows, excRows, partRows, journalRows, decisionRows] = await Promise.all([
      q('lines'),
      q('matches'),
      q('exceptions'),
      q('exception_parts'),
      q('journals'),
      q('decisions'),
    ]);

    const ext = new Map(lineRows.map((l) => [l.id as string, l.ext_id as string]));
    const engineId = new Map(excRows.map((e) => [e.id as string, e.engine_id as string]));
    const toLine = (l: Record<string, any>): Line => ({
      id: l.ext_id,
      side: l.side,
      date: l.date,
      description: l.description,
      reference: l.reference,
      amount: Number(l.amount),
    });
    const byExt = (a: Line, b: Line) => Number(a.id.slice(1)) - Number(b.id.slice(1));
    const extOrder = (a: string, b: string) => Number(a.slice(1)) - Number(b.slice(1));
    const partsOf = (exceptionId: string) =>
      partRows.filter((p) => p.exception_id === exceptionId).map((p) => ext.get(p.line_id)!).sort(extOrder);
    const bank = lineRows.filter((l) => l.side === 'bank').map(toLine).sort(byExt);
    const ledger = lineRows.filter((l) => l.side === 'ledger').map(toLine).sort(byExt);

    const result: MatchResult = {
      matched: matchRows.map((m) => ({ bankId: ext.get(m.bank_line_id)!, ledgerId: ext.get(m.ledger_line_id)!, rule: m.rule })),
      exceptions: excRows.map(
        (e): MatchException => ({
          id: e.engine_id,
          type: e.type,
          bankId: e.bank_line_id ? ext.get(e.bank_line_id) : undefined,
          ledgerId: e.ledger_line_id ? ext.get(e.ledger_line_id) : undefined,
          ledgerIds: e.type === 'suggested_split' ? partsOf(e.id) : undefined,
          duplicateOf: e.duplicate_of_line_id ? ext.get(e.duplicate_of_line_id) : undefined,
          timingKind: e.timing_kind ?? undefined,
          amount: Number(e.amount),
          reason: e.reason,
        }),
      ),
    };
    const decisions: Decisions = Object.fromEntries(
      decisionRows.map((d) => [engineId.get(d.exception_id)!, { optionId: d.option_id, note: d.note ?? undefined }]),
    );
    const journals: ProposedJournal[] = journalRows.map((j) => ({
      id: j.id,
      exceptionId: engineId.get(j.exception_id)!,
      bankId: ext.get(j.bank_line_id)!,
      label: j.label,
      amount: Number(j.amount),
    }));
    const preset = run.preset_snapshot as MonthEndPreset;

    const panel = reconcile({
      openingBank: Number(run.opening_bank),
      openingLedger: Number(run.opening_ledger),
      bank,
      ledger,
      result,
      preset,
      decisions,
    });
    const status = approvalStatus({
      panel,
      journals,
      approvedJournalIds: journalRows.filter((j) => j.approved_at).map((j) => j.id),
      result,
      preset,
      decisions,
    });
    if (!status.canApprove) return json(409, { error: status.message, status, panel });

    const { error } = await admin.rpc('approve_run', {
      p_run: runId,
      p_actor: user.id,
      p_review_version: run.review_version,
      p_panel: panel,
    });
    if (error) throw new HttpError(409, error.message);
    return json(200, { approved: true, panel });
  }),
);
