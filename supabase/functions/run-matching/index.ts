// POST { runId } — reads the run's uploaded bank statement and cash book export, runs the
// engine with the run's preset, and stores the result in one transaction (private.store_matching).
// Re-running replaces earlier output and review decisions, until the run is approved.

import {
  IngestError,
  linesFromCsv,
  linesFromOfx,
  proposeJournals,
  runMatching,
  validatePreset,
  type Line,
  type MonthEndPreset,
  type Side,
} from '../_shared/engine.ts';
import { HttpError, handle, json, loadRun, readRunId, requireRole, requireUser } from '../_shared/http.ts';

const LABEL: Record<Side, string> = { bank: 'Bank statement', ledger: 'Cash book export' };

Deno.serve(
  handle(async (req) => {
    const { user, admin } = await requireUser(req);
    const runId = await readRunId(req);
    const run = await loadRun(admin, runId);
    await requireRole(admin, run.org_id, user.id, ['uploader', 'reviewer', 'admin']);
    if (run.status === 'approved') throw new HttpError(409, 'This reconciliation is approved and can no longer be re-matched.');

    const { data: presetRow, error: presetError } = await admin
      .from('presets')
      .select('config')
      .eq('id', run.preset_id)
      .single();
    if (presetError) throw presetError;
    const preset = presetRow.config as MonthEndPreset;
    const problems = validatePreset(preset);
    if (problems.length) throw new HttpError(422, `Preset needs fixing: ${problems.join('; ')}`);

    const { data: docs, error: docsError } = await admin
      .from('documents')
      .select('side, storage_path, filename')
      .eq('run_id', runId);
    if (docsError) throw docsError;

    const read = async (side: Side, prefix: string): Promise<Line[]> => {
      const doc = docs.find((d) => d.side === side);
      if (!doc) throw new HttpError(422, `${LABEL[side]} not uploaded yet.`);
      const { data: blob, error } = await admin.storage.from('documents').download(doc.storage_path);
      if (error || !blob) throw new HttpError(422, `${LABEL[side]} could not be read from storage.`);
      const text = await blob.text();
      try {
        return /\.(ofx|qfx)$/i.test(doc.filename)
          ? linesFromOfx(text, side, prefix)
          : linesFromCsv(text, preset.sources[side], side, prefix);
      } catch (err) {
        if (err instanceof IngestError || err instanceof Error) throw new HttpError(422, `${LABEL[side]}: ${err.message}`);
        throw err;
      }
    };

    const bank = await read('bank', 's');
    const ledger = await read('ledger', 'l');
    const result = runMatching({ bank, ledger, preset, periodEnd: run.period_end });
    const journals = proposeJournals(result, bank, preset);

    const { data: summary, error } = await admin.rpc('store_matching', {
      p_run: runId,
      p_actor: user.id,
      p_preset: preset,
      p_result: { lines: [...bank, ...ledger], matched: result.matched, exceptions: result.exceptions, journals },
    });
    if (error) throw new HttpError(409, error.message);
    return json(200, summary);
  }),
);
