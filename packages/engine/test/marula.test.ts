// The Month-End demo brief's fixture, with its verified arithmetic, as the engine's first test.

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

const mk = (side: Line['side']) =>
  (id: string, day: number, description: string, reference: string, rands: string): Line => ({
    id,
    side,
    date: `2026-09-${String(day).padStart(2, '0')}`,
    description,
    reference,
    amount: Math.round(Number(rands) * 100),
  });
const s = mk('bank');
const l = mk('ledger');

const bank: Line[] = [
  s('s1', 1, 'Deposit — Ndlovu Traders', 'INV-3104', '18400.00'),
  s('s2', 2, 'Debit order — Office rent September', 'RENT-09', '-32000.00'),
  s('s3', 4, 'EFT — Paper Mill Supplies', 'PMS-8812', '-21736.40'),
  s('s4', 8, 'Deposit — Greenfield Schools', 'INV-3109', '12450.00'),
  s('s5', 11, 'Card — Fuel', 'FUEL-0911', '-1284.60'),
  s('s6', 15, 'Deposit — Ridgeway Clinics', 'INV-3112', '27980.00'),
  s('s7', 18, 'EFT — Inkjet Wholesale', 'IW-4410', '-9312.75'),
  s('s8', 22, 'Deposit — Ndlovu Traders', 'INV-3117', '15600.00'),
  s('s9', 25, 'EFT — Salaries September', 'SAL-09', '-68500.00'),
  s('s10', 26, 'Debit order — Telephone and internet', 'TEL-09', '-2145.00'),
  s('s11', 30, 'Service fees', 'FEES', '-186.50'),
  s('s12', 30, 'Interest received', 'INT', '42.18'),
];
const ledger: Line[] = [
  l('l1', 1, 'Receipt — Ndlovu Traders', 'INV-3104', '18400.00'),
  l('l2', 1, 'Rent — September', 'RENT-09', '-32000.00'),
  l('l3', 4, 'Payment — Paper Mill Supplies', 'PMS-8812', '-21736.40'),
  l('l4', 8, 'Receipt — Greenfield Schools', 'INV-3109', '12540.00'),
  l('l5', 11, 'Fuel', 'FUEL-0911', '-1284.60'),
  l('l6', 15, 'Receipt — Ridgeway Clinics', 'INV-3112', '27980.00'),
  l('l7', 18, 'Payment — Inkjet Wholesale', 'IW-4410', '-9312.75'),
  l('l8', 18, 'Payment — Inkjet Wholesale', 'IW-4410', '-9312.75'),
  l('l9', 19, 'Receipt — Ndlovu Traders', 'INV-3117', '15600.00'),
  l('l10', 25, 'Salaries — September', 'SAL-09', '-68500.00'),
  l('l11', 26, 'Telephone and internet', 'TEL-09', '-2145.00'),
  l('l12', 29, 'Payment — Coastal Couriers', 'CC-219', '-4870.00'),
  l('l13', 30, 'Receipt — Greenfield Schools', 'INV-3121', '9250.00'),
];

const OPENING = 18_425_000;
const result = runMatching({ bank, ledger, preset, periodEnd: '2026-09-30' });
const journals = proposeJournals(result, bank, preset);
const exc = (type: string) => result.exceptions.find((e) => e.type === type)!;
const recon = (decisions: Decisions) =>
  reconcile({ openingBank: OPENING, openingLedger: OPENING, bank, ledger, result, preset, decisions });
const status = (decisions: Decisions, approvedJournalIds: string[]) =>
  approvalStatus({ panel: recon(decisions), journals, approvedJournalIds, result, preset, decisions });

describe('default preset', () => {
  it('is valid', () => expect(validatePreset(preset)).toEqual([]));
});

describe('matching (Rules 1–4 at runtime)', () => {
  it('produces the brief’s Result column exactly', () => {
    expect(result.matched).toEqual([
      { bankId: 's1', ledgerId: 'l1', rule: 1 },
      { bankId: 's3', ledgerId: 'l3', rule: 1 },
      { bankId: 's5', ledgerId: 'l5', rule: 1 },
      { bankId: 's6', ledgerId: 'l6', rule: 1 },
      { bankId: 's7', ledgerId: 'l7', rule: 1 },
      { bankId: 's9', ledgerId: 'l10', rule: 1 },
      { bankId: 's10', ledgerId: 'l11', rule: 1 },
      { bankId: 's2', ledgerId: 'l2', rule: 2 },
      { bankId: 's8', ledgerId: 'l9', rule: 2 },
    ]);
  });

  it('counts: 9 matched · 2 timing · 2 not in ledger · 1 amount difference · 1 possible duplicate', () => {
    const count = (t: string) => result.exceptions.filter((e) => e.type === t).length;
    expect(result.matched).toHaveLength(9);
    expect(count('timing')).toBe(2);
    expect(count('not_in_ledger')).toBe(2);
    expect(count('amount_difference')).toBe(1);
    expect(count('possible_duplicate')).toBe(1);
    expect(count('not_on_statement')).toBe(0);
    expect(count('suggested_match')).toBe(0);
  });

  it('flags the right lines', () => {
    expect(exc('amount_difference')).toMatchObject({ bankId: 's4', ledgerId: 'l4', amount: -9000 });
    expect(exc('possible_duplicate')).toMatchObject({ ledgerId: 'l8', duplicateOf: 'l7' });
    const timing = result.exceptions.filter((e) => e.type === 'timing');
    expect(timing.map((e) => [e.ledgerId, e.timingKind])).toEqual([
      ['l12', 'outstanding_payment'],
      ['l13', 'deposit_in_transit'],
    ]);
    expect(result.exceptions.filter((e) => e.type === 'not_in_ledger').map((e) => e.bankId)).toEqual(['s11', 's12']);
  });

  it('is deterministic', () => {
    expect(runMatching({ bank, ledger, preset, periodEnd: '2026-09-30' })).toEqual(result);
  });
});

