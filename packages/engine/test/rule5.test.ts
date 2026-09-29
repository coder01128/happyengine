// Rule 5: suggest (never auto-match) lines with the same amount and nearby dates when references
// are missing, differ, or clear outside the Rule 2 tolerance.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  approvalStatus,
  optionsFor,
  proposeJournals,
  reconcile,
  runMatching,
  validatePreset,
  type Decisions,
  type Line,
  type MonthEndPreset,
} from '../src/index.ts';

const preset = JSON.parse(
  readFileSync(join(import.meta.dirname, '..', '..', '..', 'presets', 'month-end.default.json'), 'utf8'),
) as MonthEndPreset;

const line = (id: string, side: Line['side'], day: number, amount: number, reference = '', description = ''): Line => ({
  id,
  side,
  date: `2026-08-${String(day).padStart(2, '0')}`,
  description,
  reference,
  amount,
});
const run = (bank: Line[], ledger: Line[]) => runMatching({ bank, ledger, preset, periodEnd: '2026-08-31' });

describe('Rule 5 suggestions', () => {
  it('suggests a card line with no reference', () => {
    const r = run(
      [line('s1', 'bank', 12, -62363, '', 'POS PURCHASE FUEL STOP MIDRAND 4417*1234')],
      [line('l1', 'ledger', 10, -62363, 'CARD-0810-1', 'Fuel')],
    );
    expect(r.matched).toEqual([]);
    expect(r.exceptions).toEqual([
      expect.objectContaining({
        type: 'suggested_match',
        bankId: 's1',
        ledgerId: 'l1',
        amount: -62363,
        reason: 'Same amount, 2 days apart; no reference to match on.',
      }),
    ]);
  });

  it('explains why each suggestion was made', () => {
    const noRef = run([line('s1', 'bank', 3, -93500, '', 'DEBIT ORDER SAMPLE TELECOM 79995190')], [line('l1', 'ledger', 1, -93500)]);
    expect(noRef.exceptions[0]!.reason).toBe('Same amount, 2 days apart; no reference to match on.');

    const late = run([line('s1', 'bank', 16, 250000, 'INV-4001')], [line('l1', 'ledger', 10, 250000, 'INV-4001')]);
    expect(late.exceptions[0]).toMatchObject({ type: 'suggested_match' });
    expect(late.exceptions[0]!.reason).toBe('Same reference and amount, 6 days apart (outside the 3-day rule).');

    const typo = run([line('s1', 'bank', 10, 250000, 'INV-4010')], [line('l1', 'ledger', 10, 250000, 'INV-4001')]);
    expect(typo.exceptions[0]!.reason).toBe('Same amount, same date; references differ (INV4010 / INV4001).');
  });

  it('does not suggest when the amount is ambiguous on either side', () => {
    const twoLedger = run([line('s1', 'bank', 10, -50000)], [line('l1', 'ledger', 9, -50000), line('l2', 'ledger', 11, -50000)]);
    expect(twoLedger.exceptions.some((e) => e.type === 'suggested_match')).toBe(false);

    const twoBank = run([line('s1', 'bank', 9, -50000), line('s2', 'bank', 11, -50000)], [line('l1', 'ledger', 10, -50000)]);
    expect(twoBank.exceptions.some((e) => e.type === 'suggested_match')).toBe(false);
    expect(twoBank.exceptions.filter((e) => e.type === 'not_in_ledger')).toHaveLength(2);
  });

  it('does not suggest outside the window', () => {
    const r = run([line('s1', 'bank', 20, -50000)], [line('l1', 'ledger', 12, -50000)]);
    expect(r.exceptions.map((e) => e.type).sort()).toEqual(['not_in_ledger', 'not_on_statement']);
  });

  it('never takes a line an exact rule would match', () => {
    const r = run(
      [line('s1', 'bank', 10, -50000, 'PMT-1')],
      [line('l1', 'ledger', 10, -50000, 'PMT-1'), line('l2', 'ledger', 11, -50000)],
    );
    expect(r.matched).toEqual([{ bankId: 's1', ledgerId: 'l1', rule: 1 }]);
    expect(r.exceptions.map((e) => e.type)).toEqual(['not_on_statement']);
  });
});

describe('reviewing a suggestion', () => {
  const bank = [line('s1', 'bank', 3, -93500, '', 'DEBIT ORDER SAMPLE TELECOM 79995190')];
  const ledger = [line('l1', 'ledger', 1, -93500, 'TEL-08', 'Telephone and internet')];
  const result = run(bank, ledger);
  const id = result.exceptions[0]!.id;
  const panel = (decisions: Decisions) =>
    reconcile({ openingBank: 0, openingLedger: 0, bank, ledger, result, preset, decisions });
  const status = (decisions: Decisions) =>
    approvalStatus({
      panel: panel(decisions),
      journals: proposeJournals(result, bank, preset),
      approvedJournalIds: [],
      result,
      preset,
      decisions,
    });

  it('offers confirm / reject, alphabetically', () => {
    expect(optionsFor(preset, result.exceptions[0]!, bank, ledger).map((o) => o.text)).toEqual([
      'Confirm match — same transaction',
      'Not a match — investigate',
    ]);
  });

  it('blocks approval until a person decides', () => {
    expect(status({})).toMatchObject({ canApprove: false, openSuggestions: 1, message: '1 item still open: 1 suggested match.' });
  });

  it('confirming reconciles like a matched pair', () => {
    expect(panel({ [id]: { optionId: 'confirm' } }).difference).toBe(0);
    expect(status({ [id]: { optionId: 'confirm' } })).toMatchObject({ canApprove: true, message: 'Ready for approval.' });
  });

  it('rejecting needs a note and leaves the difference open', () => {
    expect(status({ [id]: { optionId: 'reject' } }).openSuggestions).toBe(1);
    const rejected: Decisions = { [id]: { optionId: 'reject', note: 'Different contract' } };
    expect(panel(rejected).difference).toBe(-93500);
    expect(status(rejected)).toMatchObject({ canApprove: false, message: 'The unexplained difference is not zero.' });
  });
});

describe('preset validation for Rule 5', () => {
  it('rejects match effects on other exception types', () => {
    const bad = structuredClone(preset);
    bad.resolutions.amount_difference[0]!.effect = 'confirm_match';
    expect(validatePreset(bad)).toContain('resolutions.amount_difference.short_paid: "confirm_match" can\'t be used here');
  });
  it('needs a confirm option and a window', () => {
    const bad = structuredClone(preset);
    bad.resolutions.suggested_match = bad.resolutions.suggested_match.filter((o) => o.effect !== 'confirm_match');
    delete (bad.matching as Partial<MonthEndPreset['matching']>).suggestionWindowDays;
    expect(validatePreset(bad)).toEqual(
      expect.arrayContaining(['resolutions.suggested_match: needs a "confirm_match" option', 'matching.suggestionWindowDays: missing']),
    );
  });
});
