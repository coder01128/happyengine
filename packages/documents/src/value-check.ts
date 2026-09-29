// Reading amounts of money, dates and numbers out of a quote, so code can check that the value an extractor
// reported really appears in the wording it cited. Knows nothing about any service's fields.
// Dependency-free, so edge functions and Node scripts import the same code.

// ---------------------------------------------------------------------------
// Money: R4 850.00, R4,850.00, R 4850, R4 850,00, ZAR 32 000.00
// ---------------------------------------------------------------------------
// A separator followed by exactly three digits is a thousands separator; one followed by one or two digits
// at the end is the decimal. A bare number with no R or ZAR is not read as money.
const MONEY = /(?<![A-Za-z])(?:R|ZAR|Zar)\s?(\d{1,3}(?:[ ,  ]\d{3})+(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?)(?![\d])/g;

/** Every amount of money in the text, in cents. */
export function centsIn(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(MONEY)) {
    const raw = m[1]!;
    const dec = /[.,]\d{1,2}$/.test(raw) ? raw.slice(-3).replace(/^[.,]/, '') : '';
    const whole = (dec ? raw.slice(0, raw.length - dec.length - 1) : raw).replace(/[ ,.  ]/g, '');
    out.push(Number(whole) * 100 + Number(dec.padEnd(2, '0')));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------
const MONTHS: Record<string, number> = {
  january: 1, jan: 1, januarie: 1, february: 2, feb: 2, februarie: 2, march: 3, mar: 3, maart: 3,
  april: 4, apr: 4, may: 5, mei: 5, june: 6, jun: 6, junie: 6, july: 7, jul: 7, julie: 7,
  august: 8, aug: 8, augustus: 8, september: 9, sep: 9, sept: 9, october: 10, oct: 10, oktober: 10,
  november: 11, nov: 11, december: 12, dec: 12, desember: 12,
};

function iso(y: number, m: number, d: number): string | null {
  if (m < 1 || m > 12 || d < 1 || y < 1900 || y > 2200) return null;
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  if (d > last) return null;
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** Every date in the text, as ISO. A slash or dash date is read day first (31/01/2027), as it is written in South Africa. */
export function datesIn(text: string): string[] {
  const found: { at: number; iso: string }[] = [];
  const add = (at: number, v: string | null) => {
    if (v) found.push({ at, iso: v });
  };
  const month = (s: string) => MONTHS[s.toLowerCase()];

  // 31 January 2027, 1st of June 2025, the 29th day of February 2028, 1 Feb. 2024
  for (const m of text.matchAll(/(\d{1,2})(?:st|nd|rd|th)?(?:\s+day)?(?:\s+of)?\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})/g)) {
    const mo = month(m[2]!);
    if (mo) add(m.index, iso(Number(m[3]), mo, Number(m[1])));
  }
  // January 31, 2027
  for (const m of text.matchAll(/([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})/g)) {
    const mo = month(m[1]!);
    if (mo) add(m.index, iso(Number(m[3]), mo, Number(m[2])));
  }
  // 31/01/2027, 31-01-2027
  for (const m of text.matchAll(/(?<![\d/.-])(\d{1,2})[/-](\d{1,2})[/-](\d{4})(?![\d])/g)) add(m.index, iso(Number(m[3]), Number(m[2]), Number(m[1])));
  // 2027-01-31, 2027/01/31
  for (const m of text.matchAll(/(?<![\d/.-])(\d{4})[/-](\d{1,2})[/-](\d{1,2})(?![\d])/g)) add(m.index, iso(Number(m[1]), Number(m[2]), Number(m[3])));

  const seen = new Set<string>();
  return found
    .sort((a, b) => a.at - b.at)
    .map((f) => f.iso)
    .filter((d) => !seen.has(d) && !!seen.add(d));
}

// ---------------------------------------------------------------------------
// Numbers: 60, 8.5, 8,5, sixty, three (3), twenty-four, one hundred and eighty
// ---------------------------------------------------------------------------
const UNITS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
};
const TENS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };

/** Every number in the text, from digits (8.5 or 8,5) and from words up to 999. */
export function numbersIn(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(/\d+(?:[.,]\d+)?/g)) out.push(Number(m[0].replace(',', '.')));

  const words = text.toLowerCase().split(/[^a-z]+/).filter(Boolean);
  let cur = 0;
  let any = false;
  let afterHundred = false; // "one hundred and eighty": an "and" continues the number only after "hundred"
  let andSeen = false;
  const flush = () => {
    if (any) out.push(cur);
    cur = 0;
    any = false;
    afterHundred = false;
    andSeen = false;
  };
  for (const w of words) {
    if (w in UNITS || w in TENS) {
      if (andSeen && !afterHundred) flush();
      cur += w in UNITS ? UNITS[w]! : TENS[w]!;
      any = true;
      afterHundred = false;
      andSeen = false;
    } else if (w === 'hundred' && any) {
      cur = (cur || 1) * 100;
      afterHundred = true;
      andSeen = false;
    } else if (w === 'and' && any && afterHundred) andSeen = true;
    else flush();
  }
  flush();
  return out;
}