describe('reconciliation panel (verified arithmetic from the brief)', () => {
  it('matches the brief before any review action', () => {
    expect(recon({})).toEqual({
      bankClosing: 12_355_693,
      depositsInTransit: 925_000,
      outstandingPayments: -487_000,
      adjustedBank: 12_793_693,
      ledgerClosing: 11_885_850,
      unrecordedCredits: 4_218,
      unrecordedDebits: -18_650,
      ledgerAdjustments: 0,
      adjustedLedger: 11_871_418,
      difference: -922_275,
    });
  });

  const amountDiff = exc('amount_difference').id;
  const dup = exc('possible_duplicate').id;

  it('reaches 0 with the amount fix and "Confirmed duplicate"', () => {
    expect(recon({ [amountDiff]: { optionId: 'short_paid' }, [dup]: { optionId: 'confirmed' } }).difference).toBe(0);
    expect(recon({ [amountDiff]: { optionId: 'capture_error' }, [dup]: { optionId: 'confirmed' } }).difference).toBe(0);
  });

  it('reaches 0 with the amount fix and "Not a duplicate" (moved to outstanding payments)', () => {
    const panel = recon({ [amountDiff]: { optionId: 'short_paid' }, [dup]: { optionId: 'not_duplicate' } });
    expect(panel.outstandingPayments).toBe(-487_000 - 931_275);
    expect(panel.difference).toBe(0);
  });

  it('"Other" keeps the difference open', () => {
    const panel = recon({ [amountDiff]: { optionId: 'short_paid' }, [dup]: { optionId: 'other', note: 'Checking' } });
    expect(panel.difference).not.toBe(0);
  });
});

describe('review', () => {
  const amountDiff = exc('amount_difference').id;
  const dup = exc('possible_duplicate').id;
  const allJournals = journals.map((j) => j.id);

  it('proposes the two journals', () => {
    expect(journals.map((j) => [j.label, j.amount])).toEqual([
      ['Bank service fees', -18_650],
      ['Interest received', 4_218],
    ]);
  });

  it('lists options alphabetically with amounts filled in', () => {
    expect(optionsFor(preset, exc('amount_difference'), bank, ledger).map((o) => o.text)).toEqual([
      'Customer short-paid — request balance of R90.00',
      'Ledger capture error — correct receipt to R12 450.00',
      'Other — add a note',
    ]);
    expect(optionsFor(preset, exc('possible_duplicate'), bank, ledger).map((o) => o.text)).toEqual([
      'Confirmed duplicate — reverse second entry',
      'Not a duplicate — second payment still to clear',
      'Other — add a note',
    ]);
  });

  it('helper text is accurate at each intermediate state', () => {
    expect(status({}, []).message).toBe('4 items still open: 2 journals, 2 differences.');
    expect(status({ [amountDiff]: { optionId: 'short_paid' } }, [allJournals[0]!]).message).toBe(
      '2 items still open: 1 journal, 1 difference.',
    );
    expect(status({ [amountDiff]: { optionId: 'short_paid' } }, allJournals).message).toBe(
      '1 item still open: 1 difference.',
    );
    expect(status({ [amountDiff]: { optionId: 'other' } }, allJournals).openDifferences).toBe(2);
    expect(status({ [amountDiff]: { optionId: 'other', note: 'Asked the customer' } }, allJournals).openDifferences).toBe(1);
    const allOther: Decisions = {
      [amountDiff]: { optionId: 'other', note: 'Asked the customer' },
      [dup]: { optionId: 'other', note: 'Checking with supplier' },
    };
    expect(status(allOther, allJournals)).toMatchObject({
      canApprove: false,
      message: 'The unexplained difference is not zero.',
    });
  });

  it('enables approval only at difference 0 with both journals approved', () => {
    const done: Decisions = { [amountDiff]: { optionId: 'capture_error' }, [dup]: { optionId: 'not_duplicate' } };
    expect(status(done, [allJournals[0]!]).canApprove).toBe(false);
    const ready = status(done, allJournals);
    expect(ready.canApprove).toBe(true);
    expect(ready.message).toBe('Ready for approval.');
  });
});
