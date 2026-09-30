// The Contracts engine on the demo test set: the committed pdfjs parse (brief 04) + extract-perfect.json.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ParsedDocument } from '../../documents/src/index.ts';
import {
  applyDecisions, buildRecord, dateStatus, presetSearch, register, reminderDraft, validateContractsPreset,
  type Extraction,
} from '../src/index.ts';
import { perfect, scoreAgreement, type Boxes, type Expected } from '../../../eval/contracts/score.ts';

const dir = join(import.meta.dirname, '..', '..', '..', 'eval', 'contracts', 'demo-marula');
const read = (...p: string[]) => JSON.parse(readFileSync(join(dir, ...p), 'utf8'));
const preset = validateContractsPreset(JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', '..', 'presets', 'contracts.default.json'), 'utf8')));
const sample: { asAt: string; agreements: { id: string; files: string[] }[] } = read('sample.json');
const expected: Expected = read('expected.json');
const boxes: Boxes = read('boxes.json');
const extraction: Record<string, Extraction> = read('recorded', 'extract-perfect.json');
const parsed: Record<string, ParsedDocument> = Object.fromEntries(
  sample.agreements.flatMap((a) => a.files).map((f) => [f, read('parsed', 'pdfjs-local', f.replace('.pdf', '.json'))]),
);

const build = () =>
  sample.agreements.map((a) => buildRecord({ id: a.id, ref: a.id.toUpperCase(), files: a.files, parsed, extraction: extraction[a.id]!, preset }));
const records = build();
const byId = (id: string) => records.find((r) => r.id === id)!;
const asAt = '2026-10-14';

describe('buildRecord on the demo agreements', () => {
  for (const a of sample.agreements) {
    it(`${a.id.toUpperCase()}: every expected field, flag and key date`, () => {
      const s = scoreAgreement(a.id, byId(a.id), expected.agreements[a.id]!, asAt, preset, parsed, boxes);
      expect([...s.fields.misses, ...s.flags.missed, ...s.flags.unexpected, ...s.dates.misses, ...s.dates.unexpected]).toEqual([]);
      expect(perfect(s)).toBe(true);
    });
  }

  it('grounds every quote', () => {
    for (const r of records) {
      for (const f of Object.values(r.fields)) for (const c of f!.candidates) expect(c.grounding.status, `${r.ref} ${f!.key}`).toBe('grounded');
    }
  });

  it('raises exactly the 3 expected review items', () => {
    expect(records.flatMap((r) => r.reviewItems.map((i) => `${r.ref} ${i.kind} ${i.fieldKey}`))).toEqual([
      'C2 unclear feeChange',
      'C3 conflict notice',
      'C5 blank termMonths',
    ]);
  });

  it('applies the addendum: 18.2 superseded, the addendum wording current, no flag', () => {
    const notice = byId('c1').fields.notice!;
    expect(notice.status).toBe('recorded');
    expect(notice.candidates.find((c) => c.clause === 'cl. 18.2')!.superseded).toEqual({ file: 'c1-addendum.pdf', page: 1, clause: 'Add. 1 cl. 2' });
    expect(notice.candidates[notice.current!]!.file).toBe('c1-addendum.pdf');
    expect(byId('c1').amendments[0]).toMatchObject({ applied: true, targetClause: '18.2' });
  });

  it('derives C2’s end date from start + 12 months − 1 day, with its sources', () => {
    const end = byId('c2').fields.endDate!;
    expect(end).toMatchObject({ status: 'recorded', value: '2027-02-28', derived: { rule: 'start + term − 1 day', from: ['startDate', 'termMonths'] } });
    expect(end.derived!.sources.map((s) => s.clause)).toEqual(['Order form item 3', 'Order form item 4']);
  });

  it('dates the demo §4 list as at 14 Oct 2026', () => {
    const dates = Object.fromEntries(
      records.flatMap((r) => r.keyDates.map((d) => [`${r.ref} ${d.key}`, d.date ? `${d.date} ${dateStatus(d.date, asAt, preset.alertWindows)}` : `pending: ${d.pendingReason}`])),
    );
    expect(dates).toEqual({
      'C1 expiry': '2027-01-31 later',
      'C1 renewal_notice': '2026-10-31 attention',
      'C2 renewal': '2027-03-01 later',
      'C2 cancellation_deadline': '2026-12-31 upcoming',
      'C3 end_of_initial_period': '2026-09-30 passed',
      'C3 notice': 'pending: Pending review',
      'C4 end_of_initial_period': '2026-10-31 attention',
      'C4 termination_notice': '2026-07-31 passed',
    });
  });

  it('shows the derivation the way the demo does', async () => {
    const { describeDerivation } = await import('../src/index.ts');
    const { formatDate } = await import('../../core/src/index.ts');
    const d = byId('c4').keyDates.find((k) => k.key === 'termination_notice')!;
    expect(describeDerivation(d, formatDate)).toBe(
      "End of initial period 31 Oct 2026 − 3 calendar months ('The Renter may terminate this agreement by giving three months' written notice before the end of the initial period.', Terms cl. 12.2) = 31 Jul 2026",
    );
  });
});

describe('applyDecisions', () => {
  const c3 = byId('c3');

  it('choosing C3’s cl. 9.1 records 30 days and un-pends the notice (no fixed deadline: no "before")', () => {
    const conflict = c3.reviewItems.find((i) => i.kind === 'conflict')!;
    const pick = conflict.sources.findIndex((s) => s.clause === 'cl. 9.1');
    const after = applyDecisions(c3, [{ itemId: conflict.id, optionId: 'clarify', chosenValueIndex: pick }], preset);
    expect(after.fields.notice).toMatchObject({ status: 'recorded', value: { amount: 30, unit: 'days' } });
    expect(after.keyDates.map((d) => d.key)).toEqual(['end_of_initial_period']);
    expect(after.status).toBe('reviewed');
    expect(c3.status).toBe('flagged'); // the original record is unchanged
  });

  it('keeps dependent dates pending when referred to legal', () => {
    const after = applyDecisions(c3, [{ itemId: 'conflict:notice', optionId: 'legal' }], preset);
    expect(after.keyDates.find((d) => d.key === 'notice')).toMatchObject({ date: null, pendingReason: 'With legal' });
    expect(after.status).toBe('with_legal');
  });

  it('refuses "Confirm recorded value" on a conflict', () => {
    expect(() => applyDecisions(c3, [{ itemId: 'conflict:notice', optionId: 'confirm', chosenValueIndex: 0 }], preset)).toThrow(/only for items with a single recorded value/);
  });

  it('needs chosenValueIndex to record a conflict as reviewed', () => {
    expect(() => applyDecisions(c3, [{ itemId: 'conflict:notice', optionId: 'clarify' }], preset)).toThrow(/chosenValueIndex/);
    expect(() => applyDecisions(c3, [{ itemId: 'conflict:notice', optionId: 'clarify', chosenValueIndex: 5 }], preset)).toThrow(/doesn’t match/);
  });

  it('accepts "Confirm recorded value" on a single-value item', () => {
    const after = applyDecisions(byId('c2'), [{ itemId: 'unclear:feeChange', optionId: 'confirm' }], preset);
    expect(after.status).toBe('reviewed');
    expect(after.keyDates).toEqual(byId('c2').keyDates);
  });
});

describe('register, preset searches and reminders', () => {
  const reg = register(records, asAt, preset);

  it('lists key dates by date with pending dates last', () => {
    expect(reg.keyDates.map((d) => `${d.ref} ${d.date ?? 'pending'}`)).toEqual([
      'C4 2026-07-31', 'C3 2026-09-30', 'C1 2026-10-31', 'C4 2026-10-31', 'C2 2026-12-31', 'C1 2027-01-31', 'C2 2027-03-01', 'C3 pending',
    ]);
  });

  it('shows each row’s next key date and status', () => {
    expect(reg.rows.map((r) => `${r.ref} ${r.status} ${r.nextKeyDate?.date ?? '-'} ${r.openItems}`)).toEqual([
      'C1 ready 2026-10-31 0', 'C2 flagged 2026-12-31 1', 'C3 flagged - 1', 'C4 ready 2026-10-31 0', 'C5 flagged - 1',
    ]);
    expect(reg.rows[0]).toMatchObject({ counterparty: 'Oakridge Property Holdings (Pty) Ltd', fee: 'Rent R32 000.00 per month excl. VAT (from 1 Feb 2026) · Parking bay R450.00 per month excl. VAT', notice: '3 calendar months before expiry' });
  });

  it('answers the four preset searches from the data', () => {
    const answers = preset.presetSearches.map((s) => {
      const r = presetSearch(s.id, reg, asAt, preset);
      return `${r.answer} [${r.rows.map((x) => x.ref).join(',')}]${r.alreadyPassed?.length ? ` passed: ${r.alreadyPassed.map((d) => `${d.ref} ${d.date}`).join(',')}` : ''}`;
    });
    expect(answers).toEqual([
      '3 agreements renew or continue automatically [C2,C3,C4]',
      '2 notice deadlines fall on or before 12 Jan 2027 [C1,C2] passed: C4 2026-07-31',
      '3 fees change during the term or on renewal [C1,C2,C4]',
      '3 terms are up for review [C2,C3,C5]',
    ]);
  });

  it('drafts reminders for attention and upcoming dates only, with the C4 note', () => {
    const draft = reminderDraft(reg, asAt, preset);
    expect(draft.body).toContain('1. 31 Oct 2026 (17 days away) — Oakridge Property Holdings (Pty) Ltd, office lease (C1)\n   Renewal notice deadline: Last day for written notice to exercise the renewal option (Add. 1 cl. 2).');
    expect(draft.body).toContain('31 Oct 2026 (17 days away) — Sample Office Equipment Finance (Pty) Ltd, copier rental (C4)');
    expect(draft.body).toContain('31 Dec 2026 (78 days away) — Ledgerline Software (Pty) Ltd, software subscription (C2)');
    expect(draft.items.map((d) => `${d.ref} ${d.date}`)).toEqual(['C1 2026-10-31', 'C4 2026-10-31', 'C2 2026-12-31']);
    for (const later of ['31 Jan 2027', '1 Mar 2027']) expect(draft.body).not.toContain(later);
    expect(draft.notes).toEqual(["C4's notice deadline passed on 31 Jul 2026; clause 12.3 says the agreement continues month to month."]);
    expect(draft.body).toMatch(/^To: Office manager\nSubject: Contract dates in the next 90 days \(register as at 14 Oct 2026\)/);
    expect(draft.body).toContain('Dates are calculated from the recorded wording. The signed agreement is the source of truth.');
  });

  it('changes with asAt and nothing else', () => {
    const later = '2026-12-10';
    const draft = reminderDraft(register(records, later, preset), later, preset);
    expect(draft.items.map((d) => `${d.ref} ${d.date} ${d.status}`)).toEqual(['C2 2026-12-31 attention', 'C1 2027-01-31 upcoming', 'C2 2027-03-01 upcoming']);
    expect(draft.subject).toContain('as at 10 Dec 2026');
    expect(build()).toEqual(records); // records don't depend on asAt
  });

  it('writes the empty template when nothing is due', () => {
    const draft = reminderDraft(register([], asAt, preset), asAt, preset);
    expect(draft.body).toContain('No contract dates fall within the next 90 days.');
  });
});

describe('dateStatus', () => {
  it.each([
    ['2026-10-13', 'passed'],
    ['2026-10-14', 'attention'],
    ['2026-11-13', 'attention'],
    ['2026-11-14', 'upcoming'],
    ['2027-01-12', 'upcoming'],
    ['2027-01-13', 'later'],
  ])('%s as at 14 Oct 2026 is %s', (d, want) => expect(dateStatus(d, asAt, preset.alertWindows)).toBe(want));
});

