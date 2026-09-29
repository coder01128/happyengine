// Renders the five sample agreements in happyai/demo-contracts.html as real PDFs for the
// Contracts eval, plus scan-style copies with no text layer.
//
//   demo-marula/  digital PDFs (text layer) + boxes.json (highlight box per data-field)
//   scan-marula/  the same pages as 150 dpi JPEG images only + boxes.json recomputed from the images
//
// expected.json and sample.json in demo-marula/ are written by hand; this script copies them to
// scan-marula/. Usage: node eval/contracts/render/render-demo.ts
// Needs ../happyai next to this repo, and Chromium (npx playwright install chromium).

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Page } from 'playwright';

const root = join(import.meta.dirname, '..', '..', '..');
const demoPath = join(root, '..', 'happyai', 'demo-contracts.html');
const digitalDir = join(root, 'eval', 'contracts', 'demo-marula');
const scanDir = join(root, 'eval', 'contracts', 'scan-marula');

/** A4 in CSS px at 96 dpi. The demo draws its paper 600px wide and lets it grow taller than A4; laid out
 *  at 640px, every page fits A4 proportions, then is scaled up to A4. */
const A4_W = (210 / 25.4) * 96;
const A4_H = (297 / 25.4) * 96;
const PAPER_W = 640;
const SCALE = A4_W / PAPER_W;
const PX_TO_PT = 0.75;
const SCAN_DPI = 150;
/** Metadata dates in every PDF are replaced with this, so re-runs only differ if the pages do. */
const FIXED_PDF_DATE = '20261014000000';

interface FixturePage {
  cls?: string;
  html: string;
}
interface FixtureAgreement {
  id: string;
  ref: string;
  counterparty: string;
  docTitle: string;
  initials?: string[];
  pages: FixturePage[];
}
interface Fixture {
  agreements: FixtureAgreement[];
}

/** One PDF per file. C1's final page is Addendum 1, which arrives as its own document in real life. */
interface OutFile {
  name: string;
  agreement: FixtureAgreement;
  docTitle: string;
  pages: FixturePage[];
}
const FILE_NAMES: Record<string, string> = {
  c2: 'c2-subscription.pdf',
  c3: 'c3-cleaning.pdf',
  c4: 'c4-copier.pdf',
  c5: 'c5-courier.pdf',
};

interface Box {
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
}
type Boxes = Record<string, Record<string, Box[]>>;

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Same markup as the demo's paperHTML(), without the diagonal SAMPLE watermark (it sits over clause text). */
function paperHTML(f: OutFile, page: FixturePage, i: number): string {
  const a = f.agreement;
  const head =
    i === 0
      ? '<div class="p-head"><div><p class="p-issuer">' + esc(f.docTitle) + '</p><p class="p-sub">Sample agreement · not a real contract</p></div></div>'
      : '<p class="p-run"><span>' + esc(f.docTitle) + '</span><span>' + esc(a.ref) + ' · sample</span></p>';
  const init = a.initials ? '<span class="p-init">Initials' + a.initials.map((x) => '<i>' + esc(x) + '</i>').join('') + '</span>' : '';
  return (
    '<div class="pdfpage"><article class="paper' + (page.cls ? ' ' + page.cls : '') + '"><p class="p-strip">Sample document · illustrative only</p>' +
    head + page.html +
    '<div class="p-foot"><span>' + esc(a.ref) + ' · ' + esc(a.counterparty) + ' (sample)</span>' + init +
    '<span>Page ' + (i + 1) + ' of ' + f.pages.length + '</span></div></article></div>'
  );
}

const PRINT_CSS = `
@page { size: A4; margin: 0 }
html, body { margin: 0; padding: 0; background: #fff }
.pdfpage { position: relative; box-sizing: border-box; width: ${A4_W}px; max-width: none; height: ${A4_H}px; margin: 0; padding: 0; border: 0; overflow: hidden; break-after: page; background: #fff }
.pdfpage:last-child { break-after: auto }
.paper { width: ${PAPER_W}px; max-width: none; height: ${A4_H / SCALE}px; aspect-ratio: auto; margin: 0; border-radius: 0; box-shadow: none;
  transform: scale(${SCALE}); transform-origin: 0 0; overflow: hidden }
.paper + .paper { margin-top: 0 }
.paper::after { display: none }
/* Blank lines are literal underscores, as on a real signed copy, so the text layer holds them. */
.blank { display: inline; min-width: 0; height: auto; border-bottom: 0; vertical-align: baseline }
`;

