// Contracts eval: parse → extract → buildRecord → score against expected.json and boxes.json.
//
// Usage: npm run eval:contracts -- [options] [sample]
//   --parser fixture|pdfjs|llamaparse   fixture replays a saved parse (default: fixture)
//   --tier cost_effective|agentic       LlamaParse tier (default cost_effective)
//   --extractor fixture:<name>|claude   fixture replays recorded/<name>.json (default fixture:extract-perfect)
//   --reparse                           parse again even if a saved parse exists
//   --record                            save Claude's output to recorded/extract-<model>.json
//   --repeat N                          run the extractor N times and report fields that changed
//   --allow-offshore                    let live adapters run on a sample not marked "synthetic": true
//
// Parses are saved under <sample>/parsed/<parser>-<tier>/ and reused, so a LlamaParse run costs credits
// only the first time. Exit code 1 on any wrong field, missed or unexpected flag, or wrong date.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildRecord, contractsInstructions, contractsSchema, sameValue, validateContractsPreset,
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

interface Sample { synthetic?: boolean; asAt: string; organisation: string; agreements: { id: string; files: string[] }[] }

/** The saved-parse folder for this run's parser. fixture uses the first saved parse, preferring pdfjs. */
function parseDir(dir: string): string {
  if (parserName === 'pdfjs') return join(dir, 'parsed', 'pdfjs-local');
  if (parserName === 'llamaparse') return join(dir, 'parsed', `llamaparse-${opt('tier') ?? 'cost_effective'}`);
  const saved = existsSync(join(dir, 'parsed')) ? readdirSync(join(dir, 'parsed')).sort((a, b) => (a.startsWith('pdfjs') ? -1 : b.startsWith('pdfjs') ? 1 : a.localeCompare(b))) : [];
  if (!saved.length) throw new Error(`No saved parse in ${join(dir, 'parsed')}; run with --parser llamaparse (or pdfjs for digital PDFs) first`);
  return join(dir, 'parsed', saved[0]!);
}

