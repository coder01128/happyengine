// POST { runId } — re-checks the reconciliation from stored data with the engine and, only if
// the difference is R0.00 and nothing is open, approves it. Approval never posts anything and
// does not close the month: the rest of the close checklist stays as it is.

import { approvalStatus, reconcile, stateFromRows, type MonthEndPreset, type RunRows } from '../_shared/engine.ts';
import { HttpError, handle, json, loadRun, readRunId, requireRole, requireUser } from '../_shared/http.ts';

Deno.serve(
  handle(async (req) => {
    const { user, admin } = await requireUser(req);
    const runId = await readRunId(req);
    const run = await loadRun(admin, runId);
    await requireRole(admin, run.org_id, user.id, ['reviewer', 'admin']);
    if (run.status !== 'matched') throw new HttpError(409, `This reconciliation is ${run.status}, not ready for approval.`);

    const q = async <T>(table: string) => {
      const { data, error } = await admin.from(table).select('*').eq('run_id', runId);
      if (error) throw error;
      return data as T[];
    };
    const [lines, matches, exceptions, parts, journals, decisions] = await Promise.all([
      q<RunRows['lines'][number]>('lines'),
      q<RunRows['matches'][number]>('matches'),
      q<RunRows['exceptions'][number]>('exceptions'),
      q<RunRows['parts'][number]>('exception_parts'),
      q<RunRows['journals'][number]>('journals'),
      q<RunRows['decisions'][number]>('decisions'),
    ]);
    const state = stateFromRows({ lines, matches, exceptions, parts, journals, decisions });
    const preset = run.preset_snapshot as MonthEndPreset;

    const panel = reconcile({
      openingBank: Number(run.opening_bank),
      openingLedger: Number(run.opening_ledger),
      bank: state.bank,
      ledger: state.ledger,
      result: state.result,
      preset,
      decisions: state.decisions,
    });
    const status = approvalStatus({
      panel,
      journals: state.journals,
      approvedJournalIds: state.approvedJournalIds,
      result: state.result,
      preset,
      decisions: state.decisions,
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
