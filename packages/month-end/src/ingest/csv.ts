import { parseDate } from '../../../core/src/index.ts';
import { parseAmount } from '../../../core/src/index.ts';
import type { ColumnMapping } from '../preset.ts';
import type { Line, Side } from '../types.ts';

export class IngestError extends Error {}

/** RFC 4180-style CSV: quoted fields, doubled quotes, CRLF or LF. */
export function parseCsv(text: string, delimiter = ','): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delimiter) {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/**
 * Reads an export into normalised lines. Bank exports often have preamble rows,
 * so the header is the first row containing every mapped column name.
 * Rows with an empty date (totals, closing balance) are skipped; a date or amount
 * that can't be read stops the import with the row number rather than being guessed.
 */
export function linesFromCsv(text: string, mapping: ColumnMapping, side: Side, idPrefix: string): Line[] {
  const rows = parseCsv(text, mapping.delimiter ?? ',');
  const wanted = [mapping.date, mapping.description, mapping.reference, mapping.amount, mapping.inflow, mapping.outflow]
    .filter((c): c is string => !!c)
    .map((c) => c.trim().toLowerCase());

  const headerIdx = rows.findIndex((r) => {
    const cells = r.map((c) => c.trim().toLowerCase());
    return wanted.every((w) => cells.includes(w));
  });
  if (headerIdx < 0) throw new IngestError(`No header row with columns: ${wanted.join(', ')}`);

  const header = rows[headerIdx]!.map((c) => c.trim().toLowerCase());
  const col = (name?: string) => (name ? header.indexOf(name.trim().toLowerCase()) : -1);
  const iDate = col(mapping.date);
  const iDesc = col(mapping.description);
  const iRef = col(mapping.reference);
  const iAmt = col(mapping.amount);
  const iIn = col(mapping.inflow);
  const iOut = col(mapping.outflow);

  const lines: Line[] = [];
  rows.slice(headerIdx + 1).forEach((r, n) => {
    const rowNo = headerIdx + n + 2;
    const cell = (i: number) => (i >= 0 ? (r[i] ?? '').trim() : '');
    if (!cell(iDate)) return;
    try {
      let amount: number;
      if (iAmt >= 0) {
        amount = parseAmount(cell(iAmt));
        if (mapping.invertSign) amount = -amount;
      } else {
        const inflow = cell(iIn) ? Math.abs(parseAmount(cell(iIn))) : 0;
        const outflow = cell(iOut) ? Math.abs(parseAmount(cell(iOut))) : 0;
        amount = inflow - outflow;
      }
      lines.push({
        id: `${idPrefix}${lines.length + 1}`,
        side,
        date: parseDate(cell(iDate), mapping.dateFormat),
        description: cell(iDesc),
        reference: cell(iRef),
        amount,
      });
    } catch (err) {
      throw new IngestError(`Row ${rowNo}: ${(err as Error).message}`);
    }
  });
  return lines;
}
