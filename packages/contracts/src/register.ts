// The register across an organisation's agreements, as at a date: rows, the key-date list with
// statuses, and the preset searches. Statuses depend on asAt; nothing else does.

import { addDays, dayNumber, formatDate, formatRand, type IsoDate } from '../../core/src/index.ts';
import type { ContractsPreset } from './preset.ts';
import type {
  AgreementRecord, AgreementStatus, CandidateValue, Fee, FeeChange, FieldKey, KeyDate, Notice, RecordField, Renewal, ReviewItem,
} from './types.ts';

export type DateStatus = 'passed' | 'attention' | 'upcoming' | 'later';

/** passed: before asAt · attention: 0 to `attention` days away · upcoming: up to `upcoming` days · later. */
export function dateStatus(date: IsoDate, asAt: IsoDate, windows: ContractsPreset['alertWindows']): DateStatus {
  const days = dayNumber(date) - dayNumber(asAt);
  if (days < 0) return 'passed';
  if (days <= windows.attention) return 'attention';
  if (days <= windows.upcoming) return 'upcoming';
  return 'later';
}

export interface RegisterKeyDate extends KeyDate {
  agreementId: string;
  ref: string;
  counterparty: string;
  type: string;
  /** Null while the date is pending. */
  status: DateStatus | null;
  days: number | null;
}

export interface RegisterRow {
  id: string;
  ref: string;
  counterparty: string;
  type: string;
  start: string;
  endOrTerm: string;
  renewal: string;
  notice: string;
  fee: string;
  nextKeyDate?: RegisterKeyDate;
  status: AgreementStatus;
  openItems: number;
  tags: string[];
  record: AgreementRecord;
}

