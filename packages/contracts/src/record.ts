// Parsed pages + an extraction → an agreement record: every quote grounded, rules applied, key dates
// calculated. Pure code: no database, no network. The AI states what the documents say; this decides
// what is flagged for review and calculates every date.

import { addDays, addMonths, type IsoDate } from '../../core/src/index.ts';
import { BLANK, ground, normalise, type GroundingResult, type ParsedDocument, type ParsedPage } from '../../documents/src/index.ts';
import type { ContractsPreset } from './preset.ts';
import type {
  AgreementRecord, AgreementStatus, Candidate, CandidateValue, Decision, Extraction, FieldKey, KeyDate,
  Notice, RecordCandidate, RecordField, Renewal, ReviewItem, Source,
} from './types.ts';

export interface BuildInput {
  id?: string;
  ref?: string;
  /** In order: main agreement first, then addenda in date order. */
  files: string[];
  parsed: Record<string, ParsedDocument>;
  extraction: Extraction;
  preset: ContractsPreset;
}

const PENDING_REVIEW = 'Pending review';
const WITH_LEGAL = 'With legal';

// ---------------------------------------------------------------------------
// Clause labels and values
// ---------------------------------------------------------------------------

/** The clause number in a label: "cl. 18.2" → "18.2", "Add. 1 cl. 2" → "2", "Sch. 2" → "2". */
export function clauseNumber(label: string | undefined): string | undefined {
  const all = label?.match(/\d+(?:\.\d+)*/g);
  return all?.[all.length - 1];
}

function numberInText(num: string, text: string): boolean {
  const escaped = num.replace(/\./g, '\\.');
  return new RegExp(`(?<![\\d.])${escaped}(?!\\.?\\d)`).test(text);
}

function canonical(v: unknown): string {
  if (typeof v === 'string') return JSON.stringify(v.trim().replace(/\s+/g, ' ').toLowerCase());
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v)
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v);
}

/** Two values are the same after normalising text (case, spacing) and key order. */
export function sameValue(a: CandidateValue, b: CandidateValue): boolean {
  return canonical(a) === canonical(b);
}

// ---------------------------------------------------------------------------
// Grounding
// ---------------------------------------------------------------------------

function findPage(parsed: Record<string, ParsedDocument>, file: string, page: number): ParsedPage | undefined {
  return parsed[file]?.pages.find((p) => p.page === page);
}

function groundSource(c: { quote: string; file: string; page: number; clause?: string }, parsed: Record<string, ParsedDocument>, minScore: number): Source {
  const page = findPage(parsed, c.file, c.page);
  const grounding: GroundingResult = page ? ground(c.quote, page, minScore) : { status: 'not_found', score: 0, page: c.page, boxes: [] };
  const num = clauseNumber(c.clause);
  return {
    file: c.file,
    page: c.page,
    ...(c.clause ? { clause: c.clause } : {}),
    clauseChecked: !!(page && num && numberInText(num, page.text)),
    quote: c.quote,
    grounding,
  };
}

/** The page text a grounded source matched. */
function matchedText(s: Source, parsed: Record<string, ParsedDocument>): string {
  const page = findPage(parsed, s.file, s.page);
  return page && s.grounding.start !== undefined ? page.text.slice(s.grounding.start, s.grounding.end) : '';
}

const isGrounded = (s: Source) => s.grounding.status === 'grounded';
const toSource = ({ file, page, clause, clauseChecked, quote, grounding }: RecordCandidate): Source => ({
  file, page, ...(clause ? { clause } : {}), clauseChecked, quote, grounding,
});

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

interface Resolved {
  field: RecordField;
  items: ReviewItem[];
}

