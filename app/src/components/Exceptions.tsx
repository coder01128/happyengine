import { formatDate, formatRand, optionsFor, type Line, type MatchException, type MonthEndPreset, type RunState } from '@happy/engine';
import { useEffect, useId, useRef, useState } from 'react';
import { EXCEPTION_LABEL, effectText } from '../labels.ts';
import { orThrow, supabase } from '../supabase.ts';
import { Modal } from './Modal.tsx';
import { Badge, useToast } from './ui.tsx';

export interface SourceTarget {
  exception?: MatchException;
  bankIds: string[];
  ledgerIds: string[];
  title: string;
}

/** Every line an exception refers to, on each side. */
export function linesOf(e: MatchException) {
  return {
    bankIds: e.bankId ? [e.bankId] : [],
    ledgerIds: [...(e.ledgerId ? [e.ledgerId] : []), ...(e.ledgerIds ?? []), ...(e.duplicateOf ? [e.duplicateOf] : [])],
  };
}

const REVIEWED = new Set(['suggested_match', 'suggested_split', 'amount_difference', 'possible_duplicate', 'not_on_statement']);

export function ExceptionItem({
  exception: e,
  state,
  preset,
  editable,
  onShowSource,
  onChanged,
}: {
  exception: MatchException;
  state: RunState;
  preset: MonthEndPreset;
  editable: boolean;
  onShowSource: (t: SourceTarget) => void;
  onChanged: () => Promise<void>;
}) {
  const find = (lines: Line[], id?: string) => lines.find((l) => l.id === id);
  const bank = find(state.bank, e.bankId);
  const ledgerLines = linesOf(e).ledgerIds.map((id) => find(state.ledger, id)!).filter(Boolean);
  const primary = bank ?? ledgerLines[0];
  const label = EXCEPTION_LABEL[e.type];
  const shownAmount = e.type === 'amount_difference' ? (bank?.amount ?? e.amount) : e.type === 'not_in_ledger' || !bank ? (primary?.amount ?? e.amount) : bank.amount;

  return (
    <li>
      <div className="ex-row">
        <div>
          <div className="ex-top">
            <Badge {...label} />
            {primary && <span>{formatDate(primary.date)}</span>}
            {primary?.reference && <span>{primary.reference}</span>}
          </div>
          <p className="ex-desc">{primary?.description || '(no description)'}</p>
          {bank && ledgerLines.length > 0 && e.type !== 'possible_duplicate' && (
            <p className="small muted">
              Cash book: {ledgerLines.map((l) => `${l.description} ${formatRand(l.amount)}`).join(' + ')}
            </p>
          )}
          <p className="ex-reason">{e.reason}</p>
        </div>
        <div className="ex-side">
          <span className="amt">{formatRand(shownAmount)}</span>
          <button
            type="button"
            className="link-btn"
            onClick={() => onShowSource({ exception: e, ...linesOf(e), title: label.text })}
          >
            View source
          </button>
        </div>
        {REVIEWED.has(e.type) && <Decision e={e} state={state} preset={preset} editable={editable} onChanged={onChanged} />}
        {e.type === 'not_in_ledger' && <Journal e={e} state={state} editable={editable} onChanged={onChanged} />}
        {e.type === 'timing' && (
          <div className="ex-review small">
            Carried as {e.timingKind === 'deposit_in_transit' ? 'a deposit in transit' : 'an outstanding payment'}; expected on the next statement.
          </div>
        )}
      </div>
    </li>
  );
}

