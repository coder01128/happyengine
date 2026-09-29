// The value-in-quote check: the value an extractor reports must appear in the wording it cited. It catches a
// real quote attached to a wrong value. The text checked is the page text the quote matched, not the quote
// as the extractor wrote it, so a quote that was wrong in one number can't vouch for a value that agrees with it.

import { centsIn, datesIn, numbersIn } from '../../documents/src/index.ts';
import type { CandidateValue, FieldKey } from './types.ts';

/** skipped: nothing to check (text fields, "not stated", "blank", a fee given as words). */
export type ValueCheck = 'passed' | 'failed' | 'skipped';

const outcome = (ok: boolean): ValueCheck => (ok ? 'passed' : 'failed');
/** The value as a plain record, or undefined when it isn't an object. */
const obj = (v: unknown): Record<string, unknown> | undefined => (typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : undefined);

/** A count of months may be written as years: 36 months as "three (3) years". */
function months(n: number, found: number[]): boolean {
  return found.includes(n) || (n % 12 === 0 && found.includes(n / 12));
}

export function checkValue(key: FieldKey, value: CandidateValue, text: string): ValueCheck {
  if (value === 'not_stated' || value === 'blank') return 'skipped';
  const o = obj(value);
  switch (key) {
    case 'startDate':
    case 'endDate':
      return typeof value === 'string' ? outcome(datesIn(text).includes(value)) : 'skipped';
    case 'termMonths':
      return typeof value === 'number' ? outcome(months(value, numbersIn(text))) : 'skipped';
    case 'renewal':
      return typeof o?.periodMonths === 'number' ? outcome(months(o.periodMonths, numbersIn(text))) : 'skipped';
    case 'notice':
      return typeof o?.amount === 'number' ? outcome(o.unit === 'months' ? months(o.amount, numbersIn(text)) : numbersIn(text).includes(o.amount)) : 'skipped';
    case 'fee':
      return typeof o?.cents === 'number' ? outcome(centsIn(text).includes(o.cents)) : 'skipped';
    case 'deposit':
      return typeof value === 'number' ? outcome(centsIn(text).includes(value)) : 'skipped';
    case 'feeChange': {
      if (o?.kind === 'schedule' && Array.isArray(o.steps)) {
        const cents = centsIn(text);
        return outcome((o.steps as number[]).every((s) => cents.includes(s)));
      }
      if (o?.kind === 'percent_escalation' && typeof o.percent === 'number') return outcome(numbersIn(text).includes(o.percent));
      return 'skipped';
    }
    default:
      return 'skipped'; // counterparty, agreementType, premises, scope: text
  }
}
