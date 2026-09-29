// Money is always integer cents. Rands exist only at the display edge.

export type Cents = number;

const MINUS = '−';

export function assertCents(n: number): Cents {
  if (!Number.isSafeInteger(n)) throw new Error(`Not integer cents: ${n}`);
  return n;
}

/** 1245000 → "R12 450.00"; -18650 → "−R186.50". */
export function formatRand(cents: Cents): string {
  assertCents(cents);
  const abs = Math.abs(cents);
  const rands = Math.floor(abs / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  const frac = (abs % 100).toString().padStart(2, '0');
  return `${cents < 0 ? MINUS : ''}R${rands}.${frac}`;
}

/**
 * Parse an amount as exported by banks and accounting packages, without floats.
 * Accepts "12 450.00", "-1,284.60", "(186.50)", "R1 234,56", "100.00-", "250.00 DR".
 * A "." or "," is the decimal separator only when followed by 1–2 trailing digits.
 */
export function parseAmount(raw: string): Cents {
  let s = raw.trim().replace(/[\s  ]/g, '').replace(/−/g, '-');
  if (!s) throw new Error('Empty amount');
  let negative = false;

  const paren = s.match(/^\((.*)\)$/);
  if (paren) {
    negative = !negative;
    s = paren[1]!;
  }
  const crdr = s.match(/(CR|DR)$/i);
  if (crdr) {
    if (crdr[1]!.toUpperCase() === 'DR') negative = !negative;
    s = s.slice(0, -2);
  }
  if (s.startsWith('-')) {
    negative = !negative;
    s = s.slice(1);
  } else if (s.startsWith('+')) {
    s = s.slice(1);
  }
  s = s.replace(/^(ZAR|R)/i, '');
  if (s.startsWith('-')) {
    negative = !negative;
    s = s.slice(1);
  }
  if (s.endsWith('-')) {
    negative = !negative;
    s = s.slice(0, -1);
  }

  const sep = Math.max(s.lastIndexOf('.'), s.lastIndexOf(','));
  const hasDecimal = sep >= 0 && /^\d{1,2}$/.test(s.slice(sep + 1));
  const intPart = (hasDecimal ? s.slice(0, sep) : s).replace(/[.,']/g, '') || '0';
  const fracPart = hasDecimal ? s.slice(sep + 1) : '';
  if (!/^\d+$/.test(intPart) || !/^\d*$/.test(fracPart)) {
    throw new Error(`Unreadable amount: "${raw}"`);
  }
  const cents = assertCents(Number(intPart) * 100 + Number(fracPart.padEnd(2, '0')));
  return negative && cents !== 0 ? -cents : cents;
}