async function main() {
  const samples = readdirSync(here, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(here, d.name, 'sample.json')) && existsSync(join(here, d.name, 'expected.json')))
    .map((d) => d.name)
    .filter((n) => !only || n === only);
  if (!samples.length) throw new Error(only ? `No sample "${only}"` : 'No samples found');

  const live = parserName === 'llamaparse' || extractorName === 'claude';
  if (live) loadSecrets();
  let total = emptyScore();
  let failed = false;
  let credits = 0;
  const tokens = { input: 0, output: 0 };

  for (const name of samples) {
    const dir = join(here, name);
    const sample: Sample = readJson(dir, 'sample.json');
    const expected: Expected = readJson(dir, 'expected.json');
    const boxes: Boxes | undefined = existsSync(join(dir, 'boxes.json')) ? readJson(dir, 'boxes.json') : undefined;

    if (live && sample.synthetic !== true && !flag('allow-offshore')) {
      console.log(`\n${name}: refused. Live adapters send documents offshore (LlamaParse, Claude API).`);
      console.log('  Real documents need the POPIA gates in docs/engine-architecture.md signed off first.');
      console.log('  Mark synthetic samples with "synthetic": true in sample.json, or pass --allow-offshore once the gates are in place.');
      failed = true;
      continue;
    }

    // Parse once; reuse the saved parse unless --reparse.
    let cacheDir = '';
    let llama: LlamaParser | undefined;
    const parsed: Record<string, ParsedDocument> = {};
    let pages = 0;
    let sampleCredits = 0;
    try {
      cacheDir = parseDir(dir);
      for (const a of sample.agreements) {
        for (const file of a.files) {
          const cache = join(cacheDir, file.replace(/\.pdf$/i, '.json'));
          // LlamaParse's raw sidecar is kept beside the parse (git-ignored), so the mapping can be run again for free.
          const raw = join(cacheDir, 'raw', file.replace(/\.pdf$/i, '.jsonl'));
          const tier = opt('tier') ?? 'cost_effective';
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
    let model = extractorName;
    for (let n = 0; n < repeat; n++) {
      if (extractorName.startsWith('fixture:')) {
        const file = join(dir, 'recorded', `${extractorName.slice('fixture:'.length)}.json`);
        if (!existsSync(file)) break;
        runs.push(readJson(file));
        continue;
      }
      const claude = createClaudeExtractor({ apiKey: process.env.ANTHROPIC_API_KEY ?? '', model: process.env.ANTHROPIC_MODEL ?? '', offshoreAllowed: true });
      const out: Record<string, Extraction> = {};
      for (const a of sample.agreements) {
        const result: ExtractResult = await claude.extract({
          instructions: contractsInstructions,
          schema: contractsSchema,
          pages: a.files.flatMap((file) => parsed[file]!.pages.map((p) => ({ file, page: p.page, text: p.text }))),
        });
        out[a.id] = result.output as Extraction;
        model = result.model;
        tokens.input += result.usage.input;
        tokens.output += result.usage.output;
      }
      runs.push(out);
      if (flag('record') && n === 0) {
        mkdirSync(join(dir, 'recorded'), { recursive: true });
        const path = join(dir, 'recorded', `extract-${model}.json`);
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
    const records: AgreementRecord[] = build(runs[0]!);

    let score = emptyScore();
    for (const r of records) {
      const exp = expected.agreements[r.id];
      if (!exp) continue;
      score = addScore(score, scoreAgreement(r.id, r, exp, sample.asAt, preset, parsed, boxes));
    }
    total = addScore(total, score);
    if (!perfect(score)) failed = true;

    const files = sample.agreements.reduce((n, a) => n + a.files.length, 0);
    console.log(`\n${name}  (${sample.agreements.length} agreements, ${files} files, ${pages} pages · parser ${cacheDir.split(/[\\/]/).pop()} · extractor ${extractorName === 'claude' ? `claude (${model})` : extractorName})`);
    printScore(score);

    if (runs.length > 1) {
      const changed: string[] = [];
      const all = runs.map(build);
      for (const [i, r] of records.entries()) {
        for (const key of Object.keys(r.fields) as FieldKey[]) {
          const values = all.map((rs) => rs[i]!.fields[key]);
          const first = values[0];
          if (values.some((v) => v?.status !== first?.status || (v?.value !== undefined && first?.value !== undefined ? !sameValue(v.value, first.value) : v?.value !== first?.value))) {
            changed.push(`${r.ref} ${key}`);
          }
        }
      }
      console.log(`  variance    ${changed.length} field(s) changed across ${runs.length} runs${changed.length ? `: ${changed.join(', ')}` : ''}`);
    }
  }

  console.log(
    `\nTOTAL  fields ${total.fields.correct}/${total.fields.total} · grounding ${total.grounding.grounded}/${total.grounding.total} (${pct(total.grounding.grounded, total.grounding.total)})` +
      ` · highlights ${total.highlights.ok}/${total.highlights.total} · flags ${total.flags.found}/${total.flags.expected} (${total.flags.unexpected.length} unexpected)` +
      ` · key dates ${total.dates.correct}/${total.dates.total}`,
  );
  console.log(`COST   LlamaParse ~${credits} credits this run · Claude ${tokens.input} input / ${tokens.output} output tokens`);
  if (failed) process.exitCode = 1;
}

function printScore(s: Score) {
  const list = (xs: string[]) => xs.slice(0, 12).forEach((x) => console.log(`              · ${x}`));
  console.log(`  fields      ${s.fields.correct}/${s.fields.total} correct`);
  list(s.fields.misses);
  const g = s.grounding;
  console.log(`  grounding   ${g.grounded}/${g.total} quotes found (${pct(g.grounded, g.total)}): ${g.exact} exact, ${g.fuzzy} fuzzy · ${g.elsewhere} on a different page than claimed · ${g.ambiguous} ambiguous · value not in cited text: ${g.valueFailed}`);
  console.log(`  highlights  ${s.highlights.ok}/${s.highlights.total} sources overlap the expected box (IoU ≥ 0.5)`);
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
