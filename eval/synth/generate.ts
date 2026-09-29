// Generates synthetic Month-End samples (bank export + cash book export + ground truth) into
// eval/month-end/synth-<level>-<seed>/. Deterministic: same seed, same files.
//
// Levels:
//   clean      references consistent on both sides (like the demo), at realistic volume
//   narrative  bank export has no reference column; references are buried in bank narratives,
//              debit orders carry the creditor's contract number, card lines carry no reference
//   messy      narrative + missing and mistyped references, split deposits, long clearing
//              delays, short payments, duplicate captures, old uncleared items, unrecorded deposits
//
// expected.json records what is TRUE, not what the engine can currently do, so the eval shows
// real gaps. Each true match carries a kind so the eval can break misses down.
//
// Usage: npm run synth

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

type Level = 'clean' | 'narrative' | 'messy';
type Kind =
  | 'clean_ref'
  | 'embedded_ref'
  | 'no_ref'
  | 'typo_ref'
  | 'debit_order'
  | 'card'
  | 'late_clearing'
  | 'split';

// ---------- deterministic randomness ----------

function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (min: number, max: number) => min + Math.floor(next() * (max - min + 1));
  return {
    int,
    chance: (p: number) => next() < p,
    pick: <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)]!,
    /** Rands between min and max; mostly whole rands, sometimes with cents. */
    cents: (minR: number, maxR: number) => int(minR, maxR) * 100 + (next() < 0.4 ? int(1, 99) : 0),
  };
}
type Rng = ReturnType<typeof rng>;

// ---------- made-up counterparties (fictional) ----------

const CUSTOMERS = [
  'Thaba Hardware', 'Kgosi Logistics', 'Umhlanga Dental', 'Protea Catering', 'Vaal Engineering',
  'Karoo Veterinary', 'Sediba Schools', 'Mosaic Interiors', 'Blouberg Physio', 'Ntsika Builders',
] as const;
const SUPPLIERS = [
  'Paper Mill Supplies', 'Inkjet Wholesale', 'Coastal Couriers', 'Highveld Packaging',
  'Riverbend Printing', 'Summit IT Services', 'Acacia Cleaning',
] as const;
const DEBIT_ORDERS = [
  { name: 'Office rent', creditor: 'MARULA PROPERTY TRUST', ref: 'RENT', minR: 18000, maxR: 38000 },
  { name: 'Business insurance', creditor: 'SAMPLE INSURE LTD', ref: 'INS', minR: 1200, maxR: 4800 },
  { name: 'Telephone and internet', creditor: 'SAMPLE TELECOM', ref: 'TEL', minR: 900, maxR: 3200 },
  { name: 'Accounting software', creditor: 'SAMPLE SOFTWARE SUBS', ref: 'SW', minR: 450, maxR: 1600 },
] as const;
const MERCHANTS = ['FUEL STOP', 'OFFICE DEPOT SAMPLE', 'HARDWARE CITY SAMPLE', 'CORNER CAFE'] as const;
const TOWNS = ['JOHANNESBURG', 'MIDRAND', 'RANDBURG', 'SANDTON', 'BOKSBURG'] as const;
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

// ---------- dates (UTC day numbers) ----------

const DAY = 86_400_000;
const dayOf = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d) / DAY;
const iso = (day: number) => new Date(day * DAY).toISOString().slice(0, 10);

// ---------- model ----------

interface Row {
  key: string;
  day: number;
  amount: number;
  description: string;
  reference: string;
}
interface Truth {
  matched: [string, string, Kind][];
  exceptions: { type: string; bank?: string; ledger?: string }[];
}

