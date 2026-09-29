import { describe, expect, it } from 'vitest';
import {
  daysBetween,
  formatDate,
  formatRand,
  linesFromCsv,
  linesFromOfx,
  parseAmount,
  parseCsv,
  parseDate,
  referenceKey,
} from '../src/index.ts';

describe('money', () => {
  it.each([
    [1_245_000, 'R12 450.00'],
    [-18_650, '−R186.50'],
    [4_218, 'R42.18'],
    [0, 'R0.00'],
    [12_355_693, 'R123 556.93'],
    [-922_275, '−R9 222.75'],
    [100_000_000, 'R1 000 000.00'],
  ])('formatRand(%i) = %s', (cents, text) => expect(formatRand(cents)).toBe(text));

  it.each([
    ['12 450.00', 1_245_000],
    ['12450', 1_245_000],
    ['-1,284.60', -128_460],
    ['(186.50)', -18_650],
    ['R1 234,56', 123_456],
    ['1.234,56', 123_456],
    ['42.18', 4_218],
    ['1 234.5', 123_450],
    ['100.00-', -10_000],
    ['250.00 DR', -25_000],
    ['250.00 CR', 25_000],
    ['−R186.50', -18_650],
    ['-R186.50', -18_650],
    ['12,540.00', 1_254_000],
    ['0.1', 10],
  ])('parseAmount(%s) = %i', (raw, cents) => expect(parseAmount(raw)).toBe(cents));

  it('refuses to guess', () => {
    expect(() => parseAmount('')).toThrow();
    expect(() => parseAmount('twelve')).toThrow();
    expect(() => parseAmount('12.3.4x')).toThrow();
  });

  it('never drifts: 0.1 + 0.2 in cents', () => expect(parseAmount('0.10') + parseAmount('0.20')).toBe(30));
});

describe('dates', () => {
  it('parses each supported format to UTC date-only', () => {
    expect(parseDate('08/09/2026', 'DD/MM/YYYY')).toBe('2026-09-08');
    expect(parseDate('2026-09-08', 'YYYY-MM-DD')).toBe('2026-09-08');
    expect(parseDate('2026/09/08', 'YYYY/MM/DD')).toBe('2026-09-08');
    expect(parseDate('20260908120000[+2:SAST]'.slice(0, 8), 'YYYYMMDD')).toBe('2026-09-08');
    expect(parseDate('8 Sep 2026', 'D MMM YYYY')).toBe('2026-09-08');
    expect(parseDate('08 September 2026', 'D MMM YYYY')).toBe('2026-09-08');
  });
  it('rejects impossible dates and wrong formats', () => {
    expect(() => parseDate('31/09/2026', 'DD/MM/YYYY')).toThrow();
    expect(() => parseDate('2026-09-08', 'DD/MM/YYYY')).toThrow();
  });
  it('counts days across month ends and leap years', () => {
    expect(daysBetween('2026-09-30', '2026-10-03')).toBe(3);
    expect(daysBetween('2028-02-28', '2028-03-01')).toBe(2);
  });
  it('formats for display', () => expect(formatDate('2026-10-05')).toBe('5 Oct 2026'));
});

describe('references', () => {
  const patterns = [/\bINV[- ]?\d+\b/i];
  it('pulls a reference out of free-text bank descriptions', () => {
    expect(referenceKey('', 'APP PMT NDLOVU INV3104 THANKS', patterns)).toBe('INV3104');
    expect(referenceKey('inv-3104', '', patterns)).toBe('INV3104');
  });
  it('falls back to the normalised reference field', () => {
    expect(referenceKey('RENT-09', 'Debit order', patterns)).toBe('RENT09');
    expect(referenceKey('', 'Card purchase', patterns)).toBe('');
  });
});

describe('CSV ingest', () => {
  it('handles quotes, embedded commas and doubled quotes', () => {
    expect(parseCsv('a,"b, c","d ""e"""\r\n1,2,3')).toEqual([
      ['a', 'b, c', 'd "e"'],
      ['1', '2', '3'],
    ]);
  });

  it('finds the header after preamble rows and skips total rows', () => {
    const csv = [
      'Sample Bank Ltd,Statement',
      'Account,•••• 4417',
      '',
      'Date,Description,Reference,Amount',
      '01/09/2026,"Deposit, Ndlovu",INV-3104,"18,400.00"',
      '02/09/2026,Rent,RENT-09,-32000.00',
      ',Closing balance,,',
    ].join('\n');
    const lines = linesFromCsv(
      csv,
      { dateFormat: 'DD/MM/YYYY', date: 'Date', description: 'Description', reference: 'Reference', amount: 'Amount' },
      'bank',
      's',
    );
    expect(lines).toEqual([
      { id: 's1', side: 'bank', date: '2026-09-01', description: 'Deposit, Ndlovu', reference: 'INV-3104', amount: 1_840_000 },
      { id: 's2', side: 'bank', date: '2026-09-02', description: 'Rent', reference: 'RENT-09', amount: -3_200_000 },
    ]);
  });

  it('reads money-in / money-out columns', () => {
    const csv = 'Date,Reference,Description,Receipts,Payments\n01/09/2026,A,x,100.00,\n02/09/2026,B,y,,40.00\n';
    const lines = linesFromCsv(
      csv,
      { dateFormat: 'DD/MM/YYYY', date: 'Date', description: 'Description', reference: 'Reference', inflow: 'Receipts', outflow: 'Payments' },
      'ledger',
      'l',
    );
    expect(lines.map((x) => x.amount)).toEqual([10_000, -4_000]);
  });

  it('stops with the row number on an unreadable value', () => {
    const csv = 'Date,Description,Amount\n01/09/2026,x,1.00\n31/09/2026,y,2.00\n';
    expect(() =>
      linesFromCsv(csv, { dateFormat: 'DD/MM/YYYY', date: 'Date', description: 'Description', amount: 'Amount' }, 'bank', 's'),
    ).toThrow(/Row 3/);
  });

  it('says which columns are missing', () => {
    expect(() =>
      linesFromCsv('Posted,Text,Value\n', { dateFormat: 'DD/MM/YYYY', date: 'Date', description: 'Description', amount: 'Amount' }, 'bank', 's'),
    ).toThrow(/date, description, amount/);
  });
});

describe('OFX ingest', () => {
  it('reads SGML-style OFX 1.x transactions', () => {
    const ofx = `OFXHEADER:100
<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><BANKTRANLIST>
<STMTTRN>
<TRNTYPE>CREDIT
<DTPOSTED>20260901120000[+2:SAST]
<TRNAMT>18400.00
<FITID>1
<NAME>NDLOVU TRADERS
<MEMO>INV-3104
</STMTTRN>
<STMTTRN>
<TRNTYPE>DEBIT
<DTPOSTED>20260930
<TRNAMT>-186.50
<FITID>2
<NAME>SERVICE FEES
<REFNUM>FEES
</STMTTRN>
</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;
    expect(linesFromOfx(ofx, 'bank', 's')).toEqual([
      { id: 's1', side: 'bank', date: '2026-09-01', description: 'NDLOVU TRADERS — INV-3104', reference: '', amount: 1_840_000 },
      { id: 's2', side: 'bank', date: '2026-09-30', description: 'SERVICE FEES', reference: 'FEES', amount: -18_650 },
    ]);
  });
});
