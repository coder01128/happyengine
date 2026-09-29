import { formatDate, parseAmount } from '@happy/core';
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { go, type Membership } from '../App.tsx';
import { Modal } from '../components/Modal.tsx';
import { Badge, useToast } from '../components/ui.tsx';
import { RUN_STATUS, formatTimestamp } from '../labels.ts';
import { callFunction, orThrow, supabase } from '../supabase.ts';

interface RunListRow {
  id: string;
  label: string;
  period_end: string;
  status: string;
  matched_at: string | null;
  approved_at: string | null;
  created_at: string;
}

export function Runs({ membership }: { membership: Membership }) {
  const [runs, setRuns] = useState<RunListRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    try {
      const rows = orThrow(
        await supabase
          .from('runs')
          .select('id, label, period_end, status, matched_at, approved_at, created_at')
          .eq('org_id', membership.orgId)
          .order('period_end', { ascending: false })
          .order('created_at', { ascending: false }),
      );
      setRuns(rows as RunListRow[]);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [membership.orgId]);
  useEffect(() => {
    void load();
  }, [load]);

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">Happy Month-End</div>
          <h1>Bank reconciliations</h1>
          <p>Each reconciliation matches one bank statement against the cash book for the same period. A person approves every outcome; nothing is posted.</p>
        </div>
        <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>
          New reconciliation
        </button>
      </div>

      {error && <p className="err-box">{error}</p>}
      {runs && runs.length === 0 && (
        <div className="card">
          <p className="muted">No reconciliations yet. Start one with “New reconciliation”.</p>
        </div>
      )}
      {runs && runs.length > 0 && (
        <ul className="group">
          {runs.map((r) => (
            <li key={r.id}>
              <button type="button" className="run-row" onClick={() => go(`#/run/${r.id}`)}>
                <div>
                  <div className="t">{r.label}</div>
                  <div className="m">
                    Period ending {formatDate(r.period_end)}
                    {r.approved_at
                      ? ` · approved ${formatTimestamp(r.approved_at)}`
                      : r.matched_at
                        ? ` · matched ${formatTimestamp(r.matched_at)}`
                        : ` · started ${formatTimestamp(r.created_at)}`}
                  </div>
                </div>
                <Badge {...RUN_STATUS[r.status]!} />
              </button>
            </li>
          ))}
        </ul>
      )}

      {creating && <NewRunModal membership={membership} onClose={() => setCreating(false)} />}
    </>
  );
}

