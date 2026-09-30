// Contracts eval: parse → extract → buildRecord → score against expected.json and boxes.json.
//
// One command runs every sample and prints plain numbers:
//   npm run eval:contracts -- --parser llamaparse --extractor claude --repeat 3
// Usage: npm run eval:contracts -- [options] [sample]
//   --parser fixture|pdfjs|llamaparse   fixture replays a saved parse (default: fixture)
//   --tier cost_effective|agentic       LlamaParse tier. Default: the preset's tier, or its scanned tier for a sample marked "scanned": true
//   --extractor fixture:<name>|claude   fixture replays recorded/<name>.json (default fixture:extract-perfect)
//   --reparse                           parse again even if a saved parse exists
//   --record                            save Claude's output to recorded/extract-<model>.json (run 1) and -run2.json, -run3.json… so any run can be re-scored for free with --extractor fixture:extract-<model> --repeat N
//   --repeat N                          run the extractor N times; numbers are reported for every run, with the spread
//   --allow-offshore                    let live adapters run on a sample not marked "synthetic": true
//
// Parses are saved under <sample>/parsed/<parser>-<tier>/ and reused, so a LlamaParse run costs credits
// only the first time. Exit code 1 on any wrong field, missed or unexpected flag, or wrong date in any run.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildRecord, contractsInstructionsFor, contractsSchema, sameValue, validateContractsPreset,
  type AgreementRecord, type Extraction, type FieldKey,
} from '../../packages/contracts/src/index.ts';
import { createClaudeExtractor, createLlamaParseParser, documentFromSidecar, type ExtractResult, type LlamaParser, type ParsedDocument } from '../../packages/documents/src/index.ts';
import { createPdfjsParser } from '../../packages/documents/src/parsers/pdfjs.ts';
import { loadSecrets, pinnedVersions } from '../../scripts/env.ts';
import { addScore, emptyScore, pct, perfect, scoreAgreement, type Boxes, type Expected, type Score } from './score.ts';

const here = import.meta.dirname;
const root = join(here, '..', '..');
const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const flag = (name: string) => args.includes(`--${name}`);
const VALUE_OPTS = new Set(['--parser', '--tier', '--extractor', '--repeat']);
const only = args.filter((a, i) => !a.startsWith('--') && !VALUE_OPTS.has(args[i - 1] ?? ''))[0];

const parserName = opt('parser') ?? 'fixture';
const extractorName = opt('extractor') ?? 'fixture:extract-perfect';
const repeat = Math.max(1, Number(opt('repeat') ?? 1));
if (!['fixture', 'pdfjs', 'llamaparse'].includes(parserName)) throw new Error(`Unknown --parser ${parserName}`);
if (extractorName !== 'claude' && !extractorName.startsWith('fixture:')) throw new Error(`Unknown --extractor ${extractorName}`);

const preset = validateContractsPreset(JSON.parse(readFileSync(join(root, 'presets', 'contracts.default.json'), 'utf8')));
const readJson = (...p: string[]) => JSON.parse(readFileSync(join(...p), 'utf8'));

interface Sample { synthetic?: boolean; scanned?: boolean; asAt: string; organisation: string; agreements: { id: string; files: string[] }[] }

/** The tier a sample is read at: what the pipeline would use (a scanned agreement uses the scanned tier). */
const tierFor = (sample: Sample) => opt('tier') ?? (sample.scanned ? preset.parser.scannedTier : preset.parser.tier);

/** The saved-parse folder for this run's parser. fixture uses the first saved parse, preferring pdfjs. */
function parseDir(dir: string, tier: string): string {
  if (parserName === 'pdfjs') return join(dir, 'parsed', 'pdfjs-local');
  if (parserName === 'llamaparse') return join(dir, 'parsed', `llamaparse-${tier}`);
  const saved = existsSync(join(dir, 'parsed')) ? readdirSync(join(dir, 'parsed')).sort((a, b) => (a.startsWith('pdfjs') ? -1 : b.startsWith('pdfjs') ? 1 : a.localeCompare(b))) : [];
  if (!saved.length) throw new Error(`No saved parse in ${join(dir, 'parsed')}; run with --parser llamaparse (or pdfjs for digital PDFs) first`);
  return join(dir, 'parsed', saved[0]!);
}

/** A failure line with its category, counted across runs. */
const failures = new Map<string, number>();
const noteFailures = (sample: string, s: Score) => {
  const add = (kind: string, xs: string[]) => xs.forEach((x) => failures.set(`${kind}|${sample} · ${x}`, (failures.get(`${kind}|${sample} · ${x}`) ?? 0) + 1));
  add('field', s.fields.misses);
  add('highlight', s.highlights.misses);
  add('flag', [...s.flags.missed.map((m) => `missed ${m}`), ...s.flags.unexpected.map((u) => `unexpected ${u}`)]);
  add('date', [...s.dates.misses, ...s.dates.unexpected.map((u) => `unexpected ${u}`)]);
};

