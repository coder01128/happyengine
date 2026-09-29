// Rule 6: one statement line suggested as the sum of several cash book entries.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  approvalStatus,
  chooseSplit,
  mentions,
  optionsFor,
  proposeJournals,
  reconcile,
  runMatching,
  subsetsSummingTo,
  validatePreset,
  type Decisions,
  type Line,
  type MonthEndPreset,
} from '../src/index.ts';

const preset = JSON.parse(
  readFileSync(join(import.meta.dirname, '..', '..', '..', 'presets', 'month-end.default.json'), 'utf8'),
) as MonthEndPreset;

const line = (id: string, side: Line['side'], day: number, rands: number, reference = '', description = ''): Line => ({
  id,
  side,
  date: `2026-08-${String(day).padStart(2, '0')}`,
  description,
  reference,
  amount: Math.round(rands * 100),
});
const run = (bank: Line[], ledger: Line[], p: MonthEndPreset = preset) =>
  runMatching({ bank, ledger, preset: p, periodEnd: '2026-08-31' });
const types = (r: ReturnType<typeof run>) => r.exceptions.map((e) => e.type).sort();

describe('Rule 6 split suggestions', () => {
  it('suggests one deposit paying two invoices, even though its reference points at one of them', () => {
    const r = run(
      [line('s1', 'bank', 12, 18350.5, '', 'IB PAYMENT FROM KGOSI LOGISTICS INV4012 4013')],
      [
        line('l1', 'ledger', 10, 12000, 'INV-4012', 'Receipt — Kgosi Logistics'),
        line('l2', 'ledger', 10, 6350.5, 'INV-4013', 'Receipt — Kgosi Logistics'),
        line('l3', 'ledger', 11, 999, 'INV-4020', 'Receipt — Thaba Hardware'),
      ],
    );
    const split = r.exceptions.find((e) => e.type === 'suggested_split');
    expect(split).toMatchObject({ bankId: 's1', ledgerIds: ['l1', 'l2'], amount: 1_835_050 });
    expect(split!.reason).toBe('Equals the sum of 2 cash book entries (INV-4012 + INV-4013), up to 2 days apart.');
    // Without Rule 6 this was mis-flagged as an amount difference against INV-4012.
    expect(types(r)).not.toContain('amount_difference');
  });

  it('works for payments and with no reference at all', () => {
    const r = run(
      [line('s1', 'bank', 20, -3450, '', 'DIGITAL PAYMENT DT HIGHVELD PACKAGING')],
      [line('l1', 'ledger', 18, -1200, 'PMT-1', 'Payment — Highveld Packaging'), line('l2', 'ledger', 18, -2250, 'PMT-2', 'Payment — Highveld Packaging')],
    );
    expect(r.exceptions).toEqual([expect.objectContaining({ type: 'suggested_split', ledgerIds: ['l1', 'l2'] })]);
  });

  it('does not suggest when two combinations fit equally well', () => {
    const r = run(
      [line('s1', 'bank', 15, 1000, '', 'ACB CREDIT PAYMENT')],
      [line('l1', 'ledger', 14, 400), line('l2', 'ledger', 14, 600), line('l3', 'ledger', 14, 300), line('l4', 'ledger', 14, 700)],
    );
    expect(types(r)).not.toContain('suggested_split');
    expect(types(r).filter((t) => t === 'not_in_ledger')).toHaveLength(1);
  });

  it('breaks a tie using the invoice numbers named in the narrative', () => {
    const r = run(
      [line('s1', 'bank', 15, 1000, '', 'ACB CREDIT INV5001 INV5002')],
      [
        line('l1', 'ledger', 14, 400, 'INV-5001'),
        line('l2', 'ledger', 14, 600, 'INV-5002'),
        line('l3', 'ledger', 14, 300, 'INV-5003'),
        line('l4', 'ledger', 14, 700, 'INV-5004'),
      ],
    );
    expect(r.exceptions.find((e) => e.type === 'suggested_split')).toMatchObject({ ledgerIds: ['l1', 'l2'] });
  });

  it('requires the referenced entry when the statement line has a matching reference', () => {
    // INV-6001 is referenced but no combination including it adds up: fall through to Rule 3.
    const r = run(
      [line('s1', 'bank', 15, 1000, 'INV-6001')],
      [line('l1', 'ledger', 14, 950, 'INV-6001'), line('l2', 'ledger', 14, 400), line('l3', 'ledger', 14, 600)],
    );
    expect(types(r)).not.toContain('suggested_split');
    expect(r.exceptions.find((e) => e.type === 'amount_difference')).toMatchObject({ bankId: 's1', ledgerId: 'l1' });
  });

  it('leaves a single same-amount candidate to Rule 5', () => {
    const r = run(
      [line('s1', 'bank', 15, 1000)],
      [line('l1', 'ledger', 13, 1000), line('l2', 'ledger', 14, 400), line('l3', 'ledger', 14, 600)],
    );
    expect(r.exceptions.find((e) => e.type === 'suggested_match')).toMatchObject({ bankId: 's1', ledgerId: 'l1' });
    expect(types(r)).not.toContain('suggested_split');
  });

  it('respects the window, the sign and the part limit', () => {
    const outside = run([line('s1', 'bank', 20, 1000)], [line('l1', 'ledger', 5, 400), line('l2', 'ledger', 20, 600)]);
    expect(types(outside)).not.toContain('suggested_split');

    const mixedSign = run([line('s1', 'bank', 15, 1000)], [line('l1', 'ledger', 15, 1400), line('l2', 'ledger', 15, -400)]);
    expect(types(mixedSign)).not.toContain('suggested_split');

    const five = [1, 2, 3, 4, 5].map((n) => line(`l${n}`, 'ledger', 15, 200));
    const tooMany = run([line('s1', 'bank', 15, 1000)], five);
    expect(types(tooMany)).not.toContain('suggested_split');
    const wider = structuredClone(preset);
    wider.matching.splitMaxParts = 5;
    expect(types(run([line('s1', 'bank', 15, 1000)], five, wider))).toContain('suggested_split');
  });

  it('never takes entries an exact rule matched', () => {
    const r = run(
      [line('s1', 'bank', 15, 400, 'INV-7001'), line('s2', 'bank', 15, 1000)],
      [line('l1', 'ledger', 15, 400, 'INV-7001'), line('l2', 'ledger', 15, 600)],
    );
    expect(r.matched).toEqual([{ bankId: 's1', ledgerId: 'l1', rule: 1 }]);
    expect(types(r)).not.toContain('suggested_split');
  });
});

