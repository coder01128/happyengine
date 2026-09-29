// Runs Month-End matching on every sample in eval/month-end/ and compares with expected.json.
// Usage: npm run eval                    (all samples)
//        npm run eval -- <name>          (one sample)
//        npm run eval -- --verbose       (list every miss, not just the first few)
// Exit code 1 if any sample has a missed or wrong result. A true pair that Rule 5 suggests
// counts as found (a person confirms it); a suggestion of a false pair counts as wrong.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  formatRand,
  linesFromCsv,
  linesFromOfx,
  reconcile,
  runMatching,
  validatePreset,
  type Line,
  type MonthEndPreset,
  type Side,
} from '../packages/engine/src/index.ts';

interface Sample {
  description?: string;
  periodEnd: string;
  opening: { bank: number; ledger: number };
  /** Per-sample column mappings, each replacing the default preset's (real exports differ per bank). */
  sources?: Partial<MonthEndPreset['sources']>;
  matching?: Partial<MonthEndPreset['matching']>;
}
interface Expected {
  /** [bank id, ledger id] or [bank id, ledger id, kind] — kind is optional, used for the breakdown. */
  matched: ([string, string] | [string, string, string])[];
  exceptions: { type: string; bank?: string; ledger?: string }[];
  difference?: number;
}

const root = join(import.meta.dirname, 'month-end');
const readJson = <T>(p: string): T => JSON.parse(readFileSync(p, 'utf8')) as T;
const basePreset = readJson<MonthEndPreset>(join(import.meta.dirname, '..', 'presets', 'month-end.default.json'));

function load(dir: string, side: Side, prefix: string, preset: MonthEndPreset): Line[] {
  const name = side === 'bank' ? 'bank' : 'ledger';
  const ofx = join(dir, `${name}.ofx`);
  if (existsSync(ofx)) return linesFromOfx(readFileSync(ofx, 'utf8'), side, prefix);
  return linesFromCsv(readFileSync(join(dir, `${name}.csv`), 'utf8'), preset.sources[side], side, prefix);
}

const pairKey = (b?: string, l?: string) => `${b}↔${l}`;
const excKey = (x: { type: string; bank?: string; ledger?: string }) => `${x.type} ${x.bank ?? '-'} ${x.ledger ?? '-'}`;

const args = process.argv.slice(2);
const verbose = args.includes('--verbose');
const only = args.find((a) => !a.startsWith('--'));
const DETAIL_LIMIT = 6;
const listSome = (label: string, keys: string[]) => {
  for (const k of verbose ? keys : keys.slice(0, DETAIL_LIMIT)) console.log(`    ${label} ${k}`);
  if (!verbose && keys.length > DETAIL_LIMIT) console.log(`    ${label} … and ${keys.length - DETAIL_LIMIT} more (--verbose)`);
};

type Tally = { auto: number; suggested: number; all: number };
const kindTotals = new Map<string, Tally>();
const typeTotals = new Map<string, Tally>();
const tally = (m: Map<string, Tally>, k: string, how: 'auto' | 'suggested' | 'missed') => {
  const t = m.get(k) ?? { auto: 0, suggested: 0, all: 0 };
  t.all++;
  if (how === 'auto') t.auto++;
  if (how === 'suggested') t.suggested++;
  m.set(k, t);
};

const samples = readdirSync(root, { withFileTypes: true })
  .filter((d) => d.isDirectory() && (!only || d.name === only))
  .map((d) => d.name)
  .sort();

if (!samples.length) {
  console.error(only ? `No sample named "${only}" in eval/month-end/` : 'No samples in eval/month-end/');
  process.exit(1);
}

const totals = { pairs: 0, auto: 0, suggested: 0, wrongSuggestions: 0, exc: 0, excOk: 0, failed: 0, perfect: 0 };

