// Parses one PDF and records the result for the fixture parser and the eval.
// Usage: node scripts/parse-file.ts <pdf> --parser pdfjs|llamaparse [--tier agentic]
// Writes <pdf folder>/parsed/<parser>-<tier>/<pdf name>.json and prints pages, words and credits.
// LlamaParse sends the file offshore, so it only runs for a sample whose sample.json says "synthetic": true.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { createLlamaParseParser, type ParsedDocument } from '../packages/documents/src/index.ts';
import { createPdfjsParser } from '../packages/documents/src/parsers/pdfjs.ts';
import { loadSecrets } from './env.ts';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const file = process.argv[2];
  const parser = arg('parser');
  if (!file || file.startsWith('--') || (parser !== 'pdfjs' && parser !== 'llamaparse')) {
    throw new Error('Usage: node scripts/parse-file.ts <pdf> --parser pdfjs|llamaparse [--tier agentic]');
  }
  const bytes = readFileSync(file);
  const filename = basename(file);
  let doc: ParsedDocument;
  let tier: string;

  if (parser === 'pdfjs') {
    tier = 'local';
    doc = await createPdfjsParser().parse(bytes, { filename });
  } else {
    loadSecrets();
    const samplePath = join(dirname(file), 'sample.json');
    const synthetic = existsSync(samplePath) && JSON.parse(readFileSync(samplePath, 'utf8')).synthetic === true;
    tier = arg('tier') ?? 'cost_effective';
    const llama = createLlamaParseParser({
      apiKey: process.env.LLAMA_CLOUD_API_KEY ?? '',
      baseUrl: process.env.LLAMA_CLOUD_BASE_URL,
      offshoreAllowed: synthetic,
    });
    console.log(`Sending ${filename} to LlamaParse (${tier})…`);
    doc = await llama.parse(bytes, { filename, tier });
  }

  const outDir = join(dirname(file), 'parsed', `${parser}-${tier}`);
  mkdirSync(outDir, { recursive: true });
  const out = join(outDir, filename.replace(/\.pdf$/i, '') + '.json');
  writeFileSync(out, JSON.stringify(doc) + '\n');
  const words = doc.pages.reduce((n, p) => n + p.words.length, 0);
  console.log(`${filename}: ${doc.pageCount} pages, ${words} words${doc.creditsEstimate === undefined ? '' : `, about ${doc.creditsEstimate} credits`}`);
  console.log(`Saved ${out}`);
}

main().catch((err) => {
  console.error(`${err.name ?? 'Error'}: ${err.message}`);
  process.exit(1);
});