/** Applies the rules to one field's candidates, in the brief's order. */
function resolveField(key: FieldKey, label: string, candidates: RecordCandidate[], parsed: Record<string, ParsedDocument>, required: boolean): Resolved {
  const field: RecordField = { key, label, status: 'recorded', candidates };
  const items: ReviewItem[] = [];
  const active = candidates.map((c, i) => ({ c, i })).filter(({ c }) => isGrounded(c) && !c.superseded);

  if (!active.length) {
    field.status = 'not_verified';
    items.push({ id: `not_verified:${key}`, kind: 'not_verified', fieldKey: key, summary: `${label}: the quoted wording was not found on its page`, sources: candidates.map(toSource) });
    return { field, items };
  }

  const valued = active.filter(({ c }) => c.value !== 'not_stated');
  if (!valued.length) {
    field.status = 'not_stated';
    field.value = 'not_stated';
    field.current = active[0]!.i;
    if (required) items.push({ id: `unclear:${key}`, kind: 'unclear', fieldKey: key, summary: `${label} not stated`, sources: active.map(({ c }) => toSource(c)) });
    return { field, items };
  }

  const distinct = valued.filter(({ c }, n) => valued.findIndex((o) => sameValue(o.c.value, c.value)) === n);
  if (distinct.length > 1) {
    field.status = 'conflict';
    items.push({
      id: `conflict:${key}`,
      kind: 'conflict',
      fieldKey: key,
      summary: `Conflicting ${label.toLowerCase()} wording`,
      sources: valued.map(({ c }) => toSource(c)),
      values: valued.map(({ c }) => c.value),
    });
    return { field, items };
  }

  const first = valued[0]!;
  field.current = first.i;
  if (first.c.value === 'blank') {
    // A blank is only confirmed when the matched page text really has a blank line in it.
    if (normalise(matchedText(first.c, parsed)).text.includes(BLANK)) {
      field.status = 'blank';
      field.value = 'blank';
      items.push({ id: `blank:${key}`, kind: 'blank', fieldKey: key, summary: `${label} not stated — blank in signed copy`, sources: [toSource(first.c)] });
    } else {
      field.status = 'not_verified';
      delete field.current;
      items.push({ id: `not_verified:${key}`, kind: 'not_verified', fieldKey: key, summary: `${label}: recorded as blank, but no blank line was found in the quoted wording`, sources: [toSource(first.c)] });
    }
    return { field, items };
  }

  field.value = first.c.value;
  if (key === 'feeChange' && typeof first.c.value === 'object' && (first.c.value as { kind?: string }).kind === 'unquantified') {
    items.push({ id: 'unclear:feeChange', kind: 'unclear', fieldKey: key, summary: 'Fee change not quantified', sources: valued.map(({ c }) => toSource(c)) });
  }
  return { field, items };
}

// ---------------------------------------------------------------------------
// Key dates
// ---------------------------------------------------------------------------

type State<T> = { state: 'known'; value: T; sources: Source[]; clause?: string } | { state: 'pending'; reason: string } | { state: 'absent' };

function currentSources(f: RecordField): Source[] {
  if (f.derived) return f.derived.sources;
  if (f.current !== undefined) return [toSource(f.candidates[f.current]!)];
  return [];
}