function documentHTML(css: string, body: string, extraCss = ''): string {
  return (
    '<!DOCTYPE html><html lang="en-ZA" data-theme="light" data-eff="light"><head><meta charset="utf-8">' +
    '<style>' + css + '</style><style>' + PRINT_CSS + extraCss + '</style></head><body>' + body + '</body></html>'
  );
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * Box of every [data-field] element per page, in PDF points from the page's top-left corner. The box
 * covers the element's text, not its whole block: a short clause in a full-width block gets a box
 * around its words, which is where a highlight belongs.
 */
async function measureBoxes(page: Page): Promise<{ boxes: Record<string, Box[]>; overflow: number[]; sheetW: number }> {
  const raw = await page.evaluate(() => {
    const sheets = [...document.querySelectorAll<HTMLElement>('.pdfpage')];
    const out: { field: string; page: number; x: number; y: number; w: number; h: number }[] = [];
    const overflow: number[] = [];
    const textRects = (el: HTMLElement) => {
      const rects: DOMRect[] = [];
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        if (!n.textContent?.trim()) continue;
        const range = document.createRange();
        range.selectNodeContents(n);
        for (const r of range.getClientRects()) if (r.width > 0 && r.height > 0) rects.push(r);
      }
      return rects;
    };
    sheets.forEach((sheet, i) => {
      const s = sheet.getBoundingClientRect();
      const paper = sheet.querySelector<HTMLElement>('.paper')!;
      if (paper.scrollHeight > paper.clientHeight + 1) overflow.push(i + 1);
      for (const el of sheet.querySelectorAll<HTMLElement>('[data-field]')) {
        const rects = textRects(el);
        const left = Math.min(...rects.map((r) => r.left));
        const top = Math.min(...rects.map((r) => r.top));
        const right = Math.max(...rects.map((r) => r.right));
        const bottom = Math.max(...rects.map((r) => r.bottom));
        out.push({ field: el.dataset.field!, page: i + 1, x: left - s.left, y: top - s.top, w: right - left, h: bottom - top });
      }
    });
    return { out, overflow, sheetW: sheets[0]!.getBoundingClientRect().width };
  });
  const boxes: Record<string, Box[]> = {};
  for (const b of raw.out) {
    (boxes[b.field] ??= []).push({
      page: b.page,
      x: round1(b.x * PX_TO_PT),
      y: round1(b.y * PX_TO_PT),
      w: round1(b.w * PX_TO_PT),
      h: round1(b.h * PX_TO_PT),
    });
  }
  return { boxes, overflow: raw.overflow, sheetW: raw.sheetW };
}

