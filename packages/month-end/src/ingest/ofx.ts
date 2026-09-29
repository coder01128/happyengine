import { parseDate } from '../../../core/src/index.ts';
import { parseAmount } from '../../../core/src/index.ts';
import type { Line, Side } from '../types.ts';
import { IngestError } from './csv.ts';

/** Reads <STMTTRN> blocks from OFX 1.x (SGML, unclosed tags) or 2.x (XML). */
export function linesFromOfx(text: string, side: Side, idPrefix: string): Line[] {
  const blocks = text.match(/<STMTTRN>[\s\S]*?<\/STMTTRN>/gi) ?? [];
  if (!blocks.length) throw new IngestError('No <STMTTRN> transactions found in OFX file');
  return blocks.map((block, n) => {
    const tag = (name: string) => block.match(new RegExp(`<${name}>([^<\\r\\n]*)`, 'i'))?.[1]?.trim() ?? '';
    try {
      const name = tag('NAME');
      const memo = tag('MEMO');
      return {
        id: `${idPrefix}${n + 1}`,
        side,
        date: parseDate(tag('DTPOSTED').slice(0, 8), 'YYYYMMDD'),
        description: [name, memo].filter(Boolean).join(' — '),
        reference: tag('REFNUM') || tag('CHECKNUM'),
        amount: parseAmount(tag('TRNAMT')),
      };
    } catch (err) {
      throw new IngestError(`Transaction ${n + 1}: ${(err as Error).message}`);
    }
  });
}