function Decision({
  e,
  state,
  preset,
  editable,
  onChanged,
}: {
  e: MatchException;
  state: RunState;
  preset: MonthEndPreset;
  editable: boolean;
  onChanged: () => Promise<void>;
}) {
  const toast = useToast();
  const id = useId();
  const saved = state.decisions[e.id];
  const [optionId, setOptionId] = useState(saved?.optionId ?? '');
  const [note, setNote] = useState(saved?.note ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setOptionId(saved?.optionId ?? '');
    setNote(saved?.note ?? '');
  }, [saved?.optionId, saved?.note]);

  const options = optionsFor(preset, e, state.bank, state.ledger);
  const chosen = options.find((o) => o.id === optionId);
  const savedOption = options.find((o) => o.id === saved?.optionId);
  const ledgerAmount = state.ledger.find((l) => l.id === e.ledgerId)?.amount;
  const noteMissing = !!chosen?.noteRequired && !note.trim();
  const changed = optionId !== (saved?.optionId ?? '') || note.trim() !== (saved?.note ?? '');

  if (!editable) {
    return (
      <div className="ex-review small">
        {savedOption ? (
          <>
            <span className="done">Decided:</span> {savedOption.text}
            {saved?.note && ` — “${saved.note}”`}
          </>
        ) : (
          <span className="muted">No decision recorded.</span>
        )}
      </div>
    );
  }

  const save = async () => {
    if (!chosen || noteMissing || !changed || busy) return;
    setBusy(true);
    setError(null);
    try {
      orThrow(
        await supabase.rpc('record_decision', {
          p_exception_id: state.exceptionDbId.get(e.id)!,
          p_option_id: optionId,
          p_note: note.trim() || null,
        }),
      );
      toast('Decision saved.');
      await onChanged();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ex-review">
      {savedOption && !changed && (
        <p className="done small">
          ✓ Decided: {savedOption.text}
          {saved?.note && ` — “${saved.note}”`}
        </p>
      )}
      <div className="field" style={{ marginTop: savedOption && !changed ? 10 : 0 }}>
        <label htmlFor={`${id}-opt`}>Outcome</label>
        <select id={`${id}-opt`} value={optionId} onChange={(ev) => setOptionId(ev.target.value)}>
          <option value="">Choose an outcome…</option>
          {options.map((o) => (
            <option key={o.id} value={o.id}>
              {o.text}
            </option>
          ))}
        </select>
        {chosen && <p className="effect">{effectText(chosen.effect, e, ledgerAmount)}</p>}
      </div>
      {chosen?.noteRequired && (
        <div className="field">
          <label htmlFor={`${id}-note`}>Note (required)</label>
          <textarea id={`${id}-note`} value={note} onChange={(ev) => setNote(ev.target.value)} aria-invalid={noteMissing ? 'true' : undefined} />
        </div>
      )}
      {error && <p className="err">{error}</p>}
      {changed && (
        <div className="actions" style={{ marginTop: 10 }}>
          <button type="button" className="btn btn-sm btn-primary" aria-disabled={!chosen || noteMissing || busy ? 'true' : undefined} onClick={save}>
            {busy ? 'Saving…' : 'Save decision'}
          </button>
          {noteMissing && <span className="small muted">Add a note to save this outcome.</span>}
        </div>
      )}
    </div>
  );
}