/** Chromium stamps the print time into the PDF. Overwrite it in place (same byte length, so offsets stay valid). */
function fixPdfDates(pdf: Buffer): Buffer {
  const text = pdf.toString('latin1').replace(/\/(CreationDate|ModDate)\s*\(D:\d{14}/g, (m) => m.slice(0, -14) + FIXED_PDF_DATE);
  return Buffer.from(text, 'latin1');
}

const pageCount = (pdf: Buffer) => (pdf.toString('latin1').match(/\/Type\s*\/Page(?![s\w])/g) ?? []).length;

async function main() {
  if (!existsSync(demoPath)) throw new Error(`Demo not found: ${demoPath}`);
  for (const f of ['expected.json', 'sample.json']) {
    if (!existsSync(join(digitalDir, f))) throw new Error(`Missing ${join(digitalDir, f)} (written by hand)`);
  }
  mkdirSync(scanDir, { recursive: true });

  const browser = await chromium.launch();
  try {
    // Device scale 150/96 so element screenshots come out at 150 dpi. PDF output ignores it.
    const context = await browser.newContext({
      viewport: { width: Math.ceil(A4_W), height: Math.ceil(A4_H) * 2 },
      deviceScaleFactor: SCAN_DPI / 96,
      colorScheme: 'light',
    });
    const page = await context.newPage();

    await page.goto('file:///' + demoPath.replace(/\\/g, '/'));
    const fixture = (await page.evaluate('FIXTURE')) as Fixture;
    const demoCss = await page.evaluate(() => document.querySelector('style')!.textContent ?? '');

    const files: OutFile[] = [];
    for (const a of fixture.agreements) {
      if (a.id === 'c1') {
        files.push({ name: 'c1-lease.pdf', agreement: a, docTitle: a.docTitle, pages: a.pages.slice(0, -1) });
        files.push({ name: 'c1-addendum.pdf', agreement: a, docTitle: 'Addendum 1 · agreement of lease', pages: a.pages.slice(-1) });
      } else {
        const name = FILE_NAMES[a.id];
        if (!name) throw new Error(`No file name for agreement ${a.id}`);
        files.push({ name, agreement: a, docTitle: a.docTitle, pages: a.pages });
      }
    }

    const digitalBoxes: Boxes = {};
    const scanBoxes: Boxes = {};
    const counts: { file: string; digital: number; scan: number }[] = [];
    const problems: string[] = [];

    for (const f of files) {
      // ---- digital PDF
      await page.emulateMedia({ media: 'print', colorScheme: 'light' });
      await page.setContent(documentHTML(demoCss, f.pages.map((p, i) => paperHTML(f, p, i)).join('')), { waitUntil: 'load' });
      await page.evaluate(() => {
        for (const b of document.querySelectorAll('.blank')) b.textContent = '__________';
      });
      await page.evaluate(() => document.fonts.ready);

      const measured = await measureBoxes(page);
      if (Math.abs(measured.sheetW - A4_W) > 0.5) throw new Error(`${f.name}: page measures ${measured.sheetW}px, expected ${A4_W}px`);
      for (const p of measured.overflow) problems.push(`${f.name} page ${p}: text runs past the bottom of the page`);
      digitalBoxes[f.name] = measured.boxes;

      const pdf = fixPdfDates(await page.pdf({ format: 'A4', printBackground: true, margin: { top: '0', right: '0', bottom: '0', left: '0' } }));
      writeFileSync(join(digitalDir, f.name), pdf);
      const digitalPages = pageCount(pdf);
      if (digitalPages !== f.pages.length) problems.push(`${f.name}: ${digitalPages} PDF pages for ${f.pages.length} fixture pages`);

      // ---- scan-style copy: each page captured at 150 dpi, then greyed, slightly blurred and given
      // faint noise in a canvas pass, and saved as JPEG quality 70. (A CSS filter on the live page
      // left the bottom of each page unpainted in Chromium, so the effects run on the capture instead.)
      const captures: string[] = [];
      for (const sheet of await page.locator('.pdfpage').all()) {
        const png = await sheet.screenshot({ type: 'png', scale: 'device', animations: 'disabled' });
        captures.push(png.toString('base64'));
      }
      await page.setContent('<!DOCTYPE html><html><body></body></html>');
      const images = await page.evaluate(
        async ({ captures, blurPx }) => {
          const out: string[] = [];
          for (const [n, b64] of captures.entries()) {
            const img = new Image();
            img.src = 'data:image/png;base64,' + b64;
            await img.decode();
            const c = document.createElement('canvas');
            c.width = img.naturalWidth;
            c.height = img.naturalHeight;
            // CPU-backed canvas: GPU filtering is not bit-for-bit repeatable between runs.
            const ctx = c.getContext('2d', { willReadFrequently: true })!;
            ctx.filter = `grayscale(1) brightness(.95) contrast(.93) blur(${blurPx}px)`;
            ctx.drawImage(img, 0, 0);
            ctx.filter = 'none';
            // Faint noise from a seeded generator, so every run gives the same pixels.
            const data = ctx.getImageData(0, 0, c.width, c.height);
            let seed = 0x5eed + n;
            for (let i = 0; i < data.data.length; i += 4) {
              seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
              const d = ((seed >>> 24) / 255 - 0.5) * 16;
              for (let k = 0; k < 3; k++) data.data[i + k] = Math.max(0, Math.min(255, data.data[i + k]! + d));
            }
            ctx.putImageData(data, 0, 0);
            out.push(c.toDataURL('image/jpeg', 0.7).slice('data:image/jpeg;base64,'.length));
          }
          return out;
        },
        { captures, blurPx: 0.4 * (SCAN_DPI / 96) },
      );

      await page.setContent(
        documentHTML('', images.map((b64) => `<div class="pdfpage"><img alt="" src="data:image/jpeg;base64,${b64}"></div>`).join(''),
          // No background under the image: Chromium sometimes paints a white background twice, which
          // changes the PDF bytes between runs without changing how it looks.
          'html,body,.pdfpage{background:none}.pdfpage img{display:block;width:100%;height:100%}'),
        { waitUntil: 'load' },
      );
      // Boxes for the scan copy: the digital boxes mapped through each image's position and size.
      const imgRects = await page.evaluate(() =>
        [...document.querySelectorAll<HTMLElement>('.pdfpage')].map((s) => {
          const sr = s.getBoundingClientRect();
          const ir = s.querySelector('img')!.getBoundingClientRect();
          return { x: ir.left - sr.left, y: ir.top - sr.top, w: ir.width, h: ir.height };
        }),
      );
      const fileScanBoxes: Record<string, Box[]> = {};
      for (const [field, list] of Object.entries(measured.boxes)) {
        fileScanBoxes[field] = list.map((b) => {
          const r = imgRects[b.page - 1]!;
          const kx = r.w / A4_W;
          const ky = r.h / A4_H;
          return {
            page: b.page,
            x: round1(r.x * PX_TO_PT + b.x * kx),
            y: round1(r.y * PX_TO_PT + b.y * ky),
            w: round1(b.w * kx),
            h: round1(b.h * ky),
          };
        });
      }
      scanBoxes[f.name] = fileScanBoxes;

      const scanPdf = fixPdfDates(await page.pdf({ format: 'A4', printBackground: true, margin: { top: '0', right: '0', bottom: '0', left: '0' } }));
      writeFileSync(join(scanDir, f.name), scanPdf);
      const scanPages = pageCount(scanPdf);
      if (scanPages !== f.pages.length) problems.push(`${f.name} (scan): ${scanPages} PDF pages for ${f.pages.length} fixture pages`);
      counts.push({ file: f.name, digital: digitalPages, scan: scanPages });
    }

    writeFileSync(join(digitalDir, 'boxes.json'), JSON.stringify(digitalBoxes, null, 2) + '\n');
    writeFileSync(join(scanDir, 'boxes.json'), JSON.stringify(scanBoxes, null, 2) + '\n');
    for (const f of ['expected.json', 'sample.json']) copyFileSync(join(digitalDir, f), join(scanDir, f));

    // Every data-field that expected.json points at must have a box.
    const expected = JSON.parse(readFileSync(join(digitalDir, 'expected.json'), 'utf8'));
    const allFields = new Set(Object.values(digitalBoxes).flatMap((m) => Object.keys(m)));
    const wanted = new Set<string>();
    JSON.stringify(expected, (k, v) => {
      if ((k === 'source' || k === 'also') && Array.isArray(v)) for (const id of v) wanted.add(id);
      return v;
    });
    const missing = [...wanted].filter((id) => !allFields.has(id));
    if (missing.length) problems.push(`expected.json points at data-fields with no box: ${missing.join(', ')}`);
    if (JSON.stringify(digitalBoxes) !== JSON.stringify(scanBoxes)) problems.push('scan boxes differ from digital boxes');

    console.log('file                   digital pages   scan pages');
    for (const c of counts) console.log(`${c.file.padEnd(22)} ${String(c.digital).padStart(13)} ${String(c.scan).padStart(12)}`);
    const total = (k: 'digital' | 'scan') => counts.reduce((n, c) => n + c[k], 0);
    console.log(`${'TOTAL'.padEnd(22)} ${String(total('digital')).padStart(13)} ${String(total('scan')).padStart(12)}`);
    console.log(`boxes: ${allFields.size} data-fields · expected.json uses ${wanted.size}, all present: ${missing.length === 0 ? 'yes' : 'no'}`);
    if (problems.length) {
      console.log('\nProblems:');
      for (const p of problems) console.log('  ' + p);
      process.exitCode = 1;
    }
  } finally {
    await browser.close();
  }
}

await main();
