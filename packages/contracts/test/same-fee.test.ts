// The eval's fee comparison: a fee is right when its amount lines are (amount, VAT status, start date, unit).

import { describe, expect, it } from 'vitest';
import { sameFee } from '../../../eval/contracts/score.ts';

const line = (cents: number, per: string, vat?: 'excluded' | 'included' | 'not_stated', from?: string) => ({ cents, per, ...(vat ? { vat } : {}), ...(from ? { from } : {}) });
const key = { lines: [line(18500, 'consignment', 'excluded'), line(1800, 'kg', 'excluded'), line(6000, '15 minutes', 'excluded')] };

describe('sameFee', () => {
  it('ignores order, charge names, the longer wording of a unit, and charges in words', () => {
    const got = { lines: [{ ...line(6000, '15 minutes after the first 15', 'excluded'), what: 'waiting time' }, { text: '1.5% of declared value', what: 'insurance levy' }, { ...line(18500, 'per consignment', 'excluded'), what: 'same-day' }, { ...line(1800, 'kg over 5 kg', 'excluded'), what: 'heavy' }] };
    expect(sameFee(got, key)).toBe(true);
  });

  it('a line with no VAT status is wrong, and so is the wrong status', () => {
    expect(sameFee({ lines: [line(18500, 'consignment'), line(1800, 'kg', 'excluded'), line(6000, '15 minutes', 'excluded')] }, key)).toBe(false);
    expect(sameFee({ lines: [line(18500, 'consignment', 'included'), line(1800, 'kg', 'excluded'), line(6000, '15 minutes', 'excluded')] }, key)).toBe(false);
    expect(sameFee(line(198000, 'month', 'not_stated'), line(198000, 'month', 'not_stated'))).toBe(true);
    expect(sameFee(line(198000, 'month', 'not_stated'), line(198000, 'month', 'excluded'))).toBe(false);
  });

  it('a missing line, an extra amount line, a wrong amount or a wrong start date is wrong', () => {
    expect(sameFee({ lines: key.lines.slice(0, 2) }, key)).toBe(false);
    expect(sameFee({ lines: [...key.lines, line(9500, 'consignment', 'excluded')] }, key)).toBe(false);
    expect(sameFee({ lines: [line(18500, 'consignment', 'excluded'), line(1800, 'kg', 'excluded'), line(6100, '15 minutes', 'excluded')] }, key)).toBe(false);
    expect(sameFee(line(100, 'month', 'excluded', '2026-02-01'), line(100, 'month', 'excluded', '2026-03-01'))).toBe(false);
  });

  it('one line and a one-line list are the same', () => {
    expect(sameFee(line(485000, 'month', 'excluded'), { lines: [line(485000, 'month', 'excluded')] })).toBe(true);
  });
});
