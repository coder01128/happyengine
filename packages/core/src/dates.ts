// Dates are UTC date-only strings ("2026-09-30"). No times, no local time zones.

export type IsoDate = string;

export type DateFormat = 'YYYY-MM-DD' | 'YYYY/MM/DD' | 'DD/MM/YYYY' | 'YYYYMMDD' | 'D MMM YYYY';

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const DAY_MS = 86_400_000;

function build(y: number, m: number, d: number, raw: string): IsoDate {
  const t = Date.UTC(y, m - 1, d);
  const check = new Date(t);
  if (
    !Number.isInteger(y) ||
    check.getUTCFullYear() !== y ||
    check.getUTCMonth() !== m - 1 ||
    check.getUTCDate() !== d
  ) {
    throw new Error(`Invalid date: "${raw}"`);
  }
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export function parseDate(raw: string, format: DateFormat): IsoDate {
  const s = raw.trim();
  let m: RegExpMatchArray | null;
  switch (format) {
    case 'YYYY-MM-DD':
    case 'YYYY/MM/DD':
      m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
      if (m) return build(+m[1]!, +m[2]!, +m[3]!, raw);
      break;
    case 'DD/MM/YYYY':
      m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})/);
      if (m) return build(+m[3]!, +m[2]!, +m[1]!, raw);
      break;
    case 'YYYYMMDD':
      m = s.match(/^(\d{4})(\d{2})(\d{2})/);
      if (m) return build(+m[1]!, +m[2]!, +m[3]!, raw);
      break;
    case 'D MMM YYYY':
      m = s.match(/^(\d{1,2})[\s-]([A-Za-z]{3})[A-Za-z]*[\s-](\d{4})$/);
      if (m) {
        const month = MONTHS.indexOf(m[2]!.toUpperCase()) + 1;
        if (month > 0) return build(+m[3]!, month, +m[1]!, raw);
      }
      break;
  }
  throw new Error(`Date "${raw}" does not match format ${format}`);
}

export function dayNumber(d: IsoDate): number {
  const [y, m, dd] = d.split('-').map(Number);
  return Date.UTC(y!, m! - 1, dd!) / DAY_MS;
}

export function daysBetween(a: IsoDate, b: IsoDate): number {
  return Math.abs(dayNumber(a) - dayNumber(b));
}

/** "2026-10-05" → "5 Oct 2026". */
export function formatDate(d: IsoDate): string {
  const [y, m, dd] = d.split('-').map(Number);
  const mon = MONTHS[m! - 1]!;
  return `${dd} ${mon[0]}${mon.slice(1).toLowerCase()} ${y}`;
}

function fromDayNumber(n: number): IsoDate {
  return new Date(n * DAY_MS).toISOString().slice(0, 10);
}

/** "2027-03-01" − 60 days → addDays("2027-03-01", -60) = "2026-12-31". */
export function addDays(d: IsoDate, n: number): IsoDate {
  return fromDayNumber(dayNumber(d) + n);
}

/**
 * Calendar months, clamped to the month end: 2026-01-31 + 1 month = 2026-02-28,
 * 2027-01-31 − 3 months = 2026-10-31. n may be negative.
 */
export function addMonths(d: IsoDate, n: number): IsoDate {
  const [y, m, dd] = d.split('-').map(Number);
  const total = y! * 12 + (m! - 1) + n;
  const year = Math.floor(total / 12);
  const month = total - year * 12 + 1;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${year}-${String(month).padStart(2, '0')}-${String(Math.min(dd!, lastDay)).padStart(2, '0')}`;
}

/** Today's calendar date in a time zone. The only function here that reads the clock. */
export function todayInZone(zone = 'Africa/Johannesburg', now: Date = new Date()): IsoDate {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}
