// Shapes for the Contracts engine: what Claude extracts, and the record code builds from it.

import type { IsoDate } from '../../core/src/index.ts';
import type { GroundingResult } from '../../documents/src/index.ts';
import type { ValueCheck } from './value-check.ts';

export type FieldKey =
  | 'counterparty' | 'agreementType' | 'premises' | 'startDate' | 'endDate' | 'termMonths'
  | 'renewal' | 'notice' | 'fee' | 'feeChange' | 'deposit' | 'scope' | 'agreementCategory';

export interface Notice { amount: number; unit: 'days' | 'months'; before?: 'expiry' | 'renewal' | 'end_of_initial_period' }
export interface Renewal { kind: 'option' | 'automatic' | 'month_to_month' | 'none'; periodMonths?: number }
export type FeeChange =
  | { kind: 'schedule'; steps: number[] }
  | { kind: 'percent_escalation'; percent: number; every: string }
  | { kind: 'unquantified' }
  | { kind: 'none' };
/** One line of a fee: one amount for one charge. `what` names the charge ("rent", "parking bay"); `from` is the date the line starts, only when the wording gives it. */
export interface FeeLine { cents: number; per: string; vat?: VatStatus; what?: string; from?: IsoDate }
/** Whether an amount includes VAT: as the wording says, or 'not_stated' when the document doesn't say. Every amount line carries one. */
export type VatStatus = 'included' | 'excluded' | 'not_stated';
/** A charge stated in words, not as a rand amount ("1.5% of declared value", "at cost"). */
export interface FeeText { text: string; what?: string }
/** One entry of a merged fee: an amount line or a charge in words. */
export type FeeEntry = FeeLine | FeeText;
/** An extractor gives one line, or words. A record with several lines holds them as `{ lines }`, built by code and never by the extractor. */
export type Fee = FeeLine | FeeText | { lines: FeeEntry[] };

/** Text for names and descriptions; ISO date for dates; whole months for termMonths; cents for deposit. */
export type FieldValue = string | number | Notice | Renewal | FeeChange | Fee;
export type CandidateValue = FieldValue | 'not_stated' | 'blank';

/** One place a document states a field's value, as Claude returned it. */
export interface Candidate {
  value: CandidateValue;
  quote: string; // copied character for character from the page
  file: string;
  page: number;
  clause?: string; // as written: "cl. 18.2", "Order form item 4", "Sch. 2"
}

/** An addendum clause that replaces or changes a clause of an earlier document. */
export interface Amendment {
  file: string;
  page: number;
  clause: string;
  quote: string;
  targetClause: string;
  fieldKeys: FieldKey[];
}

export interface Extraction {
  fields: Partial<Record<FieldKey, Candidate[]>>;
  amendments: Amendment[];
}

// ---- the record

export interface Source {
  file: string;
  /** The page the quote was found on. When it isn't found, the page the extractor claimed. */
  page: number;
  /** Set when the quote was found on a different page from the one the extractor claimed. */
  claimedPage?: number;
  clause?: string;
  /** False when the clause number isn't on the cited page: show the page chip only. */
  clauseChecked: boolean;
  quote: string;
  grounding: GroundingResult;
  /** Whether the value appears in the wording the quote matched. Absent for amendments. */
  valueCheck?: ValueCheck;
}

export interface RecordCandidate extends Source {
  value: CandidateValue;
  /** Set when an applied amendment replaced this clause. */
  superseded?: { file: string; page: number; clause?: string };
}

export type FieldStatus = 'recorded' | 'not_stated' | 'blank' | 'conflict' | 'not_verified';

export interface RecordField {
  key: FieldKey;
  label: string;
  status: FieldStatus;
  /** The current value. Absent while in conflict or not verified. */
  value?: CandidateValue;
  candidates: RecordCandidate[];
  /** Index into candidates of the candidate the current value comes from. */
  current?: number;
  /** Calculated by code (e.g. end date from start + term), with the sources it came from. */
  derived?: { rule: string; from: FieldKey[]; sources: Source[] };
  /** Set by a review decision on this field. */
  decided?: { outcome: 'reviewed' | 'with_legal'; chosenValueIndex?: number };
}

export type ReviewKind = 'blank' | 'conflict' | 'not_verified' | 'unclear';

export interface ReviewItem {
  /** Stable id: `${kind}:${fieldKey}`, or `unclear:amendment:${n}`. */
  id: string;
  kind: ReviewKind;
  fieldKey: FieldKey | 'amendment';
  summary: string;
  sources: Source[];
  /** For conflicts: the candidate values in the same order as sources, so a reviewer can choose one. */
  values?: CandidateValue[];
  decision?: Decision;
}

export interface Decision {
  itemId: string;
  optionId: string;
  /** Index into the item's sources/values. Required when a conflict is decided as reviewed. */
  chosenValueIndex?: number;
  note?: string;
}

export type KeyDateKey =
  | 'expiry' | 'renewal' | 'end_of_initial_period'
  | 'renewal_notice' | 'notice' | 'cancellation_deadline' | 'termination_notice';

export interface KeyDate {
  key: KeyDateKey;
  label: string;
  /** Null while pending; pendingReason says why. */
  date: IsoDate | null;
  pendingReason?: string;
  /** What happens on the date, for the register and the reminder draft. */
  what: string;
  tags: string[];
  derivation: {
    base?: { label: string; date: IsoDate | null; sources: Source[] };
    /** "− 3 calendar months", "− 60 days", "+ 1 day", or "" for the base date itself. */
    rule: string;
    /** The notice wording the rule comes from. */
    wording?: string;
    noticeSource?: Source;
  };
  /** The clause the date comes from, for chips and reminders ("Add. 1 cl. 2"). */
  clause?: string;
}

export type AgreementStatus = 'ready' | 'flagged' | 'reviewed' | 'with_legal';

export interface AgreementRecord {
  id: string;
  ref: string;
  files: string[];
  fields: Partial<Record<FieldKey, RecordField>>;
  amendments: (Amendment & { applied: boolean; grounding: GroundingResult })[];
  reviewItems: ReviewItem[];
  keyDates: KeyDate[];
  tags: string[];
  status: AgreementStatus;
}
