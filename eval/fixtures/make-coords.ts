// Generates the coordinate test PDF: words at known positions on four kinds of page.
//
//   1  portrait, digital text
//   2  landscape, digital text
//   3  digital text on a page with /Rotate 90 (a portrait sheet that displays as landscape, text upright)
//   4  a picture of text only, no text layer (a simulated scan)
//
// Writes eval/fixtures/coords.pdf and eval/fixtures/coords.expected.json (every known word's box, in PDF
// points, top-left origin, in the page as DISPLAYED: for page 3 that is after /Rotate, which is how
// LlamaParse and PDF.js report it).
// Usage: node eval/fixtures/make-coords.ts   (needs Chromium once: npx playwright install chromium)
// Running it twice gives identical files apart from nothing: dates and ids are fixed.

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { degrees, PDFDocument, StandardFonts } from 'pdf-lib';

const dir = import.meta.dirname;
const A4_W = 595.28;
const A4_H = 841.89;
const SIZE = 14;

interface Spot { text: string; x: number; y: number } // left edge and baseline, from the top-left of the displayed page
interface Box { x: number; y: number; w: number; h: number }
interface ExpectedPage { page: number; kind: string; width: number; height: number; digital: boolean; words: { t: string; box: Box }[] }

// Spread over the page, including near every edge, so a scale or offset error can't hide in the middle.
const portrait: Spot[] = [
  { text: 'Alpha', x: 40, y: 60 }, { text: 'Bravo', x: 300, y: 60 }, { text: 'Charlie', x: 480, y: 140 },
  { text: 'Delta', x: 60, y: 300 }, { text: 'Echo', x: 250, y: 420 }, { text: 'Foxtrot', x: 420, y: 560 },
  { text: 'Golf', x: 40, y: 700 }, { text: 'Hotel', x: 300, y: 800 },
];
const landscape: Spot[] = [
  { text: 'India', x: 40, y: 50 }, { text: 'Juliet', x: 700, y: 50 }, { text: 'Kilo', x: 380, y: 250 },
  { text: 'Lima', x: 60, y: 400 }, { text: 'Mike', x: 560, y: 450 }, { text: 'November', x: 200, y: 570 },
  { text: 'Oscar', x: 700, y: 570 }, { text: 'Papa', x: 420, y: 120 },
];
const rotated: Spot[] = [
  { text: 'Quebec', x: 40, y: 50 }, { text: 'Romeo', x: 700, y: 50 }, { text: 'Sierra', x: 380, y: 250 },
  { text: 'Tango', x: 60, y: 400 }, { text: 'Uniform', x: 560, y: 450 }, { text: 'Victor', x: 200, y: 570 },
  { text: 'Whiskey', x: 690, y: 570 }, { text: 'Xray', x: 420, y: 120 },
];
const scanned: Spot[] = [
  { text: 'Yankee', x: 40, y: 60 }, { text: 'Zulu', x: 300, y: 60 }, { text: 'Amber', x: 480, y: 140 },
  { text: 'Basil', x: 60, y: 300 }, { text: 'Coral', x: 250, y: 420 }, { text: 'Denim', x: 420, y: 560 },
  { text: 'Ember', x: 40, y: 700 }, { text: 'Flint', x: 300, y: 800 },
];

/** The box a viewer should draw round a word drawn at (x, baseline): the em box, 0.8 above the baseline. */
const wordBox = (s: Spot, width: number): Box => ({ x: s.x, y: s.y - SIZE * 0.8, w: width, h: SIZE });
const round2 = (n: number) => Math.round(n * 100) / 100;
const rounded = (b: Box): Box => ({ x: round2(b.x), y: round2(b.y), w: round2(b.w), h: round2(b.h) });

async function scanImage(): Promise<{ png: Uint8Array; words: { t: string; box: Box }[] }> {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 600, height: 850 }, deviceScaleFactor: 2 });
    const spans = scanned
      .map((s) => `<span style="position:absolute;left:${s.x}px;top:${s.y - SIZE * 0.8}px;font:${SIZE}px/${SIZE}px Helvetica,Arial,sans-serif;white-space:nowrap">${s.text}</span>`)
      .join('');
    await page.setContent(`<body style="margin:0;background:#fff;color:#000"><div id="p" style="position:relative;width:${A4_W}px;height:${A4_H}px">${spans}</div></body>`);
    const words = await page.evaluate(() =>
      [...document.querySelectorAll('#p span')].map((el) => {
        const r = el.getBoundingClientRect();
        return { t: el.textContent ?? '', box: { x: r.x, y: r.y, w: r.width, h: r.height } };
      }),
    );
    const png = await page.locator('#p').screenshot({ type: 'png' });
    return { png: new Uint8Array(png), words: words.map((w) => ({ t: w.t, box: rounded(w.box) })) };
  } finally {
    await browser.close();
  }
}

async function main() {
  const pdf = await PDFDocument.create();
  pdf.setTitle('coords');
  pdf.setProducer('happyengine coordinate test');
  pdf.setCreator('happyengine');
  pdf.setCreationDate(new Date('2026-10-14T00:00:00Z'));
  pdf.setModificationDate(new Date('2026-10-14T00:00:00Z'));
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const expected: ExpectedPage[] = [];
  const width = (t: string) => font.widthOfTextAtSize(t, SIZE);

  // 1 portrait
  const p1 = pdf.addPage([A4_W, A4_H]);
  for (const s of portrait) p1.drawText(s.text, { x: s.x, y: A4_H - s.y, size: SIZE, font });
  expected.push({ page: 1, kind: 'portrait', width: A4_W, height: A4_H, digital: true, words: portrait.map((s) => ({ t: s.text, box: rounded(wordBox(s, width(s.text))) })) });

  // 2 landscape
  const p2 = pdf.addPage([A4_H, A4_W]);
  for (const s of landscape) p2.drawText(s.text, { x: s.x, y: A4_W - s.y, size: SIZE, font });
  expected.push({ page: 2, kind: 'landscape', width: A4_H, height: A4_W, digital: true, words: landscape.map((s) => ({ t: s.text, box: rounded(wordBox(s, width(s.text))) })) });

  // 3 /Rotate 90: a portrait sheet (A4_W x A4_H) shown clockwise-rotated, so displayed as A4_H wide x A4_W tall.
  // Displayed point (X, Y from the top) is user-space point (x = Y, y = X); text is turned 90 degrees
  // anticlockwise in user space so that it reads upright in the displayed page.
  const p3 = pdf.addPage([A4_W, A4_H]);
  p3.setRotation(degrees(90));
  for (const s of rotated) p3.drawText(s.text, { x: s.y, y: s.x, size: SIZE, font, rotate: degrees(90) });
  expected.push({ page: 3, kind: 'rotate90', width: A4_H, height: A4_W, digital: true, words: rotated.map((s) => ({ t: s.text, box: rounded(wordBox(s, width(s.text))) })) });

  // 4 picture of text
  const scan = await scanImage();
  const p4 = pdf.addPage([A4_W, A4_H]);
  p4.drawImage(await pdf.embedPng(scan.png), { x: 0, y: 0, width: A4_W, height: A4_H });
  expected.push({ page: 4, kind: 'image-only', width: A4_W, height: A4_H, digital: false, words: scan.words });

  writeFileSync(join(dir, 'coords.pdf'), await pdf.save());
  writeFileSync(join(dir, 'coords.expected.json'), JSON.stringify({ tolerance: 0.01, pages: expected }, null, 1) + '\n');
  console.log(`coords.pdf: ${expected.length} pages, ${expected.reduce((n, p) => n + p.words.length, 0)} known words`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