function buildMonth(level: Level, r: Rng, year: number, month: number) {
  const first = dayOf(year, month, 1);
  const last = dayOf(year, month + 1, 1) - 1;
  const mm = String(month).padStart(2, '0');
  const mon = MONTHS[month - 1]!;
  const bank: Row[] = [];
  const ledger: Row[] = [];
  const truth: Truth = { matched: [], exceptions: [] };
  let k = 0;
  const key = () => `k${++k}`;
  const narrative = level !== 'clean';
  const messy = level === 'messy';
  const invFmt = (n: number) => r.pick([`INV${n}`, `INV-${n}`, `INV ${n}`, `inv${n}`]);
  const addB = (row: Omit<Row, 'key'>) => {
    const b = { key: key(), ...row, description: row.description.toUpperCase() };
    bank.push(b);
    return b;
  };
  const addL = (row: Omit<Row, 'key'>) => {
    const l = { key: key(), ...row };
    ledger.push(l);
    return l;
  };
  /** Bank date for a ledger item, or null if it clears after period end. */
  const clears = (ledgerDay: number, delay: number) => (ledgerDay + delay <= last ? ledgerDay + delay : null);

  // Customer receipts
  let inv = r.int(3000, 6000);
  const receipts = r.int(12, 20);
  for (let i = 0; i < receipts; i++) {
    const n = inv++;
    const cust = r.pick(CUSTOMERS);
    const amount = r.cents(1500, 45000);
    const lDay = r.int(first, last);
    const l = addL({ day: lDay, amount, description: `Receipt — ${cust}`, reference: `INV-${n}` });
    let delay = r.chance(0.6) ? 0 : r.int(1, 3);
    let kind: Kind = narrative ? 'embedded_ref' : 'clean_ref';
    let desc = narrative ? `${r.pick(['ACB CREDIT', 'IB PAYMENT FROM', 'CREDIT TRANSFER', 'MAGTAPE CREDIT'])} ${cust} ${invFmt(n)}` : `Deposit — ${cust}`;

    if (messy) {
      const roll = r.int(1, 100);
      if (roll <= 18) {
        kind = 'no_ref';
        desc = `${r.pick(['ACB CREDIT', 'IB PAYMENT FROM', 'CREDIT TRANSFER'])} ${cust} PAYMENT`;
      } else if (roll <= 26) {
        kind = 'typo_ref';
        const s = String(n);
        const typo = s.slice(0, 2) + s[3] + s[2] + s.slice(4); // swap 3rd and 4th digits
        desc = `IB PAYMENT FROM ${cust} INV${typo === s ? n + 10 : typo}`;
      } else if (roll <= 32) {
        kind = 'late_clearing';
        delay = r.int(4, 6);
      }
    }
    const bDay = clears(lDay, delay);
    if (bDay === null) {
      truth.exceptions.push({ type: 'timing', ledger: l.key }); // genuinely in transit
      continue;
    }
    const b = addB({ day: bDay, amount, description: desc, reference: narrative ? '' : `INV-${n}` });
    truth.matched.push([b.key, l.key, kind]);
  }

  // Short payment: customer pays less than the invoice (same reference) → amount difference
  {
    const n = inv++;
    const cust = r.pick(CUSTOMERS);
    const amount = r.cents(5000, 30000);
    const short = r.pick([5000, 9000, 25000, r.int(10, 400) * 100]);
    const lDay = r.int(first, last - 6);
    const l = addL({ day: lDay, amount, description: `Receipt — ${cust}`, reference: `INV-${n}` });
    const b = addB({
      day: lDay + r.int(0, 2),
      amount: amount - short,
      description: narrative ? `ACB CREDIT ${cust} ${invFmt(n)}` : `Deposit — ${cust}`,
      reference: narrative ? '' : `INV-${n}`,
    });
    truth.exceptions.push({ type: 'amount_difference', bank: b.key, ledger: l.key });
  }

  // Split deposit: one bank credit settles two invoices
  if (messy) {
    const cust = r.pick(CUSTOMERS);
    const n1 = inv++;
    const n2 = inv++;
    const a1 = r.cents(2000, 15000);
    const a2 = r.cents(2000, 15000);
    const lDay = r.int(first + 2, last - 6);
    const l1 = addL({ day: lDay, amount: a1, description: `Receipt — ${cust}`, reference: `INV-${n1}` });
    const l2 = addL({ day: lDay, amount: a2, description: `Receipt — ${cust}`, reference: `INV-${n2}` });
    const b = addB({ day: lDay + r.int(0, 2), amount: a1 + a2, description: `IB PAYMENT FROM ${cust} INV${n1} ${n2}`, reference: '' });
    truth.matched.push([b.key, l1.key, 'split'], [b.key, l2.key, 'split']);
  }

  // Deposit on the statement not yet captured in the cash book
  if (messy) {
    const n = inv++;
    const b = addB({ day: last - r.int(0, 1), amount: r.cents(1500, 20000), description: `ACB CREDIT ${r.pick(CUSTOMERS)} INV${n}`, reference: '' });
    truth.exceptions.push({ type: 'not_in_ledger', bank: b.key });
  }

  // Supplier payments
  let pmt = r.int(1000, 9000);
  const payments = r.int(8, 14);
  let duplicated = false;
  for (let i = 0; i < payments; i++) {
    const p = `PMT-${pmt++}`;
    const sup = r.pick(SUPPLIERS);
    const amount = -r.cents(800, 60000);
    const lDay = r.int(first, last);
    const l = addL({ day: lDay, amount, description: `Payment — ${sup}`, reference: p });
    const bDay = clears(lDay, r.chance(0.7) ? 0 : r.int(1, 2));
    if (bDay === null) {
      truth.exceptions.push({ type: 'timing', ledger: l.key });
      continue;
    }
    const b = addB({
      day: bDay,
      amount,
      description: narrative ? `${r.pick(['IB PAYMENT TO', 'DIGITAL PAYMENT DT', 'EFT'])} ${sup} ${p.replace('-', r.pick(['', '-', ' ']))}` : `EFT — ${sup}`,
      reference: narrative ? '' : p,
    });
    truth.matched.push([b.key, l.key, narrative ? 'embedded_ref' : 'clean_ref']);
    if (!duplicated && lDay < last - 5 && r.chance(0.5)) {
      duplicated = true;
      const dup = addL({ day: lDay, amount, description: `Payment — ${sup}`, reference: p });
      truth.exceptions.push({ type: 'possible_duplicate', ledger: dup.key });
    }
  }

  // Old uncleared payment (e.g. a cheque never presented) → needs review
  if (messy) {
    const l = addL({ day: first + r.int(0, 8), amount: -r.cents(500, 6000), description: `Cheque — ${r.pick(SUPPLIERS)}`, reference: `CHQ-${r.int(100, 999)}` });
    truth.exceptions.push({ type: 'not_on_statement', ledger: l.key });
  }

  // Debit orders
  for (const d of DEBIT_ORDERS) {
    const amount = -r.cents(d.minR, d.maxR);
    const bDay = first + r.int(0, 4);
    const lDay = messy ? first : bDay; // messy bookkeepers post debit orders on the 1st
    const lRef = `${d.ref}-${mm}`;
    const l = addL({ day: lDay, amount, description: `${d.name} — ${mon.charAt(0)}${mon.slice(1).toLowerCase()}`, reference: lRef });
    const contract = `${r.int(10000000, 99999999)}`;
    const b = addB({
      day: bDay,
      amount,
      description: narrative ? `DEBIT ORDER ${d.creditor} ${contract}` : `Debit order — ${d.name}`,
      reference: narrative ? '' : lRef,
    });
    truth.matched.push([b.key, l.key, narrative ? 'debit_order' : 'clean_ref']);
  }

  // Card purchases
  const cards = r.int(3, 8);
  for (let i = 0; i < cards; i++) {
    const merchant = r.pick(MERCHANTS);
    const amount = -r.cents(80, 1800);
    const day = r.int(first, last - 2);
    const lRef = `CARD-${iso(day).slice(5).replace('-', '')}-${i + 1}`;
    const l = addL({ day, amount, description: merchant === 'FUEL STOP' ? 'Fuel' : `Card — ${merchant.replace(' SAMPLE', '').toLowerCase()}`, reference: lRef });
    const bDay = day + (messy ? r.int(0, 2) : 0);
    const b = addB({
      day: bDay,
      amount,
      description: narrative ? `POS PURCHASE ${merchant} ${r.pick(TOWNS)} 4417*${r.int(1000, 9999)}` : `Card — ${merchant}`,
      reference: narrative ? '' : lRef,
    });
    truth.matched.push([b.key, l.key, narrative ? 'card' : 'clean_ref']);
  }

  // Salaries (reference used on both sides)
  {
    const amount = -r.cents(45000, 180000);
    const day = last - r.int(3, 6);
    const l = addL({ day, amount, description: `Salaries — ${mon}`, reference: `SAL-${mm}` });
    const b = addB({ day, amount, description: narrative ? `SALARIES ${mon} SAL-${mm}` : `EFT — Salaries ${mon}`, reference: narrative ? '' : `SAL-${mm}` });
    truth.matched.push([b.key, l.key, narrative ? 'embedded_ref' : 'clean_ref']);
  }

  // Bank-only lines: fees and interest
  const fees = narrative ? ['MONTHLY ACCOUNT FEE', '#SERVICE FEES', 'CASH DEPOSIT FEE'] : ['Service fees'];
  for (const f of fees.slice(0, messy ? 3 : narrative ? 2 : 1)) {
    const b = addB({ day: last, amount: -r.cents(15, 250), description: f, reference: narrative ? '' : 'FEES' });
    truth.exceptions.push({ type: 'not_in_ledger', bank: b.key });
  }
  {
    const b = addB({ day: last, amount: r.int(500, 9000), description: narrative ? 'CREDIT INTEREST' : 'Interest received', reference: narrative ? '' : 'INT' });
    truth.exceptions.push({ type: 'not_in_ledger', bank: b.key });
  }

  return { bank, ledger, truth, periodEnd: iso(last) };
}

