import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateContractsPreset } from '../src/index.ts';

const raw = readFileSync(join(import.meta.dirname, '..', '..', '..', 'presets', 'contracts.default.json'), 'utf8');
const fresh = () => JSON.parse(raw);

describe('Contracts default preset', () => {
  it('is valid', () => expect(() => validateContractsPreset(fresh())).not.toThrow());

  it('lists the register fields in order', () =>
    expect(validateContractsPreset(fresh()).fields.map((f) => f.key)).toEqual([
      'counterparty', 'agreementType', 'premises', 'startDate', 'endDate', 'termMonths',
      'renewal', 'notice', 'fee', 'feeChange', 'deposit', 'scope',
    ]));

  it('has review options in alphabetical order', () =>
    expect(validateContractsPreset(fresh()).reviewOptions.map((o) => o.label)).toEqual([
      'Confirm recorded value', 'Refer to legal review', 'Request clarification from counterparty',
    ]));

  it('counts the notice search from today, not a fixed date', () =>
    expect(validateContractsPreset(fresh()).presetSearches.find((s) => s.id === 'notice')).toMatchObject({ kind: 'datesBefore', beforeDays: 90 }));
});

describe('validateContractsPreset refuses a broken preset', () => {
  it('names a missing setting', () => {
    const p = fresh();
    delete p.parser.scannedTier;
    delete p.reminders.empty;
    expect(() => validateContractsPreset(p)).toThrow(/parser\.scannedTier.*reminders\.empty/);
  });

  it('names invalid settings', () => {
    const p = fresh();
    p.grounding.minScore = 1.5;
    p.reviewOptions.reverse();
    p.presetSearches[1].beforeDays = undefined;
    const run = () => validateContractsPreset(p);
    expect(run).toThrow(/grounding\.minScore: must be a number from 0 to 1/);
    expect(run).toThrow(/reviewOptions: must be in alphabetical order/);
    expect(run).toThrow(/presetSearches\.notice: a datesBefore search needs beforeDays/);
  });
});
