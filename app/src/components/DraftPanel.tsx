import { formatRand } from '@happy/engine';
import { useId, useState } from 'react';
import type { Membership } from '../App.tsx';
import type { DocumentRow, RunRow } from '../pages/RunReview.tsx';
import { callFunction, orThrow, supabase } from '../supabase.ts';
import { useToast } from './ui.tsx';

const SIDES = [
  { side: 'bank', label: 'Bank statement export', accept: '.csv,.ofx,.qfx,text/csv' },
  { side: 'ledger', label: 'Cash book export', accept: '.csv,text/csv' },
] as const;

/** A run that hasn't been matched yet: show its files, allow replacing them, and run matching. */
export function DraftPanel({
  run,
  documents,
  membership,
  onChanged,
}: {
  run: RunRow;
  documents: DocumentRow[];
  membership: Membership;
  onChanged: () => Promise<void>;
}) {
  const toast = useToast();
  const id = useId();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const bothUploaded = SIDES.every((s) => documents.some((d) => d.side === s.side));

  const replace = async (side: 'bank' | 'ledger', file: File) => {
    setBusy(`Uploading ${file.name}…`);
    setError(null);
    try {
      const old = documents.find((d) => d.side === side);
      if (old) {
        orThrow(await supabase.from('documents').delete().eq('id', old.id));
        await supabase.storage.from('documents').remove([old.storage_path]);
      }
      const ext = file.name.split('.').pop()?.toLowerCase() ?? 'csv';
      const path = `${membership.orgId}/${run.id}/${side}-${Date.now()}.${ext}`;
      const up = await supabase.storage.from('documents').upload(path, file, { contentType: file.type || 'text/csv' });
      if (up.error) throw new Error(up.error.message);
      const { data: userData } = await supabase.auth.getUser();
      orThrow(
        await supabase
          .from('documents')
          .insert({ org_id: membership.orgId, run_id: run.id, side, storage_path: path, filename: file.name, uploaded_by: userData.user!.id }),
      );
      await onChanged();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const match = async () => {
    if (!bothUploaded || busy) return;
    setBusy('Matching…');
    setError(null);
    try {
      await callFunction('run-matching', { runId: run.id });
      toast('Matching done. Review the exceptions.');
      await onChanged();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="card">
      <h2>Not matched yet</h2>
      <p className="small muted" style={{ marginTop: 6 }}>
        Opening balances: bank {formatRand(Number(run.opening_bank))} · cash book {formatRand(Number(run.opening_ledger))}
      </p>
      {SIDES.map((s) => {
        const doc = documents.find((d) => d.side === s.side);
        return (
          <div className="field" key={s.side}>
            <label htmlFor={`${id}-${s.side}`}>
              {s.label}: {doc ? <b>{doc.filename}</b> : <span className="muted">not uploaded</span>}
            </label>
            <input
              id={`${id}-${s.side}`}
              type="file"
              accept={s.accept}
              disabled={!!busy}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void replace(s.side, f);
                e.target.value = '';
              }}
            />
            <p className="hint">{doc ? 'Choose a file to replace it.' : 'Choose the file to upload.'}</p>
          </div>
        );
      })}
      {error && (
        <p className="err-box" role="alert">
          {error}
        </p>
      )}
      <div className="actions">
        <button type="button" className="btn btn-primary" aria-disabled={!bothUploaded || !!busy ? 'true' : undefined} onClick={match}>
          {busy ?? 'Run matching'}
        </button>
        {!bothUploaded && <span className="small muted">Upload both files first.</span>}
      </div>
    </section>
  );
}