export interface Register {
  asAt: IsoDate;
  rows: RegisterRow[];
  /** Sorted by date; pending dates last. */
  keyDates: RegisterKeyDate[];
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function valueText(key: FieldKey, v: CandidateValue): string {
  if (v === 'not_stated') return 'Not stated';
  if (v === 'blank') return 'Not stated (blank in signed copy)';
  switch (key) {
    case 'startDate':
    case 'endDate':
      return formatDate(v as string);
    case 'termMonths':
      return plural(v as number, 'month', 'months');
    case 'deposit':
      return formatRand(v as number);
    case 'renewal': {
      const r = v as Renewal;
      const period = r.periodMonths ? `, ${plural(r.periodMonths, 'month', 'months')}` : '';
      return { option: `Option to renew${period}`, automatic: `Renews automatically${period}`, month_to_month: 'Continues month to month', none: 'No renewal' }[r.kind];
    }
    case 'notice': {
      const n = v as Notice;
      const amount = n.unit === 'months' ? plural(n.amount, 'calendar month', 'calendar months') : plural(n.amount, 'day', 'days');
      const before = { expiry: ' before expiry', renewal: ' before the renewal date', end_of_initial_period: ' before the end of the initial period' };
      return amount + (n.before ? before[n.before] : '');
    }
    case 'fee': {
      const f = v as Fee;
      if ('text' in f) return f.text;
      return `${formatRand(f.cents)} per ${f.per}${f.vat === 'excluded' ? ' excl. VAT' : f.vat === 'included' ? ' incl. VAT' : ''}`;
    }
    case 'feeChange': {
      const c = v as FeeChange;
      if (c.kind === 'schedule') return `Stepped: ${c.steps.map((s) => formatRand(s)).join(' · ')}`;
      if (c.kind === 'percent_escalation') return `${c.percent}% escalation each ${c.every}`;
      return c.kind === 'unquantified' ? 'Not quantified — up for review' : 'No change stated';
    }
    default:
      return String(v);
  }
}

/** How a field shows in the register. */
export function fieldText(f: RecordField | undefined): string {
  if (!f) return '';
  if (f.status === 'conflict') return 'Conflicting wording — up for review';
  if (f.status === 'not_verified') return 'Not verified — review';
  return f.value === undefined ? '' : valueText(f.key, f.value);
}

const text = (f: RecordField | undefined) => (f?.status === 'recorded' && typeof f.value === 'string' ? f.value : '');

function datesOf(r: AgreementRecord, asAt: IsoDate, preset: ContractsPreset): RegisterKeyDate[] {
  return r.keyDates.map((d) => ({
    ...d,
    agreementId: r.id,
    ref: r.ref,
    counterparty: text(r.fields.counterparty),
    type: text(r.fields.agreementType),
    status: d.date ? dateStatus(d.date, asAt, preset.alertWindows) : null,
    days: d.date ? dayNumber(d.date) - dayNumber(asAt) : null,
  }));
}

const byDate = (a: RegisterKeyDate, b: RegisterKeyDate) =>
  a.date === b.date ? a.ref.localeCompare(b.ref) : a.date === null ? 1 : b.date === null ? -1 : a.date < b.date ? -1 : 1;

export function register(records: AgreementRecord[], asAt: IsoDate, preset: ContractsPreset): Register {
  const rows = records.map((r): RegisterRow => {
    const dates = datesOf(r, asAt, preset).sort(byDate);
    const end = r.fields.endDate;
    return {
      id: r.id,
      ref: r.ref,
      counterparty: text(r.fields.counterparty),
      type: text(r.fields.agreementType),
      start: fieldText(r.fields.startDate),
      endOrTerm: end ? fieldText(end) : fieldText(r.fields.termMonths),
      renewal: fieldText(r.fields.renewal),
      notice: fieldText(r.fields.notice),
      fee: fieldText(r.fields.fee),
      nextKeyDate: dates.find((d) => d.status && d.status !== 'passed'),
      status: r.status,
      openItems: r.reviewItems.filter((i) => !i.decision).length,
      tags: r.tags,
      record: r,
    };
  });
  return { asAt, rows, keyDates: records.flatMap((r) => datesOf(r, asAt, preset)).sort(byDate) };
}

// ---------------------------------------------------------------------------
// Preset searches: fixed filters over recorded fields, not free-form questions.
// ---------------------------------------------------------------------------

export interface PresetSearchResult {
  id: string;
  question: string;
  /** One line built from the data. */
  answer: string;
  rows: RegisterRow[];
  /** datesBefore: the matching dates, and those already passed (listed separately). */
  dates?: RegisterKeyDate[];
  alreadyPassed?: RegisterKeyDate[];
  /** review: the open review items, with their agreement. */
  items?: (ReviewItem & { ref: string; agreementId: string })[];
}

export function presetSearch(id: string, reg: Register, asAt: IsoDate, preset: ContractsPreset): PresetSearchResult {
  const search = preset.presetSearches.find((s) => s.id === id);
  if (!search) throw new Error(`No preset search "${id}"`);

  if (search.kind === 'datesBefore') {
    const before = addDays(asAt, search.beforeDays ?? 0);
    const tagged = reg.keyDates.filter((d) => d.date && (!search.tag || d.tags.includes(search.tag)));
    const dates = tagged.filter((d) => d.date! >= asAt && d.date! <= before);
    const alreadyPassed = tagged.filter((d) => d.date! < asAt);
    const label = search.tag === 'notice' ? ['notice deadline falls', 'notice deadlines fall'] : ['date falls', 'dates fall'];
    return {
      id,
      question: search.question.replace('{before}', formatDate(before)),
      answer: `${dates.length} ${dates.length === 1 ? label[0] : label[1]} on or before ${formatDate(before)}`,
      rows: reg.rows.filter((r) => dates.some((d) => d.agreementId === r.id)),
      dates,
      alreadyPassed,
    };
  }

  if (search.kind === 'review') {
    const items = reg.rows.flatMap((r) => r.record.reviewItems.filter((i) => !i.decision).map((i) => ({ ...i, ref: r.ref, agreementId: r.id })));
    return {
      id,
      question: search.question,
      answer: `${items.length} ${items.length === 1 ? 'term is' : 'terms are'} up for review`,
      rows: reg.rows.filter((r) => items.some((i) => i.agreementId === r.id)),
      items,
    };
  }

  const rows = reg.rows.filter((r) => r.tags.includes(search.tag ?? ''));
  const n = rows.length;
  const answers: Record<string, string> = {
    auto: `${plural(n, 'agreement renews', 'agreements renew')} or ${n === 1 ? 'continues' : 'continue'} automatically`,
    'fee-change': `${plural(n, 'fee changes', 'fees change')} during the term or on renewal`,
  };
  return { id, question: search.question, answer: answers[search.tag ?? ''] ?? `${plural(n, 'agreement', 'agreements')} match`, rows };
}