// ---------- output formats ----------

const money = (c: number, decimal: '.' | ',', group: string) => {
  const abs = Math.abs(c);
  const r = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, group);
  return `${c < 0 ? '-' : ''}${r}${decimal}${String(abs % 100).padStart(2, '0')}`;
};
const cell = (v: string, delim: string) => (/["\n]/.test(v) || v.includes(delim) ? `"${v.replace(/"/g, '""')}"` : v);
const csv = (rows: string[][], delim = ',') => rows.map((r) => r.map((v) => cell(v, delim)).join(delim)).join('\r\n') + '\r\n';
const dmy = (day: number) => iso(day).split('-').reverse().join('/');
const dMonY = (day: number) => {
  const [y, m, d] = iso(day).split('-').map(Number);
  const mon = MONTHS[m! - 1]!;
  return `${d} ${mon.charAt(0)}${mon.slice(1).toLowerCase()} ${y}`;
};

type BankFormat = 'A' | 'B' | 'C';
type LedgerFormat = 'X' | 'Y';

function writeBank(fmt: BankFormat, rows: Row[], opening: number) {
  let bal = opening;
  const withBal = rows.map((r) => ({ r, bal: (bal += r.amount) }));
  if (fmt === 'A') {
    return csv([
      ['Sample Bank Ltd', 'Statement'],
      ['Account', 'Business current account •••• 4417'],
      ['Opening balance', money(opening, '.', ' ')],
      [],
      ['Date', 'Description', 'Reference', 'Amount', 'Balance'],
      ...withBal.map(({ r, bal }) => [dmy(r.day), r.description, r.reference, money(r.amount, '.', ''), money(bal, '.', '')]),
      ['', 'Closing balance', '', '', money(bal, '.', '')],
    ]);
  }
  if (fmt === 'B') {
    return csv([
      ['ACC-NO', '•••• 4417'],
      ['OPEN', money(opening, '.', '')],
      ['Date', 'Amount', 'Balance', 'Description'],
      ...withBal.map(({ r, bal }) => [iso(r.day), money(r.amount, '.', ''), money(bal, '.', ''), r.description]),
    ]);
  }
  return csv(
    [
      ['Sample Bank Ltd — Transaction history'],
      ['Transaction Date', 'Description', 'Debit', 'Credit', 'Balance'],
      ...withBal.map(({ r, bal }) => [
        dMonY(r.day),
        r.description,
        r.amount < 0 ? money(-r.amount, ',', ' ') : '',
        r.amount > 0 ? money(r.amount, ',', ' ') : '',
        money(bal, ',', ' '),
      ]),
    ],
    ';',
  );
}

function writeLedger(fmt: LedgerFormat, rows: Row[]) {
  if (fmt === 'X') {
    return csv([
      ['Accounting system export (sample)', 'Cash book', 'Bank'],
      ['Date', 'Reference', 'Description', 'Receipts', 'Payments'],
      ...rows.map((r) => [dmy(r.day), r.reference, r.description, r.amount > 0 ? money(r.amount, '.', '') : '', r.amount < 0 ? money(-r.amount, '.', '') : '']),
    ]);
  }
  return csv([['Date', 'Ref', 'Details', 'Amount'], ...rows.map((r) => [iso(r.day), r.reference, r.description, money(r.amount, '.', ',')])]);
}

const BANK_MAPPING = {
  A: { dateFormat: 'DD/MM/YYYY', date: 'Date', description: 'Description', reference: 'Reference', amount: 'Amount' },
  B: { dateFormat: 'YYYY-MM-DD', date: 'Date', description: 'Description', amount: 'Amount' },
  C: { delimiter: ';', dateFormat: 'D MMM YYYY', date: 'Transaction Date', description: 'Description', inflow: 'Credit', outflow: 'Debit' },
};
const LEDGER_MAPPING = {
  X: { dateFormat: 'DD/MM/YYYY', date: 'Date', description: 'Description', reference: 'Reference', inflow: 'Receipts', outflow: 'Payments' },
  Y: { dateFormat: 'YYYY-MM-DD', date: 'Date', description: 'Details', reference: 'Ref', amount: 'Amount' },
};

// ---------- main ----------

const PLAN: { level: Level; seed: number; bank: BankFormat; ledger: LedgerFormat; month: number }[] = [
  { level: 'clean', seed: 11, bank: 'A', ledger: 'X', month: 7 },
  { level: 'clean', seed: 12, bank: 'A', ledger: 'Y', month: 8 },
  { level: 'narrative', seed: 21, bank: 'B', ledger: 'X', month: 7 },
  { level: 'narrative', seed: 22, bank: 'B', ledger: 'Y', month: 8 },
  { level: 'messy', seed: 31, bank: 'C', ledger: 'X', month: 7 },
  { level: 'messy', seed: 32, bank: 'C', ledger: 'Y', month: 8 },
];

const outRoot = join(import.meta.dirname, '..', 'month-end');
const byDay = (a: Row, b: Row) => a.day - b.day;

for (const p of PLAN) {
  const r = rng(p.seed);
  const m = buildMonth(p.level, r, 2026, p.month);
  // Stable sort keeps generation order within a day, like a real export.
  const bank = [...m.bank].sort(byDay);
  const ledger = [...m.ledger].sort(byDay);
  const ids = new Map<string, string>();
  bank.forEach((b, i) => ids.set(b.key, `s${i + 1}`));
  ledger.forEach((l, i) => ids.set(l.key, `l${i + 1}`));
  const id = (k?: string) => (k ? ids.get(k) : undefined);

  const opening = r.cents(40000, 400000);
  const name = `synth-${p.level}-${p.seed}`;
  const dir = join(outRoot, name);
  mkdirSync(dir, { recursive: true });

  writeFileSync(join(dir, 'bank.csv'), writeBank(p.bank, bank, opening));
  writeFileSync(join(dir, 'ledger.csv'), writeLedger(p.ledger, ledger));
  writeFileSync(
    join(dir, 'sample.json'),
    JSON.stringify(
      {
        description: `Synthetic (${p.level}, seed ${p.seed}, bank format ${p.bank}, ledger format ${p.ledger}). Not client data. Generated by eval/synth/generate.ts.`,
        periodEnd: m.periodEnd,
        opening: { bank: opening, ledger: opening },
        sources: { bank: BANK_MAPPING[p.bank], ledger: LEDGER_MAPPING[p.ledger] },
        matching: { referencePatterns: ['\\bINV[- ]?\\d+\\b', '\\bPMT[- ]?\\d+\\b', '\\bSAL-\\d+\\b'] },
      },
      null,
      2,
    ) + '\n',
  );
  const expected = {
    matched: m.truth.matched.map(([b, l, kind]) => [id(b), id(l), kind]),
    exceptions: m.truth.exceptions.map((e) => ({ type: e.type, ...(e.bank && { bank: id(e.bank) }), ...(e.ledger && { ledger: id(e.ledger) }) })),
  };
  writeFileSync(join(dir, 'expected.json'), JSON.stringify(expected, null, 2) + '\n');
  console.log(`${name}: ${bank.length} statement lines, ${ledger.length} cash book entries, ${expected.matched.length} true matches, ${expected.exceptions.length} true exceptions`);
}