/** Whether a field can feed a date: known, pending review (or with legal), or absent. A blank is absent: no date comes from it. */
function stateOf<T>(f: RecordField | undefined): State<T> {
  if (!f || f.status === 'not_stated' || f.status === 'blank') return { state: 'absent' };
  if (f.decided?.outcome === 'with_legal') return { state: 'pending', reason: WITH_LEGAL };
  if (f.status === 'conflict' || f.status === 'not_verified') return { state: 'pending', reason: PENDING_REVIEW };
  const sources = currentSources(f);
  return { state: 'known', value: f.value as T, sources, clause: sources[0]?.clause };
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function noticeRule(n: Notice): string {
  return n.unit === 'months' ? `− ${plural(n.amount, 'calendar month', 'calendar months')}` : `− ${plural(n.amount, 'day', 'days')}`;
}

function subtract(date: IsoDate, n: Notice): IsoDate {
  return n.unit === 'months' ? addMonths(date, -n.amount) : addDays(date, -n.amount);
}

function keyDates(fields: AgreementRecord['fields']): KeyDate[] {
  const dates: KeyDate[] = [];
  const end = stateOf<IsoDate>(fields.endDate);
  const renewal = stateOf<Renewal>(fields.renewal);
  const notice = stateOf<Notice>(fields.notice);

  // The base date the term ends on, and what it is called.
  let base: { key: KeyDate['key']; label: string; what: string; date: IsoDate | null; pendingReason?: string; plusDay: boolean } | null = null;
  if (end.state !== 'absent') {
    const kind = renewal.state === 'known' ? renewal.value.kind : undefined;
    if (renewal.state === 'pending') base = { key: 'expiry', label: 'Expiry', what: 'The term ends.', date: null, pendingReason: renewal.reason, plusDay: false };
    else if (kind === 'automatic') {
      const months = renewal.state === 'known' ? renewal.value.periodMonths : undefined;
      base = { key: 'renewal', label: 'Renewal date', what: months ? `Renews automatically for ${plural(months, 'month', 'months')}.` : 'Renews automatically.', date: null, plusDay: true };
    } else if (kind === 'month_to_month') {
      base = { key: 'end_of_initial_period', label: 'End of initial period', what: 'The initial period ends; the agreement continues month to month.', date: null, plusDay: false };
    } else base = { key: 'expiry', label: 'Expiry', what: 'The term ends.', date: null, plusDay: false };

    if (end.state === 'known' && !base.pendingReason) base.date = base.plusDay ? addDays(end.value, 1) : end.value;
    else base.pendingReason ??= end.state === 'pending' ? end.reason : PENDING_REVIEW;

    dates.push({
      key: base.key,
      label: base.label,
      date: base.date,
      ...(base.date ? {} : { pendingReason: base.pendingReason }),
      what: base.what,
      tags: [],
      derivation: {
        base: { label: 'End date', date: end.state === 'known' ? end.value : null, sources: end.state === 'known' ? end.sources : [] },
        rule: base.plusDay ? '+ 1 day' : '',
      },
      ...(end.state === 'known' && end.clause ? { clause: end.clause } : {}),
    });
  }

  if (notice.state === 'pending') {
    dates.push({ key: 'notice', label: 'Notice deadline', date: null, pendingReason: notice.reason, what: 'Last day for written notice.', tags: ['notice'], derivation: { rule: '' } });
  } else if (notice.state === 'known' && notice.value.before && base) {
    const n = notice.value;
    const source = notice.sources[0];
    const option = renewal.state === 'known' && renewal.value.kind === 'option';
    const spec: Record<NonNullable<Notice['before']>, { key: KeyDate['key']; label: string; what: string }> = {
      expiry: option
        ? { key: 'renewal_notice', label: 'Renewal notice deadline', what: 'Last day for written notice to exercise the renewal option.' }
        : { key: 'notice', label: 'Notice deadline', what: 'Last day for written notice before expiry.' },
      renewal: { key: 'cancellation_deadline', label: 'Cancellation deadline', what: 'Last day for written notice of cancellation before the renewal date.' },
      end_of_initial_period: { key: 'termination_notice', label: 'Termination notice deadline', what: 'Last day for written notice to terminate at the end of the initial period.' },
    };
    const s = spec[n.before!];
    // Renewal-based notice counts back from the renewal date; the others from the end date.
    const from = n.before === 'renewal' ? (end.state === 'known' ? addDays(end.value, 1) : null) : end.state === 'known' ? end.value : null;
    const pendingReason = from ? undefined : end.state === 'pending' ? end.reason : PENDING_REVIEW;
    dates.push({
      key: s.key,
      label: s.label,
      date: from ? subtract(from, n) : null,
      ...(pendingReason ? { pendingReason } : {}),
      what: s.what,
      tags: ['notice'],
      derivation: {
        base: { label: n.before === 'renewal' ? 'Renewal date' : n.before === 'expiry' ? 'Expiry' : 'End of initial period', date: from, sources: end.state === 'known' ? end.sources : [] },
        rule: noticeRule(n),
        wording: source?.quote,
        ...(source ? { noticeSource: source } : {}),
      },
      ...(source?.clause ? { clause: source.clause } : {}),
    });
  }
  return dates;
}

/** "Expiry 31 Jan 2027 − 3 calendar months ('…', Add. 1 cl. 2) = 31 Oct 2026". */
export function describeDerivation(d: KeyDate, formatDate: (d: IsoDate) => string): string {
  const base = d.derivation.base;
  if (!base || !base.date) return d.pendingReason ? `${d.label}: ${d.pendingReason.toLowerCase()}` : d.label;
  if (!d.derivation.rule) return `${d.label} ${formatDate(base.date)}`;
  const wording = d.derivation.wording ? ` ('${d.derivation.wording}'${d.derivation.noticeSource?.clause ? `, ${d.derivation.noticeSource.clause}` : ''})` : '';
  const result = d.date ? formatDate(d.date) : d.pendingReason ?? '';
  return `${base.label} ${formatDate(base.date)} ${d.derivation.rule}${wording} = ${result}`;
}

// ---------------------------------------------------------------------------
// Record
// ---------------------------------------------------------------------------

function deriveEndDate(fields: AgreementRecord['fields']): void {
  const end = fields.endDate;
  if (end && end.status !== 'not_stated') return; // stated (or flagged) end date wins
  const start = stateOf<IsoDate>(fields.startDate);
  const term = stateOf<number>(fields.termMonths);
  if (start.state !== 'known' || term.state !== 'known' || typeof term.value !== 'number') return;
  fields.endDate = {
    key: 'endDate',
    label: end?.label ?? 'End',
    status: 'recorded',
    value: addDays(addMonths(start.value, term.value), -1),
    candidates: end?.candidates ?? [],
    derived: { rule: 'start + term − 1 day', from: ['startDate', 'termMonths'], sources: [...start.sources, ...term.sources] },
  };
}

function recordTags(fields: AgreementRecord['fields']): string[] {
  const tags: string[] = [];
  const renewal = fields.renewal?.status === 'recorded' ? (fields.renewal.value as Renewal) : undefined;
  if (renewal && (renewal.kind === 'automatic' || renewal.kind === 'month_to_month')) tags.push('auto');
  const change = fields.feeChange?.status === 'recorded' ? (fields.feeChange.value as { kind?: string }) : undefined;
  if (change?.kind && change.kind !== 'none') tags.push('fee-change');
  if (change?.kind === 'unquantified') tags.push('unquantified');
  return tags;
}

function statusOf(items: ReviewItem[]): AgreementStatus {
  return items.length === 0 ? 'ready' : items.every((i) => i.decision) ? 'reviewed' : 'flagged';
}

/** Recalculates what depends on the fields: derived end date, key dates, tags, status. */
function finish(record: AgreementRecord, preset: ContractsPreset): AgreementRecord {
  deriveEndDate(record.fields);
  record.keyDates = keyDates(record.fields);
  const noticeTagged = record.keyDates.some((d) => d.tags.includes('notice'));
  record.tags = [...recordTags(record.fields), ...(noticeTagged ? ['notice'] : [])];
  const legal = new Set(preset.reviewOptions.filter((o) => o.outcome === 'with_legal').map((o) => o.id));
  if (record.reviewItems.some((i) => i.decision && legal.has(i.decision.optionId))) record.status = 'with_legal';
  else record.status = statusOf(record.reviewItems);
  return record;
}

export function buildRecord(input: BuildInput): AgreementRecord {
  const { files, parsed, extraction, preset } = input;
  const minScore = preset.grounding.minScore;
  const labels = new Map(preset.fields.map((f) => [f.key, f]));

  const candidates = new Map<FieldKey, RecordCandidate[]>();
  for (const [key, list] of Object.entries(extraction.fields) as [FieldKey, Candidate[]][]) {
    if (list?.length) candidates.set(key, list.map((c) => ({ ...groundSource(c, parsed, minScore), value: c.value })));
  }

  // Amendments: applied only when the addendum quote is grounded and the target clause is in an earlier file.
  const reviewItems: ReviewItem[] = [];
  const amendments = extraction.amendments.map((a, n) => {
    const source = groundSource(a, parsed, minScore);
    const target = clauseNumber(a.targetClause);
    const earlier = files.slice(0, Math.max(0, files.indexOf(a.file)));
    const targetFound = !!target && earlier.some((f) => parsed[f]?.pages.some((p) => numberInText(target, p.text)));
    const applied = isGrounded(source) && targetFound;
    if (applied) {
      for (const key of a.fieldKeys) {
        for (const c of candidates.get(key) ?? []) {
          if (c.file !== a.file && clauseNumber(c.clause) === target) c.superseded = { file: a.file, page: a.page, clause: a.clause };
        }
      }
    } else {
      reviewItems.push({
        id: `unclear:amendment:${n}`,
        kind: 'unclear',
        fieldKey: 'amendment',
        summary: isGrounded(source) ? 'Amendment target not found' : 'Amendment wording not found on its page',
        sources: [source],
      });
    }
    return { ...a, applied, grounding: source.grounding };
  });

  const fields: AgreementRecord['fields'] = {};
  const fieldOrder = [...preset.fields.map((f) => f.key as FieldKey), ...[...candidates.keys()].filter((k) => !labels.has(k))];
  for (const key of fieldOrder) {
    const list = candidates.get(key);
    if (!list) continue;
    const spec = labels.get(key);
    const { field, items } = resolveField(key, spec?.label ?? key, list, parsed, spec?.required ?? false);
    fields[key] = field;
    reviewItems.push(...items);
  }

  const record: AgreementRecord = {
    id: input.id ?? files[0] ?? '',
    ref: input.ref ?? '',
    files,
    fields,
    amendments,
    reviewItems,
    keyDates: [],
    tags: [],
    status: 'ready',
  };
  return finish(record, preset);
}

// ---------------------------------------------------------------------------
// Review decisions
// ---------------------------------------------------------------------------

/**
 * Recomputes a record after review. A conflict decided as reviewed must say which candidate to record
 * (chosenValueIndex into the item's values); that value becomes current and dependent dates are
 * calculated. Referred to legal: dependent dates stay pending, "With legal". "Confirm recorded value"
 * (singleValueOnly) can't be used on a conflict.
 */
export function applyDecisions(record: AgreementRecord, decisions: Decision[], preset: ContractsPreset): AgreementRecord {
  const next: AgreementRecord = structuredClone(record);
  // The derived end date is recalculated from the decided fields: put back what was extracted.
  const end = next.fields.endDate;
  if (end?.derived) {
    if (end.candidates.length) next.fields.endDate = { key: 'endDate', label: end.label, status: 'not_stated', value: 'not_stated', candidates: end.candidates, current: 0 };
    else delete next.fields.endDate;
  }

  for (const d of decisions) {
    const item = next.reviewItems.find((i) => i.id === d.itemId);
    if (!item) throw new Error(`No review item ${d.itemId}`);
    const option = preset.reviewOptions.find((o) => o.id === d.optionId);
    if (!option) throw new Error(`Unknown review option "${d.optionId}"`);
    if (option.singleValueOnly && item.kind === 'conflict') {
      throw new Error(`"${option.label}" is only for items with a single recorded value; choose which clause to record first`);
    }
    if (item.kind === 'conflict' && option.outcome === 'reviewed' && d.chosenValueIndex === undefined) {
      throw new Error('A conflict needs chosenValueIndex: which clause’s value to record');
    }
    if (d.chosenValueIndex !== undefined && (item.kind !== 'conflict' || !item.values || d.chosenValueIndex < 0 || d.chosenValueIndex >= item.values.length)) {
      throw new Error(`chosenValueIndex ${d.chosenValueIndex} doesn’t match a value of ${item.id}`);
    }
    item.decision = d;

    if (item.fieldKey === 'amendment') continue;
    const field = next.fields[item.fieldKey];
    if (!field) continue;
    field.decided = { outcome: option.outcome, ...(d.chosenValueIndex !== undefined ? { chosenValueIndex: d.chosenValueIndex } : {}) };
    if (item.kind === 'conflict' && d.chosenValueIndex !== undefined) {
      const chosen = item.sources[d.chosenValueIndex]!;
      field.value = item.values![d.chosenValueIndex]!;
      field.current = field.candidates.findIndex((c) => c.file === chosen.file && c.page === chosen.page && c.quote === chosen.quote);
      field.status = 'recorded';
    } else if (item.kind === 'not_verified' && option.outcome === 'reviewed') {
      // The reviewer checked the wording in the document: the single recorded value stands.
      const only = field.candidates.filter((c) => !c.superseded && c.value !== 'not_stated');
      if (only.length === 1) {
        field.value = only[0]!.value;
        field.current = field.candidates.indexOf(only[0]!);
        field.status = only[0]!.value === 'blank' ? 'blank' : 'recorded';
      }
    }
  }
  return finish(next, preset);
}