for (const name of samples) {
  const dir = join(root, name);
  const sample = readJson<Sample>(join(dir, 'sample.json'));
  const expected = readJson<Expected>(join(dir, 'expected.json'));
  const preset: MonthEndPreset = {
    ...basePreset,
    // A sample's column mapping replaces the default one whole: merging would leak default columns in.
    sources: {
      bank: sample.sources?.bank ?? basePreset.sources.bank,
      ledger: sample.sources?.ledger ?? basePreset.sources.ledger,
    },
    matching: { ...basePreset.matching, ...sample.matching },
  };
  const problems = validatePreset(preset);
  if (problems.length) {
    console.log(`\n${name}\n  PRESET INVALID: ${problems.join('; ')}`);
    totals.failed++;
    continue;
  }

  let bank: Line[], ledger: Line[];
  try {
    bank = load(dir, 'bank', 's', preset);
    ledger = load(dir, 'ledger', 'l', preset);
  } catch (err) {
    console.log(`\n${name}\n  IMPORT FAILED: ${(err as Error).message}`);
    totals.failed++;
    continue;
  }

  const result = runMatching({ bank, ledger, preset, periodEnd: sample.periodEnd });
  const panel = reconcile({
    openingBank: sample.opening.bank,
    openingLedger: sample.opening.ledger,
    bank,
    ledger,
    result,
    preset,
    decisions: {},
  });

  const truePairs = new Set(expected.matched.map(([b, l]) => pairKey(b, l)));
  const auto = new Set(result.matched.map((m) => pairKey(m.bankId, m.ledgerId)));
  // A suggested split counts as one suggested pair per part.
  const suggested = new Set(
    result.exceptions.flatMap((e) =>
      e.type === 'suggested_match'
        ? [pairKey(e.bankId, e.ledgerId)]
        : e.type === 'suggested_split'
          ? (e.ledgerIds ?? []).map((l) => pairKey(e.bankId, l))
          : [],
    ),
  );
  const how = (k: string) => (auto.has(k) ? 'auto' : suggested.has(k) ? 'suggested' : 'missed');
  const missedPairs = [...truePairs].filter((k) => how(k) === 'missed');
  const wrongAuto = [...auto].filter((k) => !truePairs.has(k));
  const wrongSuggested = [...suggested].filter((k) => !truePairs.has(k));

  const trueExc = new Set(expected.exceptions.map(excKey));
  const producedExc = new Set(
    result.exceptions
      .filter((x) => x.type !== 'suggested_match' && x.type !== 'suggested_split')
      .map((x) => excKey({ type: x.type, bank: x.bankId, ledger: x.ledgerId })),
  );
  const missedExc = [...trueExc].filter((k) => !producedExc.has(k));
  const wrongExc = [...producedExc].filter((k) => !trueExc.has(k));

  const diffOk = expected.difference === undefined || expected.difference === panel.difference;
  const bad = missedPairs.length + wrongAuto.length + wrongSuggested.length + missedExc.length + wrongExc.length + (diffOk ? 0 : 1);
  const autoOk = [...truePairs].filter((k) => how(k) === 'auto').length;
  const suggestedOk = [...truePairs].filter((k) => how(k) === 'suggested').length;

  console.log(`\n${name}  (${bank.length} statement lines, ${ledger.length} cash book entries)`);
  console.log(
    `  matches     ${autoOk + suggestedOk}/${truePairs.size} found (${autoOk} auto · ${suggestedOk} suggested) · ` +
      `${missedPairs.length} missed · ${wrongAuto.length} wrong`,
  );
  if (suggested.size) console.log(`  suggestions ${suggestedOk}/${suggested.size} correct · ${wrongSuggested.length} wrong`);
  console.log(
    `  exceptions  ${trueExc.size - missedExc.length}/${trueExc.size} correct · ${missedExc.length} missed · ${wrongExc.length} wrong`,
  );
  console.log(
    `  difference  ${formatRand(panel.difference)} before review` +
      (expected.difference === undefined ? '' : ` (expected ${formatRand(expected.difference)}) ${diffOk ? 'OK' : 'WRONG'}`),
  );
  listSome('missed match     ', missedPairs);
  listSome('wrong match      ', wrongAuto);
  listSome('wrong suggestion ', wrongSuggested);
  listSome('missed flag      ', missedExc);
  listSome('wrong flag       ', wrongExc);

  for (const [b, l, kind] of expected.matched) if (kind) tally(kindTotals, kind, how(pairKey(b, l)));
  for (const x of expected.exceptions) tally(typeTotals, x.type, producedExc.has(excKey(x)) ? 'auto' : 'missed');

  totals.pairs += truePairs.size;
  totals.auto += autoOk;
  totals.suggested += suggestedOk;
  totals.wrongSuggestions += wrongSuggested.length;
  totals.exc += trueExc.size;
  totals.excOk += trueExc.size - missedExc.length;
  totals.failed += bad ? 1 : 0;
  totals.perfect += bad ? 0 : 1;
}

console.log(
  `\nTOTAL  matches ${totals.auto + totals.suggested}/${totals.pairs} found (${totals.auto} auto · ${totals.suggested} suggested) · ` +
    `${totals.wrongSuggestions} wrong suggestions · exceptions ${totals.excOk}/${totals.exc} · ` +
    `${totals.perfect}/${samples.length} samples fully correct`,
);

const pct = (n: number, d: number) => `${Math.round((100 * n) / d)}%`.padStart(5);
const found = (t: Tally) => (t.auto + t.suggested) / t.all;
console.log('\nTrue matches by kind (worst first)          auto  suggested  missed');
for (const [k, t] of [...kindTotals].sort((a, b) => found(a[1]) - found(b[1]))) {
  console.log(
    `  ${k.padEnd(20)} ${String(t.all).padStart(4)} lines  ${pct(t.auto, t.all)}  ${pct(t.suggested, t.all)}      ${pct(t.all - t.auto - t.suggested, t.all)}`,
  );
}
if (typeTotals.size) {
  console.log('\nTrue exceptions flagged, by type (worst first)');
  for (const [k, t] of [...typeTotals].sort((a, b) => a[1].auto / a[1].all - b[1].auto / b[1].all)) {
    console.log(`  ${k.padEnd(20)} ${String(t.auto).padStart(4)}/${String(t.all).padEnd(4)} ${pct(t.auto, t.all)}`);
  }
}
process.exit(totals.failed ? 1 : 0);
