// The coordinate test: parses eval/fixtures/coords.pdf and compares every known word's box with where it
// really is (1% of page size allowed). Prints a plain pass count per page, and saves the parse for
// dev/highlight-test.html (eval/fixtures/parsed/<parser>-<tier>/coords.json).
//
// Usage: node scripts/check-coords.ts --parser pdfjs
//        node scripts/check-coords.ts --parser llamaparse [--tier agentic]   (sends the made-up test PDF to LlamaParse)
// Exit code 1 when any word fails.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createLlamaParseParser, type ParsedDocument } from '../packages/documents/src/index.ts';
import { createPdfjsParser } from '../packages/documents/src/parsers/pdfjs.ts';
import { checkCoords, type ExpectedCoords } from '../eval/fixtures/coords-check.ts';
import { loadSecrets, pinnedVersions } from './env.ts';
import { root } from './local.ts';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const parser = arg('parser');
  if (parser !== 'pdfjs' && parser !== 'llamaparse') throw new Error('Usage: node scripts/check-coords.ts --parser pdfjs|llamaparse [--tier agentic]');
  const dir = join(root, 'eval', 'fixtures');
  const bytes = readFileSync(join(dir, 'coords.pdf'));
  const expected = JSON.parse(readFileSync(join(dir, 'coords.expected.json'), 'utf8')) as ExpectedCoords;
  let doc: ParsedDocument;
  let tier: string;

  if (parser === 'pdfjs') {
    tier = 'local';
    doc = await createPdfjsParser({ onEmptyPage: 'keep' }).parse(bytes, { filename: 'coords.pdf' });
  } else {
    loadSecrets();
    tier = arg('tier') ?? 'agentic'; // the picture page needs OCR, so the default is the scan tier
    const llama = createLlamaParseParser({ apiKey: process.env.LLAMA_CLOUD_API_KEY ?? '', baseUrl: process.env.LLAMA_CLOUD_BASE_URL, versions: pinnedVersions(), offshoreAllowed: true });
    console.log(`Sending coords.pdf (made-up test pages) to LlamaParse (${tier})…`);
    doc = await llama.parse(bytes, { filename: 'coords.pdf', tier });
  }

  const outDir = join(dir, 'parsed', `${parser}-${tier}`);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'coords.json'), JSON.stringify(doc) + '\n');

  // PDF.js reads only a text layer, so the picture page is not part of its test.
  const skipped = parser === 'pdfjs' ? expected.pages.filter((p) => !p.digital) : [];
  const checks = checkCoords(doc, { ...expected, pages: expected.pages.filter((p) => !skipped.includes(p)) });
  let pass = 0;
  let total = 0;
  for (const c of checks) {
    pass += c.pass;
    total += c.words;
    const note = c.unreadable ? ` — no positions: ${c.unreadable}` : ` (worst ${(c.worst * 100).toFixed(2)}% of the page)`;
    console.log(`page ${c.page} ${c.kind.padEnd(10)} ${c.pass}/${c.words} words within ${(expected.tolerance * 100).toFixed(0)}%${note}`);
    for (const m of c.misses.slice(0, 5)) console.log(`   · ${m}`);
  }
  for (const p of skipped) console.log(`page ${p.page} ${p.kind.padEnd(10)} skipped: picture only, PDF.js cannot read it (needs an OCR parser)`);
  console.log(`TOTAL ${pass}/${total} words within ${(expected.tolerance * 100).toFixed(0)}% of page size · parser ${parser}${parser === 'llamaparse' ? ` (${tier})` : ''}`);
  console.log(`Saved ${join(outDir, 'coords.json')}`);
  if (pass !== total) process.exitCode = 1;
}

main().catch((err) => {
  console.error(`${err.name ?? 'Error'}: ${err.message}`);
  process.exit(1);
});
