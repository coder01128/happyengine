import {
  approvalStatus,
  formatDate,
  formatRand,
  optionsFor,
  reconcile,
  stateFromRows,
  type ExceptionType,
  type MonthEndPreset,
  type RunRows,
  type RunState,
} from '@happy/engine';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Membership } from '../App.tsx';
import { DraftPanel } from '../components/DraftPanel.tsx';
import { ExceptionItem, MatchedPairs, SourceModal, type SourceTarget } from '../components/Exceptions.tsx';
import { Badge, useToast } from '../components/ui.tsx';
import { CHECK_STATUS, EXCEPTION_LABEL, EXCEPTION_ORDER, RUN_STATUS, formatTimestamp, timelineText } from '../labels.ts';
import { callFunction, orThrow, supabase } from '../supabase.ts';

export interface RunRow {
  id: string;
  org_id: string;
  label: string;
  period_end: string;
  status: 'draft' | 'matched' | 'approved';
  opening_bank: number;
  opening_ledger: number;
  preset_snapshot: MonthEndPreset | null;
  approved_at: string | null;
}
export interface DocumentRow {
  id: string;
  side: 'bank' | 'ledger';
  storage_path: string;
  filename: string;
  uploaded_at: string;
}
interface ChecklistRow {
  item_key: string;
  position: number;
  task: string;
  owner: string;
  due: string;
  status: string;
}
interface TimelineRow {
  id: number;
  at: string;
  actor: string | null;
  event: string;
  detail: Record<string, unknown>;
}

interface Loaded {
  run: RunRow;
  documents: DocumentRow[];
  state: RunState | null;
  checklist: ChecklistRow[];
  timeline: TimelineRow[];
}

async function loadRun(runId: string): Promise<Loaded> {
  const run = orThrow(await supabase.from('runs').select('*').eq('id', runId).single()) as RunRow;
  const all = async <T,>(table: string, order?: string) => {
    let q = supabase.from(table).select('*').eq('run_id', runId);
    if (order) q = q.order(order);
    return orThrow(await q) as T[];
  };
  const [documents, lines, matches, exceptions, parts, journals, decisions, checklist, timeline] = await Promise.all([
    all<DocumentRow>('documents'),
    all<RunRows['lines'][number]>('lines'),
    all<RunRows['matches'][number]>('matches'),
    all<RunRows['exceptions'][number]>('exceptions'),
    all<RunRows['parts'][number]>('exception_parts'),
    all<RunRows['journals'][number]>('journals'),
    all<RunRows['decisions'][number]>('decisions'),
    all<ChecklistRow>('checklist_items', 'position'),
    all<TimelineRow>('timeline_events', 'id'),
  ]);
  const state = run.status === 'draft' ? null : stateFromRows({ lines, matches, exceptions, parts, journals, decisions });
  return { run, documents, state, checklist, timeline };
}

export function RunReview({ runId, membership, userId }: { runId: string; membership: Membership; userId: string }) {
  const [data, setData] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    try {
      setData(await loadRun(runId));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [runId]);
  useEffect(() => {
    void reload();
  }, [reload]);

  if (error) return <p className="err-box">{error}</p>;
  if (!data) return <p className="muted">Loading…</p>;
  const { run } = data;

  return (
    <>
      <div className="page-head">
        <div>
          <a className="link-btn" href="#/">
            ← All reconciliations
          </a>
          <h1 style={{ marginTop: 10 }}>{run.label}</h1>
          <p>
            Period ending {formatDate(run.period_end)}
            {data.state && ` · statement ${data.state.bank.length} lines · cash book ${data.state.ledger.length} entries`}
          </p>
        </div>
        <Badge {...RUN_STATUS[run.status]!} />
      </div>
      {run.status === 'draft' || !data.state || !run.preset_snapshot ? (
        <DraftPanel run={run} documents={data.documents} membership={membership} onChanged={reload} />
      ) : (
        <Review data={data as Loaded & { state: RunState }} membership={membership} userId={userId} onChanged={reload} />
      )}
    </>
  );
}

