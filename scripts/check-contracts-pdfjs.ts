// Checks the local PDF.js parser and the quote check against the Contracts test set.
//   1. Every data-field box in boxes.json has parsed words inside it (per file).
//   2. Each data-field element's own text, taken from the demo fixture, is grounded on its page, and the
//      returned boxes overlap the expected box with IoU ≥ 0.5.
// Usage: node scripts/check-contracts-pdfjs.ts   (needs ../happyai and Chromium, like the render script)

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { ground, type Box, type ParsedDocument } from '../packages/documents/src/index.ts';
import { createPdfjsParser } from '../packages/documents/src/parsers/pdfjs.ts';
import { root } from './local.ts';

const dir = join(root, 'eval', 'contracts', 'demo-marula');
const boxes: Record<string, Record<string, (Box & { page: number })[]>> = JSON.parse(readFileSync(join(dir, 'boxes.json'), 'utf8'));
const MIN_SCORE = 0.9;

function iou(a: Box, b: Box): number {
  const x = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const y = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const inter = x * y;
  return inter / (a.w * a.h + b.w * b.h - inter);
}
const union = (list: Box[]): Box => {
  const x = Math.min(...list.map((b) => b.x));
  const y = Math.min(...list.map((b) => b.y));
  return { x, y, w: Math.max(...list.map((b) => b.x + b.w)) - x, h: Math.max(...list.map((b) => b.y + b.h)) - y };
};

/** The visible text of every data-field element in the demo fixture, laid out with the demo's CSS. */
async function fieldTexts(): Promise<Record<string, string>> {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto('file:///' + join(root, '..', 'happyai', 'demo-contracts.html').replace(/\\/g, '/'));
    return await page.evaluate(() => {
      const fixture = (window as unknown as { FIXTURE?: never }).FIXTURE ?? (0, eval)('FIXTURE');
      const out: Record<string, string> = {};
      const host = document.createElement('div');
      host.style.cssText = 'position:absolute;left:0;top:0;width:640px';
      document.body.append(host);
      for (const a of (fixture as { agreements: { pages: { cls?: string; html: string }[] }[] }).agreements) {
        for (const p of a.pages) {
          host.innerHTML = `<article class="paper ${p.cls ?? ''}">${p.html}</article>`;
          for (const b of host.querySelectorAll('.blank')) b.textContent = '__________';
          for (const el of host.querySelectorAll<HTMLElement>('[data-field]')) out[el.dataset.field!] = el.innerText;
        }
      }
      host.remove();
      return out;
    });
  } finally {
    await browser.close();
  }
}

async function main() {
  const texts = await fieldTexts();
  const parser = createPdfjsParser();
  let grounded = 0;
  let overlapping = 0;
  let total = 0;
  const misses: string[] = [];

  console.log('Words inside each expected box');
  for (const [file, fields] of Object.entries(boxes)) {
    const doc: ParsedDocument = await parser.parse(readFileSync(join(dir, file)), { filename: file });
    let withWords = 0;
    let count = 0;
    for (const [field, list] of Object.entries(fields)) {
      for (const box of list) {
        count++;
        const page = doc.pages[box.page - 1]!;
        const inside = page.words.filter((w) => {
          const cx = w.box.x + w.box.w / 2;
          const cy = w.box.y + w.box.h / 2;
          return cx >= box.x && cx <= box.x + box.w && cy >= box.y && cy <= box.y + box.h;
        });
        if (inside.length) withWords++;
        else misses.push(`${file} ${field}: no words inside the box`);

        total++;
        const text = texts[field];
        if (!text) {
          misses.push(`${field}: not found in the demo fixture`);
          continue;
        }
        const r = ground(text, page, MIN_SCORE);
        if (r.status !== 'grounded') {
          misses.push(`${file} ${field}: not grounded (score ${r.score})`);
          continue;
        }
        grounded++;
        const score = iou(union(r.boxes), box);
        if (score >= 0.5) overlapping++;
        else misses.push(`${file} ${field}: IoU ${score.toFixed(2)}`);
      }
    }
    console.log(`  ${file.padEnd(20)} ${withWords}/${count} boxes contain words`);
  }
  console.log(`\nGrounding (minScore ${MIN_SCORE}): grounded ${grounded}/${total}, IoU ≥ 0.5 ${overlapping}/${total}`);
  if (misses.length) {
    console.log('\nMisses:');
    for (const m of misses) console.log('  ' + m);
    process.exitCode = 1;
  }
}

await main();
