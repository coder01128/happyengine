// What Claude is asked for: the JSON Schema for the record_extraction tool input, and the instructions.
// Claude states what the documents say. Code decides flags and calculates every date.

import type { FieldKey } from './types.ts';

const NOT_STATED_OR_BLANK = { type: 'string', enum: ['not_stated', 'blank'] };
const text = { type: 'string' };
const isoDate = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'ISO date, YYYY-MM-DD' };

const VALUE_SCHEMAS: Record<FieldKey, object> = {
  counterparty: { ...text, description: 'The other party’s name as written, without "(sample)" or similar markers' },
  agreementType: { ...text, description: 'Short type, e.g. "Office lease", "Software subscription"' },
  premises: text,
  startDate: isoDate,
  endDate: { ...isoDate, description: 'Only an end date the document states. Never calculate one.' },
  termMonths: { type: 'integer', minimum: 1, description: 'The stated term in months (3 years = 36)' },
  renewal: {
    type: 'object',
    properties: {
      kind: { type: 'string', enum: ['option', 'automatic', 'month_to_month', 'none'] },
      periodMonths: { type: 'integer', minimum: 1 },
    },
    required: ['kind'],
  },
  notice: {
    type: 'object',
    properties: {
      amount: { type: 'integer', minimum: 1 },
      unit: { type: 'string', enum: ['days', 'months'], description: '"calendar months" and "months" are both months' },
      before: { type: 'string', enum: ['expiry', 'renewal', 'end_of_initial_period'], description: 'Only when the wording ties the notice to that date' },
    },
    required: ['amount', 'unit'],
  },
  fee: {
    anyOf: [
      {
        type: 'object',
        properties: {
          cents: { type: 'integer', description: 'Amount in cents: R4 850.00 = 485000' },
          per: { type: 'string', description: 'e.g. "month", "year"' },
          vat: { type: 'string', enum: ['included', 'excluded'], description: 'Only when the wording says' },
        },
        required: ['cents', 'per'],
      },
      { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], description: 'When no single amount is stated' },
    ],
  },
  feeChange: {
    anyOf: [
      { type: 'object', properties: { kind: { const: 'schedule' }, steps: { type: 'array', items: { type: 'integer' }, description: 'Amounts in cents, in order' } }, required: ['kind', 'steps'] },
      { type: 'object', properties: { kind: { const: 'percent_escalation' }, percent: { type: 'number' }, every: { type: 'string', description: 'e.g. "anniversary"' } }, required: ['kind', 'percent', 'every'] },
      { type: 'object', properties: { kind: { enum: ['unquantified', 'none'] } }, required: ['kind'] },
    ],
  },
  deposit: { type: 'integer', description: 'Amount in cents' },
  scope: text,
};

const candidate = (key: FieldKey) => ({
  type: 'object',
  properties: {
    value: { anyOf: [VALUE_SCHEMAS[key], NOT_STATED_OR_BLANK] },
    quote: { type: 'string', description: 'Copied character for character from inside one <page> tag' },
    file: { type: 'string' },
    page: { type: 'integer', minimum: 1 },
    clause: { type: 'string', description: 'As written: "cl. 18.2", "Order form item 4", "Sch. 2"' },
  },
  required: ['value', 'quote', 'file', 'page'],
});

export const FIELD_KEYS: FieldKey[] = [
  'counterparty', 'agreementType', 'premises', 'startDate', 'endDate', 'termMonths',
  'renewal', 'notice', 'fee', 'feeChange', 'deposit', 'scope',
];

export const contractsSchema = {
  type: 'object',
  properties: {
    fields: {
      type: 'object',
      description: 'For each field, one candidate for every place the value is stated. Leave a field out only if the agreement has nothing on it at all.',
      properties: Object.fromEntries(FIELD_KEYS.map((k) => [k, { type: 'array', items: candidate(k) }])),
    },
    amendments: {
      type: 'array',
      description: 'Every addendum clause that replaces or changes a clause of an earlier document',
      items: {
        type: 'object',
        properties: {
          file: { type: 'string' },
          page: { type: 'integer', minimum: 1 },
          clause: { type: 'string' },
          quote: { type: 'string' },
          targetClause: { type: 'string', description: 'The number of the clause it changes, e.g. "18.2"' },
          fieldKeys: { type: 'array', items: { type: 'string', enum: FIELD_KEYS } },
        },
        required: ['file', 'page', 'clause', 'quote', 'targetClause', 'fieldKeys'],
      },
    },
  },
  required: ['fields', 'amendments'],
};

export const contractsInstructions = `You read one agreement (its main document and any addenda) and record what it says about each field.

Rules:
- Copy every quote character for character from inside one <page> tag, as one continuous passage. Keep the document's spelling, punctuation and line text. Don't paraphrase, correct or shorten words, don't use ellipses ("…" or "...") to skip words, and don't join text from different places or pages.
- Use the shortest passage that supports the value, but at least about 8 words, so it is unique on the page: include the defined term or the clause heading with the value. A bare "31 January 2027" is too short; "the Lease Period ends on 31 January 2027" is right.
- When a value needs two separate passages (for example a date in one clause and its defined term in another), give one candidate per passage, each with the same value.
- Report every clause that states a field's value, as a separate candidate, including clauses that disagree with each other. Never choose between them or merge them.
- A quote must contain the value itself in full: a date with its day, month and year, an amount with its digits, a period with its number. If the value continues on the next line, quote through the end of it.
- Use "blank" when the document has an unfilled line where the value belongs (for example "a period of ______ months"), and quote that line including the underscores or dots of the blank itself.
- A heading or title that appears more than once on a page is not a good quote. Quote the sentence that states the value instead.
- Use "not_stated" when the agreement doesn't give the value, and quote the nearest relevant clause.
- State only what is written. Don't calculate end dates, deadlines or amounts, and don't say whether a term is enforceable, reasonable or advisable.
- A fee change with no amount, percentage, cap or index is { "kind": "unquantified" }.
- List every addendum clause that replaces or changes an earlier clause under "amendments", with the number of the clause it changes. Also record the addendum's new wording as a candidate for the affected field, and keep the original clause's candidate.
- Money in cents (R32 000.00 = 3200000). Dates as YYYY-MM-DD. Terms in months (3 years = 36).
- Give the clause label as it is written in the document ("cl. 18.2", "Order form item 4", "Sch. 2", "Add. 1 cl. 2").`;


/**
 * The instructions for one organisation's register. Without this the extractor cannot know which party is "us": it
 * took the organisation's own name as the counterparty on most agreements (measured in the Phase 4 eval).
 */
export function contractsInstructionsFor(organisation: string): string {
  const name = organisation.trim();
  return `${contractsInstructions}
- Use "not_stated" only after looking through every page, including schedules, order forms, annexures and any terms at the back.${
    name
      ? `

Whose register this is: "${name}". It is one of the parties to every agreement in it. The counterparty is the OTHER party, the one that is not "${name}" (a party may be named a little differently, for example with or without "(Pty) Ltd").`
      : ''
  }`;
}