function Review({
  data,
  membership,
  userId,
  onChanged,
}: {
  data: Loaded & { state: RunState };
  membership: Membership;
  userId: string;
  onChanged: () => Promise<void>;
}) {
  const { run, state } = data;
  const preset = run.preset_snapshot!;
  const toast = useToast();
  const [filter, setFilter] = useState<ExceptionType | 'all'>('all');
  const [source, setSource] = useState<SourceTarget | null>(null);
  const [approving, setApproving] = useState(false);
  const canReview = membership.role !== 'uploader';
  const open = run.status === 'matched';

  const panel = useMemo(
    () =>
      reconcile({
        openingBank: Number(run.opening_bank),
        openingLedger: Number(run.opening_ledger),
        bank: state.bank,
        ledger: state.ledger,
        result: state.result,
        preset,
        decisions: state.decisions,
      }),
    [run, state, preset],
  );
  const status = useMemo(
    () =>
      approvalStatus({
        panel,
        journals: state.journals,
        approvedJournalIds: state.approvedJournalIds,
        result: state.result,
        preset,
        decisions: state.decisions,
      }),
    [panel, state, preset],
  );

  const counts = new Map<ExceptionType, number>();
  for (const e of state.result.exceptions) counts.set(e.type, (counts.get(e.type) ?? 0) + 1);
  const listed = [...state.result.exceptions]
    .filter((e) => filter === 'all' || e.type === filter)
    .sort((a, b) => EXCEPTION_ORDER.indexOf(a.type) - EXCEPTION_ORDER.indexOf(b.type));

  const approve = async () => {
    if (!status.canApprove || !canReview || approving) return;
    setApproving(true);
    try {
      await callFunction('approve-run', { runId: run.id });
      toast('Reconciliation approved. Nothing was posted.');
      await onChanged();
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setApproving(false);
    }
  };

  const done = data.checklist.filter((c) => c.status === 'done').length;
  // Timeline stores option ids; show the same wording the reviewer chose from.
  const optionText = (exceptionId: string, optionId: string) => {
    const e = state.result.exceptions.find((x) => x.id === exceptionId);
    return (e && optionsFor(preset, e, state.bank, state.ledger).find((o) => o.id === optionId)?.text) ?? optionId;
  };

  return (
    <>
      <div className="chips" role="group" aria-label="Filter exceptions">
        <button type="button" className="chip" aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>
          All exceptions · {state.result.exceptions.length}
        </button>
        {EXCEPTION_ORDER.filter((t) => counts.get(t)).map((t) => (
          <button
            key={t}
            type="button"
            className={`chip ${EXCEPTION_LABEL[t].cls}`}
            aria-pressed={filter === t}
            onClick={() => setFilter(filter === t ? 'all' : t)}
          >
            {EXCEPTION_LABEL[t].text} · {counts.get(t)}
          </button>
        ))}
        <span className="chip b-ok" aria-hidden="true" style={{ cursor: 'default' }}>
          Matched · {state.result.matched.length}
        </span>
      </div>

      <div className="rv-grid">
        <div>
          <ul className="group" aria-label="Exceptions">
            {listed.length === 0 && <li className="empty">Nothing in this filter.</li>}
            {listed.map((e) => (
              <ExceptionItem
                key={e.id}
                exception={e}
                state={state}
                preset={preset}
                editable={open && canReview}
                onShowSource={setSource}
                onChanged={onChanged}
              />
            ))}
          </ul>
          <MatchedPairs state={state} />
        </div>

        <div className="side-col">
          <section className="card" aria-labelledby="rec-h">
            <h2 id="rec-h">Reconciliation</h2>
            <p className="small muted">Calculated from the data and saved decisions.</p>
            <dl className="rec">
              <div className="rec-sec">
                <Row label={`Balance per bank statement (${formatDate(run.period_end)})`} v={panel.bankClosing} />
                <Row label="Add: deposits in transit" v={panel.depositsInTransit} />
                <Row label="Less: outstanding payments" v={panel.outstandingPayments} />
                <Row label="Adjusted bank balance" v={panel.adjustedBank} tot />
              </div>
              <div className="rec-sec">
                <Row label={`Balance per cash book (${formatDate(run.period_end)})`} v={panel.ledgerClosing} />
                <Row label="Add: bank credits not yet recorded" v={panel.unrecordedCredits} />
                <Row label="Less: bank debits not yet recorded" v={panel.unrecordedDebits} />
                {panel.ledgerAdjustments !== 0 && <Row label="Reviewer adjustments" v={panel.ledgerAdjustments} />}
                <Row label="Adjusted cash book balance" v={panel.adjustedLedger} tot />
              </div>
            </dl>
            <div className={`rec-diff ${panel.difference === 0 ? 'zero' : 'open'}`}>
              <span>Unexplained difference</span>
              <span className="v">{formatRand(panel.difference)}</span>
            </div>

            <div className="approve-box">
              {run.status === 'approved' ? (
                <>
                  <Badge text="Approved" cls="b-ok" />
                  <p className="helper">
                    Approved {run.approved_at ? formatTimestamp(run.approved_at) : ''}. Nothing was posted. The month stays open until every close task is done.
                  </p>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    className="btn btn-primary"
                    aria-disabled={!status.canApprove || !canReview || approving ? 'true' : undefined}
                    aria-describedby="approve-help"
                    onClick={approve}
                  >
                    {approving ? 'Approving…' : 'Approve reconciliation'}
                  </button>
                  <p id="approve-help" className="helper" aria-live="polite">
                    {canReview ? status.message : 'Only reviewers can approve.'}
                  </p>
                </>
              )}
            </div>
          </section>

          <section className="card" aria-labelledby="ck-h">
            <div className="card-head">
              <div>
                <h2 id="ck-h">Close checklist</h2>
                <p>Configured per organisation</p>
              </div>
              <span className="small">
                <b>{done}</b> of {data.checklist.length} done
              </span>
            </div>
            <div className="prog" aria-hidden="true">
              <i style={{ width: `${data.checklist.length ? (100 * done) / data.checklist.length : 0}%` }} />
            </div>
            <ul className="ck-list">
              {data.checklist.map((c) => (
                <li key={c.item_key}>
                  <span>{c.task}</span>
                  <span className="who">
                    {c.owner} · {c.due}
                  </span>
                  <Badge {...CHECK_STATUS[c.status]!} />
                </li>
              ))}
            </ul>
            <p className="close-note">The month stays open until every task is done and signed off.</p>
          </section>
        </div>
      </div>

      <section className="card sec-gap" aria-labelledby="tl-h">
        <h2 id="tl-h">Record</h2>
        <ol className="timeline">
          {data.timeline.map((t, i) => {
            const text = timelineText(t.event, t.detail as Record<string, never>, optionText);
            return (
              <li key={t.id}>
                <span className="tl-dot" aria-hidden="true">
                  {i + 1}
                </span>
                <div className="tl-top">
                  <span className="tl-label">{text.label}</span>
                  <span className="tl-time">
                    {formatTimestamp(t.at)}
                    {t.actor === userId ? ' · you' : ''}
                  </span>
                </div>
                {text.detail && <p className="tl-detail">{text.detail}</p>}
              </li>
            );
          })}
        </ol>
      </section>

      {source && <SourceModal target={source} state={state} onClose={() => setSource(null)} />}
    </>
  );
}

function Row({ label, v, tot }: { label: string; v: number; tot?: boolean }) {
  return (
    <div className={`rec-row${tot ? ' tot' : ''}`}>
      <dt>{label}</dt>
      <dd>{formatRand(v)}</dd>
    </div>
  );
}