async function main() {
  const samples = readdirSync(here, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(here, d.name, 'sample.json')) && existsSync(join(here, d.name, 'expected.json')))
    .map((d) => d.name)
    .filter((n) => !only || n === only);
  if (!samples.length) throw new Error(only ? `No sample "${only}"` : 'No samples found');

  const live = parserName === 'llamaparse' || extractorName === 'claude';
  if (live) loadSecrets();
  const runTotals: Score[] = [];
  let failed = false;
  let credits = 0;
  const tokens = { input: 0, output: 0 };
  let model = extractorName;
  const changedFields: string[] = [];
  let llama: LlamaParser | undefined;

  for (const name of samples) {
    const dir = join(here, name);
    const sample: Sample = readJson(dir, 'sample.json');
    const expected: Expected = readJson(dir, 'expected.json');
    const boxes: Boxes | undefined = existsSync(join(dir, 'boxes.json')) ? readJson(dir, 'boxes.json') : undefined;
    const tier = tierFor(sample);

    if (live && sample.synthetic !== true && !flag('allow-offshore')) {
      console.log(`\n${name}: refused. Live adapters send documents offshore (LlamaParse, Claude API).`);
      console.log('  Real documents need the POPIA gates in docs/engine-architecture.md signed off first.');
      console.log('  Mark synthetic samples with "synthetic": true in sample.json, or pass --allow-offshore once the gates are in place.');
      failed = true;
      continue;
    }

    // Parse once; reuse the saved parse unless --reparse.
    let cacheDir = '';
    const parsed: Record<string, ParsedDocument> = {};
    let pages = 0;
    let sampleCredits = 0;
    try {
      cacheDir = parseDir(dir, tier);
      for (const a of sample.agreements) {
        for (const file of a.files) {
          const cache = join(cacheDir, file.replace(/\.pdf$/i, '.json'));
          // LlamaParse's raw sidecar is kept beside the parse (git-ignored), so the mapping can be run again for free.
          const raw = join(cacheDir, 'raw', file.replace(/\.pdf$/i, '.jsonl'));
          if (parserName === 'llamaparse' && existsSync(raw) && !flag('reparse')) {
            parsed[file] = documentFromSidecar(readFileSync(raw, 'utf8'), tier);
            writeFileSync(cache, JSON.stringify(parsed[file]) + '\n');
          } else if (existsSync(cache) && !flag('reparse')) parsed[file] = readJson(cache);
          else {
            if (parserName === 'fixture') throw new Error(`No saved parse for ${file} in ${cacheDir}`);
            mkdirSync(cacheDir, { recursive: true });
            const bytes = readFileSync(join(dir, file));
            if (parserName === 'pdfjs') {
              parsed[file] = await createPdfjsParser().parse(bytes, { filename: file, tier });
            } else {
              llama ??= createLlamaParseParser({ apiKey: process.env.LLAMA_CLOUD_API_KEY ?? '', baseUrl: process.env.LLAMA_CLOUD_BASE_URL, versions: pinnedVersions(), offshoreAllowed: true });
              const got = await llama.parseWithRaw(bytes, { filename: file, tier });
              parsed[file] = got.document;
              if (got.sidecar !== undefined) {
                mkdirSync(join(cacheDir, 'raw'), { recursive: true });
                writeFileSync(raw, got.sidecar);
              }
            }
            sampleCredits += parsed[file]!.creditsEstimate ?? 0;
            writeFileSync(cache, JSON.stringify(parsed[file]) + '\n');
          }
          pages += parsed[file]!.pageCount;
        }
      }
    } catch (err) {
      const e = err as Error & { code?: string };
      // A scan can't be read without an OCR parser, and a fixture run needs a saved parse: skip, don't fail.
      if (e.code === 'no_text_layer' || /No saved parse/.test(e.message)) {
        console.log(`\n${name}: skipped. ${e.code === 'no_text_layer' ? 'Scanned PDFs need --parser llamaparse.' : e.message}`);
        continue;
      }
      console.log(`\n${name}: could not parse: ${e.message}`);
      failed = true;
      continue;
    }
    credits += sampleCredits;

    // Extract, N times when asked.
    const runs: Record<string, Extraction>[] = [];
    for (let n = 0; n < repeat; n++) {
      if (extractorName.startsWith('fixture:')) {
        // Run 1 is <name>.json; further runs (from --record with --repeat) are <name>-run2.json, <name>-run3.json…
        const base = extractorName.slice('fixture:'.length);
        const file = join(dir, 'recorded', `${n === 0 ? base : `${base}-run${n + 1}`}.json`);
        if (!existsSync(file)) break;
        runs.push(readJson(file));
        continue;
      }
      const claude = createClaudeExtractor({ apiKey: process.env.ANTHROPIC_API_KEY ?? '', model: process.env.ANTHROPIC_MODEL ?? '', offshoreAllowed: true });
      const out: Record<string, Extraction> = {};
      for (const a of sample.agreements) {
        const result: ExtractResult = await claude.extract({
          instructions: contractsInstructionsFor(sample.organisation),
          schema: contractsSchema,
          pages: a.files.flatMap((file) => parsed[file]!.pages.map((p) => ({ file, page: p.page, text: p.text }))),
        });
        out[a.id] = result.output as Extraction;
        model = result.model;
        tokens.input += result.usage.input;
        tokens.output += result.usage.output;
      }
      runs.push(out);
      if (flag('record')) {
        mkdirSync(join(dir, 'recorded'), { recursive: true });
        const path = join(dir, 'recorded', n === 0 ? `extract-${model}.json` : `extract-${model}-run${n + 1}.json`);
        writeFileSync(path, JSON.stringify({ _note: `Recorded from ${model} on ${new Date().toISOString().slice(0, 10)}`, ...out }, null, 2) + '\n');
        console.log(`Recorded ${path}`);
      }
    }

    if (!runs.length) {
      console.log(`\n${name}: skipped. No recording ${extractorName.slice('fixture:'.length)}.json in ${join(dir, 'recorded')}.`);
      continue;
    }

    const build = (ex: Record<string, Extraction>) =>
      sample.agreements.map((a) =>
        buildRecord({ id: a.id, ref: a.id.toUpperCase(), files: a.files, parsed: Object.fromEntries(a.files.map((f) => [f, parsed[f]!])), extraction: ex[a.id] ?? { fields: {}, amendments: [] }, preset }),
      );
    const scoreRun = (records: AgreementRecord[]) => {
      let score = emptyScore();
      for (const r of records) {
        const exp = expected.agreements[r.id];
        if (exp) score = addScore(score, scoreAgreement(r.id, r, exp, sample.asAt, preset, parsed, boxes));
      }
      return score;
    };
    const built = runs.map(build);
    const scores = built.map(scoreRun);
    scores.forEach((s, i) => {
      runTotals[i] = addScore(runTotals[i] ?? emptyScore(), s);
      noteFailures(name, s);
      if (!perfect(s)) failed = true;
    });

    const files = sample.agreements.reduce((n, a) => n + a.files.length, 0);
    console.log(`\n${name}  (${sample.agreements.length} agreements, ${files} files, ${pages} pages · parser ${cacheDir.split(/[\\/]/).pop()} · extractor ${extractorName === 'claude' ? `claude (${model})` : extractorName})`);
    if (runs.length === 1) printScore(scores[0]!);
    else {
      for (const [i, s] of scores.entries()) console.log(`  run ${i + 1}      ${line(s)}`);
      const f = scores.map((s) => s.fields.correct);
      console.log(`  spread      fields ${Math.min(...f)}–${Math.max(...f)} of ${scores[0]!.fields.total} across ${runs.length} runs`);
      for (const [i, r] of built[0]!.entries()) {
        for (const key of Object.keys(r.fields) as FieldKey[]) {
          const values = built.map((rs) => rs[i]!.fields[key]);
          const first = values[0];
          if (values.some((v) => v?.status !== first?.status || (v?.value !== undefined && first?.value !== undefined ? !sameValue(v.value, first.value) : v?.value !== first?.value))) {
            changedFields.push(`${name} ${r.ref} ${key}`);
          }
        }
      }
    }
  }

  if (!runTotals.length) throw new Error('Nothing was scored');
  const all = runTotals.reduce((a, b) => addScore(a, b), emptyScore());
  const n = runTotals.length;

  console.log('\n──────────────── SUMMARY ────────────────');
  console.log('Per-field accuracy' + (n > 1 ? ` (all samples, all ${n} runs)` : ' (all samples)'));
  const keys = Object.keys(all.fields.byField).sort((a, b) => a.localeCompare(b));
  for (const k of keys) {
    const f = all.fields.byField[k]!;
    console.log(`  ${k.padEnd(14)} ${String(f.correct).padStart(3)}/${String(f.total).padEnd(3)} ${pct(f.correct, f.total).padStart(6)}`);
  }
  console.log(`\nGrounding match rate     ${all.grounding.grounded}/${all.grounding.total} (${pct(all.grounding.grounded, all.grounding.total)}): ${all.grounding.exact} exact, ${all.grounding.fuzzy} fuzzy; ${all.grounding.ambiguous} refused as appearing in more than one place; ${all.grounding.elsewhere} found on a different page than cited`);
  console.log(`Highlight on expected    ${all.highlights.ok}/${all.highlights.total} (${pct(all.highlights.ok, all.highlights.total)}); overlap-only rule: ${all.highlights.iouOk}/${all.highlights.total}; ${all.highlights.unlisted} more cited at places the answer key doesn't list (not scored)`);
  console.log(`Flags                    ${all.flags.found}/${all.flags.expected} expected found · ${all.flags.unexpected.length} unexpected`);
  console.log(`Key dates                ${all.dates.correct}/${all.dates.total} correct`);
  if (n > 1) {
    const f = runTotals.map((s) => s.fields.correct);
    const h = runTotals.map((s) => s.highlights.ok);
    console.log(`Run to run               fields ${f.join(' / ')} of ${runTotals[0]!.fields.total}; highlights ${h.join(' / ')} of ${runTotals[0]!.highlights.total}`);
    console.log(`Fields whose answer changed between runs: ${changedFields.length}${changedFields.length ? ` — ${changedFields.join(', ')}` : ''}`);
  }

  if (failures.size) {
    console.log(`\nEvery failure, with its reason${n > 1 ? ` (how many of ${n} runs)` : ''}:`);
    const order = ['field', 'flag', 'date', 'highlight'];
    for (const kind of order) {
      const rows = [...failures.entries()].filter(([k]) => k.startsWith(`${kind}|`)).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
      if (!rows.length) continue;
      console.log(`  ${kind === 'highlight' ? 'highlights' : kind + 's'} (${rows.length}):`);
      for (const [k, c] of rows) console.log(`    · ${k.slice(kind.length + 1)}${n > 1 ? `  [${c}/${n}]` : ''}`);
    }
  }

  console.log(
    `\nTOTAL  fields ${runTotals[0]!.fields.correct}/${runTotals[0]!.fields.total} · grounding ${runTotals[0]!.grounding.grounded}/${runTotals[0]!.grounding.total} (${pct(runTotals[0]!.grounding.grounded, runTotals[0]!.grounding.total)})` +
      ` · highlights ${runTotals[0]!.highlights.ok}/${runTotals[0]!.highlights.total} · flags ${runTotals[0]!.flags.found}/${runTotals[0]!.flags.expected} (${runTotals[0]!.flags.unexpected.length} unexpected)` +
      ` · key dates ${runTotals[0]!.dates.correct}/${runTotals[0]!.dates.total}${n > 1 ? ' (run 1)' : ''}`,
  );
  console.log(`COST   LlamaParse ~${credits} credits this run · Claude ${tokens.input} input / ${tokens.output} output tokens`);
  if (failed) process.exitCode = 1;
}