describe('split search helpers', () => {
  const c = (id: string, amount: number, extra: Partial<{ anchor: boolean; mentioned: boolean }> = {}) => ({
    id,
    amount,
    anchor: false,
    mentioned: false,
    ...extra,
  });
  it('finds every exact combination within the part limit', () => {
    const found = subsetsSummingTo([c('a', 400), c('b', 600), c('c', 300), c('d', 700), c('e', 1000)], 1000, 4);
    expect(found.map((s) => s.map((x) => x.id).sort().join('+')).sort()).toEqual(['a+b', 'c+d']);
  });
  it('chooses only an unambiguous combination', () => {
    expect(chooseSplit([[c('a', 1)], [c('b', 1)]], false)).toBeUndefined();
    expect(chooseSplit([[c('a', 1, { anchor: true })], [c('b', 1)]], true)?.[0]?.id).toBe('a');
  });
  it('matches reference numbers in narrative text', () => {
    expect(mentions('ACBCREDITINV4012INV4013', 'INV4013')).toBe(true);
    expect(mentions('ACBCREDITINV4012', 'INV4013')).toBe(false);
    expect(mentions('ANYTHING', '')).toBe(false);
  });
});

describe('reviewing a split', () => {
  const bank = [line('s1', 'bank', 20, -3450, '', 'DIGITAL PAYMENT DT HIGHVELD PACKAGING')];
  const ledger = [line('l1', 'ledger', 18, -1200, 'PMT-1'), line('l2', 'ledger', 18, -2250, 'PMT-2')];
  const result = run(bank, ledger);
  const id = result.exceptions[0]!.id;
  const panel = (decisions: Decisions) =>
    reconcile({ openingBank: 0, openingLedger: 0, bank, ledger, result, preset, decisions });
  const status = (decisions: Decisions) =>
    approvalStatus({ panel: panel(decisions), journals: proposeJournals(result, bank, preset), approvedJournalIds: [], result, preset, decisions });

  it('offers confirm / reject, alphabetically', () => {
    expect(optionsFor(preset, result.exceptions[0]!, bank, ledger).map((o) => o.text)).toEqual([
      'Confirm — paid together in one transaction',
      'Not a match — investigate',
    ]);
  });
  it('blocks approval until decided; confirm reconciles; reject leaves the difference open', () => {
    expect(status({})).toMatchObject({ canApprove: false, message: '1 item still open: 1 suggested match.' });
    expect(status({ [id]: { optionId: 'confirm' } })).toMatchObject({ canApprove: true });
    const rejected: Decisions = { [id]: { optionId: 'reject', note: 'Two separate payments' } };
    expect(panel(rejected).difference).toBe(-345_000);
    expect(status(rejected).canApprove).toBe(false);
  });
  it('preset validation covers splitMaxParts and the split options', () => {
    const bad = structuredClone(preset);
    bad.matching.splitMaxParts = 9;
    bad.resolutions.suggested_split = bad.resolutions.suggested_split.filter((o) => o.effect !== 'confirm_match');
    expect(validatePreset(bad)).toEqual(
      expect.arrayContaining([
        'matching.splitMaxParts: must be a whole number from 2 to 6',
        'resolutions.suggested_split: needs a "confirm_match" option',
      ]),
    );
  });
});