function NewRunModal({ membership, onClose }: { membership: Membership; onClose: () => void }) {
  const toast = useToast();
  const [label, setLabel] = useState('');
  const [periodEnd, setPeriodEnd] = useState('');
  const [openingBank, setOpeningBank] = useState('');
  const [openingLedger, setOpeningLedger] = useState('');
  const [bankFile, setBankFile] = useState<File | null>(null);
  const [ledgerFile, setLedgerFile] = useState<File | null>(null);
  const [step, setStep] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);

  const amount = (s: string) => {
    try {
      return parseAmount(s);
    } catch {
      return null;
    }
  };
  const problems = {
    label: !label.trim() ? 'Name the account and month.' : null,
    periodEnd: !periodEnd ? 'Choose the last day of the period.' : null,
    openingBank: amount(openingBank) === null ? 'Enter an amount, e.g. 184 250.00' : null,
    openingLedger: amount(openingLedger) === null ? 'Enter an amount, e.g. 184 250.00' : null,
    bankFile: !bankFile ? 'Choose the bank statement export (.csv or .ofx).' : null,
    ledgerFile: !ledgerFile ? 'Choose the cash book export (.csv).' : null,
  };
  const valid = Object.values(problems).every((p) => !p);
  const show = (k: keyof typeof problems) => (touched ? problems[k] : null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (!valid || step) return;
    setError(null);
    let runId: string | null = null;
    try {
      setStep('Creating…');
      const preset = orThrow(
        await supabase
          .from('presets')
          .select('id')
          .eq('org_id', membership.orgId)
          .eq('service', 'month_end')
          .eq('active', true)
          .single(),
      ) as { id: string };
      const { data: userData } = await supabase.auth.getUser();
      const run = orThrow(
        await supabase
          .from('runs')
          .insert({
            org_id: membership.orgId,
            label: label.trim(),
            period_end: periodEnd,
            opening_bank: amount(openingBank),
            opening_ledger: amount(openingLedger),
            preset_id: preset.id,
            created_by: userData.user!.id,
          })
          .select('id')
          .single(),
      ) as { id: string };
      runId = run.id;

      setStep('Uploading…');
      for (const [side, file] of [
        ['bank', bankFile!],
        ['ledger', ledgerFile!],
      ] as const) {
        const ext = file.name.split('.').pop()?.toLowerCase() ?? 'csv';
        const path = `${membership.orgId}/${run.id}/${side}.${ext}`;
        const up = await supabase.storage.from('documents').upload(path, file, { contentType: file.type || 'text/csv' });
        if (up.error) throw new Error(up.error.message);
        orThrow(
          await supabase
            .from('documents')
            .insert({ org_id: membership.orgId, run_id: run.id, side, storage_path: path, filename: file.name, uploaded_by: userData.user!.id }),
        );
      }

      setStep('Matching…');
      await callFunction('run-matching', { runId: run.id });
      toast('Matching done. Review the exceptions.');
      go(`#/run/${run.id}`);
    } catch (err) {
      setStep(null);
      if (runId) {
        // The run exists as a draft: open it so the files can be replaced and matching run again.
        toast((err as Error).message);
        go(`#/run/${runId}`);
      } else {
        setError((err as Error).message);
      }
    }
  };

  const field = (id: keyof typeof problems, text: string, input: ReactNode, hint?: string) => (
    <div className="field">
      <label htmlFor={id}>{text}</label>
      {input}
      {hint && <p className="hint">{hint}</p>}
      {show(id) && <p className="err">{show(id)}</p>}
    </div>
  );

  return (
    <Modal title="New reconciliation" onClose={onClose}>
      <form onSubmit={submit} noValidate>
        {field(
          'label',
          'Account and month',
          <input id="label" type="text" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Business current account — Oct 2026" aria-invalid={!!show('label')} />,
        )}
        {field(
          'periodEnd',
          'Period end',
          <input id="periodEnd" type="date" value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)} aria-invalid={!!show('periodEnd')} />,
        )}
        <div className="form-grid">
          {field(
            'openingBank',
            'Opening balance — bank statement',
            <input id="openingBank" type="text" inputMode="decimal" value={openingBank} onChange={(e) => setOpeningBank(e.target.value)} aria-invalid={!!show('openingBank')} />,
          )}
          {field(
            'openingLedger',
            'Opening balance — cash book',
            <input id="openingLedger" type="text" inputMode="decimal" value={openingLedger} onChange={(e) => setOpeningLedger(e.target.value)} aria-invalid={!!show('openingLedger')} />,
          )}
        </div>
        {field(
          'bankFile',
          'Bank statement export',
          <input id="bankFile" type="file" accept=".csv,.ofx,.qfx,text/csv" onChange={(e) => setBankFile(e.target.files?.[0] ?? null)} aria-invalid={!!show('bankFile')} />,
          'CSV or OFX, exactly as downloaded from the bank.',
        )}
        {field(
          'ledgerFile',
          'Cash book export',
          <input id="ledgerFile" type="file" accept=".csv,text/csv" onChange={(e) => setLedgerFile(e.target.files?.[0] ?? null)} aria-invalid={!!show('ledgerFile')} />,
          'CSV from the accounting system, same period.',
        )}
        {error && (
          <p className="err-box" role="alert">
            {error}
          </p>
        )}
        <div className="actions">
          <button type="submit" className="btn btn-primary" aria-disabled={touched && !valid ? 'true' : undefined} disabled={!!step}>
            {step ?? 'Upload and match'}
          </button>
          <button type="button" className="btn btn-quiet" onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </Modal>
  );
}