function line(s: Score) {
  return `fields ${s.fields.correct}/${s.fields.total} · grounding ${s.grounding.grounded}/${s.grounding.total} · highlights ${s.highlights.ok}/${s.highlights.total} · flags ${s.flags.found}/${s.flags.expected} (${s.flags.unexpected.length} unexpected) · key dates ${s.dates.correct}/${s.dates.total}`;
}

function printScore(s: Score) {
  const list = (xs: string[]) => xs.slice(0, 12).forEach((x) => console.log(`              · ${x}`));
  console.log(`  fields      ${s.fields.correct}/${s.fields.total} correct`);
  list(s.fields.misses);
  const g = s.grounding;
  console.log(`  grounding   ${g.grounded}/${g.total} quotes found (${pct(g.grounded, g.total)}): ${g.exact} exact, ${g.fuzzy} fuzzy · ${g.elsewhere} on a different page than claimed · ${g.ambiguous} ambiguous · value not in cited text: ${g.valueFailed}`);
  console.log(`  highlights  ${s.highlights.ok}/${s.highlights.total} sources on the expected box (overlap ≥ 0.5 or inside it) · ${s.highlights.unlisted} more cited at places the key doesn't list`);
  list(s.highlights.misses);
  console.log(`  flags       ${s.flags.found}/${s.flags.expected} found · ${s.flags.unexpected.length} unexpected`);
  list([...s.flags.missed.map((m) => `missed ${m}`), ...s.flags.unexpected.map((u) => `unexpected ${u}`)]);
  console.log(`  key dates   ${s.dates.correct}/${s.dates.total} correct${s.dates.unexpected.length ? ` · ${s.dates.unexpected.length} unexpected` : ''}`);
  list([...s.dates.misses, ...s.dates.unexpected.map((u) => `unexpected ${u}`)]);
}

main().catch((err) => {
  console.error(`${err.name ?? 'Error'}: ${err.message}`);
  process.exit(1);
});
