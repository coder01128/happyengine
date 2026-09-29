import { describe, expect, it } from 'vitest';
import { linesFromCsv, linesFromOfx, parseCsv, referenceKey } from '../src/index.ts';

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