function Journal({ e, state, editable, onChanged }: { e: MatchException; state: RunState; editable: boolean; onChanged: () => Promise<void> }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const journal = state.journals.find((j) => j.exceptionId === e.id);
  if (!journal) return null;
  const approved = state.approvedJournalIds.includes(journal.id);

  const approve = async () => {
    if (busy) return;
    setBusy(true);
    try {
      orThrow(await supabase.rpc('approve_journal', { p_journal_id: journal.id }));
      toast('Journal approved. Nothing was posted.');
      await onChanged();
    } catch (err) {
      toast((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ex-review">
      <p className="small">
        Proposed journal: <b>{journal.label}</b> {formatRand(journal.amount)}
      </p>
      {approved ? (
        <p className="done small" style={{ marginTop: 6 }}>
          ✓ Journal approved · not posted
        </p>
      ) : editable ? (
        <div className="actions" style={{ marginTop: 10 }}>
          <button type="button" className="btn btn-sm btn-primary" onClick={approve} aria-disabled={busy ? 'true' : undefined}>
            {busy ? 'Approving…' : 'Approve journal'}
          </button>
        </div>
      ) : (
        <p className="small muted" style={{ marginTop: 6 }}>
          Not approved yet.
        </p>
      )}
    </div>
  );
}

export function MatchedPairs({ state }: { state: RunState }) {
  const [openList, setOpenList] = useState(false);
  const id = useId();
  const byId = (lines: Line[], lid: string) => lines.find((l) => l.id === lid)!;
  return (
    <div className="sec-gap">
      <button type="button" className="toggle" aria-expanded={openList} aria-controls={id} onClick={() => setOpenList(!openList)}>
        <span>
          {state.result.matched.length} matched pairs — {openList ? 'hide' : 'show'}
        </span>
        <span className="chev" aria-hidden="true">
          ›
        </span>
      </button>
      <div id={id} hidden={!openList} className="tbl-card sec-gap">
        <table className="tbl">
          <thead>
            <tr>
              <th>Date</th>
              <th>Statement</th>
              <th>Cash book</th>
              <th className="num">Amount</th>
              <th>Rule</th>
            </tr>
          </thead>
          <tbody>
            {state.result.matched.map((m) => {
              const b = byId(state.bank, m.bankId);
              const l = byId(state.ledger, m.ledgerId);
              return (
                <tr key={`${m.bankId}-${m.ledgerId}`}>
                  <td data-label="Date">{formatDate(b.date)}</td>
                  <td data-label="Statement">{b.description}</td>
                  <td data-label="Cash book">{l.description}</td>
                  <td data-label="Amount" className="num">
                    {formatRand(b.amount)}
                  </td>
                  <td data-label="Rule">
                    <Badge text={`Rule ${m.rule}`} cls="b-ok" />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function SourceTable({ lines, highlight, label }: { lines: Line[]; highlight: Set<string>; label: string }) {
  return (
    <div className="tbl-card">
      <table className="tbl" aria-label={label}>
        <thead>
          <tr>
            <th>Row</th>
            <th>Date</th>
            <th>Description</th>
            <th>Reference</th>
            <th className="num">Amount</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l) => (
            <tr key={l.id} className={highlight.has(l.id) ? 'hl' : undefined} aria-current={highlight.has(l.id) ? 'true' : undefined}>
              <td data-label="Row">{l.id.slice(1)}</td>
              <td data-label="Date">{formatDate(l.date)}</td>
              <td data-label="Description">{l.description}</td>
              <td data-label="Reference">{l.reference || '—'}</td>
              <td data-label="Amount" className="num">
                {formatRand(l.amount)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function SourceModal({ target, state, onClose }: { target: SourceTarget; state: RunState; onClose: () => void }) {
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Bring each highlighted row into view inside its own scrolling table.
    body.current?.querySelectorAll<HTMLElement>('.tbl-card').forEach((card) => {
      const row = card.querySelector<HTMLElement>('tr.hl');
      if (!row) return;
      const offset = row.getBoundingClientRect().top - card.getBoundingClientRect().top;
      card.scrollTop += offset - card.clientHeight / 2 + row.clientHeight / 2;
    });
  }, []);
  const e = target.exception;
  return (
    <Modal title={`Source — ${target.title}`} onClose={onClose}>
      <div ref={body}>
        {e && (
          <div className="doc-ctx">
            <Badge {...EXCEPTION_LABEL[e.type]} />
            <p className="ex-reason">{e.reason}</p>
          </div>
        )}
        <h3 className="src-h">Bank statement{target.bankIds.length ? ` — row ${target.bankIds.map((i) => i.slice(1)).join(', ')} highlighted` : ''}</h3>
        <SourceTable lines={state.bank} highlight={new Set(target.bankIds)} label="Bank statement" />
        <h3 className="src-h">Cash book{target.ledgerIds.length ? ` — row ${target.ledgerIds.map((i) => i.slice(1)).join(', ')} highlighted` : ''}</h3>
        <SourceTable lines={state.ledger} highlight={new Set(target.ledgerIds)} label="Cash book" />
      </div>
    </Modal>
  );
}
