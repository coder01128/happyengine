// Two more made-up samples, so the eval isn't only the one layout the demo contracts share.
//
//   layout-lakeside/    a two-column sub-lease in small type with a red "RECEIVED" stamp over a clause. Built directly
//                       with pdf-lib, so every clause's box is known exactly (boxes.json), no browser needed.
//   watermark-marula/   the five demo contracts with three dark grey diagonal "SAMPLE" marks laid over every page, the way a
//                       watermarked PDF is made. Same answers and boxes as demo-marula.
//
// Usage: node eval/contracts/render/make-variants.ts   (needs eval/contracts/demo-marula/ first)
// Running it twice gives identical files: dates are fixed.

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { degrees, PDFDocument, rgb, StandardFonts, type PDFFont, type PDFPage } from 'pdf-lib';
import { addDays, addMonths } from '../../../packages/core/src/index.ts';

const root = join(import.meta.dirname, '..');
const A4_W = 595.28;
const A4_H = 841.89;
const FIXED = new Date('2026-10-14T00:00:00Z');

// ---------------------------------------------------------------------------
// layout-lakeside
// ---------------------------------------------------------------------------
interface Block { kind: 'title' | 'heading' | 'clause'; num?: string; text: string; id?: string }
const FILE = 'lakeside-sublease.pdf';
const CLAUSES: Block[] = [
  { kind: 'heading', text: '1. PARTIES' },
  { kind: 'clause', num: '1.1', id: 'l1-1-1', text: 'This sub-lease is entered into between Kloof Storage (Pty) Ltd (sample) (“the Sublessor”) and Marula Office Supplies (Pty) Ltd (“the Sublessee”).' },
  { kind: 'heading', text: '2. PREMISES' },
  { kind: 'clause', num: '2.1', id: 'l1-2-1', text: 'The Sublessor sub-lets to the Sublessee Unit 12, Kloof Business Yard, Pinetown (“the Premises”), for use as a warehouse and storage area only.' },
  { kind: 'clause', num: '2.2', text: 'The Sublessee shall not use the Premises for any unlawful purpose, and shall not store hazardous or flammable goods there without the written consent of the Sublessor.' },
  { kind: 'clause', num: '2.3', text: 'The Sublessee shall keep the Premises clean and in good order, and shall report any damage to the roof, doors or electrical installation to the Sublessor without delay.' },
  { kind: 'heading', text: '3. DURATION' },
  { kind: 'clause', num: '3.1', id: 'l1-3-1', text: 'This sub-lease commences on 1 August 2026 (“the Commencement Date”).' },
  { kind: 'clause', num: '3.2', id: 'l1-3-2', text: 'The initial term is 24 (twenty-four) months from the Commencement Date.' },
  { kind: 'clause', num: '3.3', text: 'The Sublessee shall take occupation on the Commencement Date and shall vacate on the last day of the sub-lease, leaving the Premises empty and in the condition in which it received them, fair wear and tear excepted.' },
  { kind: 'heading', text: '4. RENT AND DEPOSIT' },
  { kind: 'clause', num: '4.1', id: 'l1-4-1', text: 'The monthly rent is R18 500.00 excluding VAT, payable in advance on or before the first Business Day of each month, without deduction or set-off.' },
  { kind: 'clause', num: '4.2', id: 'l1-4-2', text: 'The rent escalates by 7% (seven percent) on each anniversary of the Commencement Date.' },
  { kind: 'clause', num: '4.3', id: 'l1-4-3', text: 'The Sublessee shall pay a deposit of R37 000.00 on signature of this sub-lease.' },
  { kind: 'clause', num: '4.4', text: 'Any amount not paid on its due date bears interest at the prime rate plus 2% (two percent), calculated daily from the due date until the date of payment.' },
  { kind: 'heading', text: '5. RENEWAL AND CANCELLATION' },
  { kind: 'clause', num: '5.1', id: 'l1-5-1', text: 'This sub-lease renews automatically for successive periods of 12 (twelve) months unless cancelled in terms of clause 5.2.' },
  { kind: 'clause', num: '5.2', id: 'l1-5-2', text: 'Either party may cancel this sub-lease by giving the other not less than 90 days written notice before the renewal date.' },
  { kind: 'heading', text: '6. GENERAL' },
  { kind: 'clause', num: '6.1', text: 'This sub-lease is the whole agreement between the parties. No variation of it is of any force unless it is in writing and signed by both parties.' },
  { kind: 'clause', num: '6.2', text: 'No relaxation or indulgence granted by either party is a waiver of any right, and no such relaxation may be relied on as a precedent.' },
  { kind: 'clause', num: '6.3', text: 'The parties choose as their addresses for all notices the addresses given at the head of this sub-lease. A notice sent by email is treated as received on the next Business Day.' },
  { kind: 'clause', num: '6.4', text: 'If any clause of this sub-lease is found to be invalid, the rest of it remains in force. This sub-lease is governed by the law of the Republic of South Africa.' },
  { kind: 'clause', num: '6.5', text: 'The Sublessee shall insure its own goods kept on the Premises against loss by fire, theft and water damage, and shall give the Sublessor a copy of the policy schedule on request.' },
  { kind: 'clause', num: '6.6', text: 'The Sublessor may enter the Premises at any reasonable time on reasonable notice to inspect them or to carry out repairs, and in an emergency without notice.' },
  { kind: 'clause', num: '6.7', text: 'Each party bears its own costs of preparing this sub-lease. The Sublessee bears the costs of any registration of it that the Sublessee requires.' },
  { kind: 'clause', num: '6.8', text: 'The Sublessee shall not cede its rights or sub-let any part of the Premises without the prior written consent of the Sublessor.' },
];

interface Placed { page: number; col: 0 | 1; x: number; y: number; w: number; h: number; line: string; bold?: boolean; size: number; num?: string }

async function layoutSample() {
  const dir = join(root, 'layout-lakeside');
  mkdirSync(dir, { recursive: true });
  const pdf = await PDFDocument.create();
  pdf.setTitle('Sub-lease of warehouse unit (sample)');
  pdf.setProducer('happyengine eval');
  pdf.setCreator('happyengine');
  pdf.setCreationDate(FIXED);
  pdf.setModificationDate(FIXED);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

  const MARGIN = 40;
  const GAP = 24;
  const COL_W = (A4_W - 2 * MARGIN - GAP) / 2;
  const SIZE = 9;
  const LEAD = 12;
  const TOP = 118; // first page: below the title block
  const TOP_NEXT = 64;
  // Short columns on purpose, so the text runs down column 1, across to column 2, and on to page 2.
  const BOTTOM = 400;
  const NUM_W = 24;

  const wrap = (text: string, f: PDFFont, size: number, width: number): string[] => {
    const lines: string[] = [];
    let cur = '';
    for (const w of text.split(' ')) {
      const next = cur ? `${cur} ${w}` : w;
      if (f.widthOfTextAtSize(next, size) <= width || !cur) cur = next;
      else {
        lines.push(cur);
        cur = w;
      }
    }
    if (cur) lines.push(cur);
    return lines;
  };

  // Flow the blocks down column 1, then column 2, then the next page.
  const placed: Placed[] = [];
  const boxesFor: Record<string, { page: number; x0: number; y0: number; x1: number; y1: number }[]> = {};
  let page = 1;
  let col: 0 | 1 = 0;
  let y = TOP;
  const advance = (needed: number) => {
    if (y + needed <= BOTTOM) return;
    if (col === 0) col = 1;
    else {
      col = 0;
      page++;
    }
    y = page === 1 ? TOP : TOP_NEXT;
  };
  for (const b of CLAUSES) {
    if (b.kind === 'heading') {
      advance(LEAD * 3);
      y += 6;
      placed.push({ page, col, x: MARGIN + col * (COL_W + GAP), y, w: bold.widthOfTextAtSize(b.text, SIZE), h: SIZE + 1, line: b.text, bold: true, size: SIZE });
      y += LEAD + 2;
      continue;
    }
    const lines = wrap(b.text, font, SIZE, COL_W - NUM_W);
    advance(LEAD * Math.min(lines.length, 2));
    lines.forEach((line, i) => {
      advance(LEAD);
      const x = MARGIN + col * (COL_W + GAP);
      placed.push({ page, col, x: x + NUM_W, y, w: font.widthOfTextAtSize(line, SIZE), h: SIZE + 1, line, size: SIZE, ...(i === 0 ? { num: b.num } : {}) });
      if (b.id) {
        const hit = { page, x0: (i === 0 ? x : x + NUM_W), y0: y, x1: x + NUM_W + font.widthOfTextAtSize(line, SIZE), y1: y + SIZE + 1 };
        // One box per page/column: merge lines of the same clause that share a column.
        const list = (boxesFor[b.id] ??= []);
        const last = list[list.length - 1];
        if (last && last.page === page && Math.abs(last.x0 - hit.x0) < NUM_W + 1 && hit.y0 - last.y1 < LEAD) {
          last.x0 = Math.min(last.x0, hit.x0);
          last.x1 = Math.max(last.x1, hit.x1);
          last.y1 = hit.y1;
        } else list.push(hit);
      }
      y += LEAD;
    });
    y += 4;
  }
  const pages = page;

  const sheets: PDFPage[] = [];
  for (let n = 1; n <= pages; n++) sheets.push(pdf.addPage([A4_W, A4_H]));
  const top = (p: PDFPage, ytop: number, h = 0) => A4_H - ytop - h; // top-left origin → PDF origin
  const ink = rgb(0.1, 0.1, 0.1);

  // Title block, running head, footer.
  sheets[0]!.drawText('SUB-LEASE OF WAREHOUSE UNIT', { x: MARGIN, y: top(sheets[0]!, 60, 14), size: 16, font: bold, color: ink });
  sheets[0]!.drawText('Sample agreement · not a real contract', { x: MARGIN, y: top(sheets[0]!, 80, 9), size: 9, font, color: rgb(0.3, 0.3, 0.3) });
  sheets[0]!.drawLine({ start: { x: MARGIN, y: top(sheets[0]!, 96) }, end: { x: A4_W - MARGIN, y: top(sheets[0]!, 96) }, thickness: 0.6, color: rgb(0.5, 0.5, 0.5) });
  sheets.forEach((s, i) => {
    if (i > 0) s.drawText('Sub-lease of warehouse unit', { x: MARGIN, y: top(s, 40, 8), size: 8, font, color: rgb(0.3, 0.3, 0.3) });
    s.drawText(`L1 · Kloof Storage (Pty) Ltd (sample)`, { x: MARGIN, y: top(s, A4_H - 40, 8), size: 8, font, color: rgb(0.3, 0.3, 0.3) });
    const label = `Page ${i + 1} of ${pages}`;
    s.drawText(label, { x: A4_W - MARGIN - font.widthOfTextAtSize(label, 8), y: top(s, A4_H - 40, 8), size: 8, font, color: rgb(0.3, 0.3, 0.3) });
  });
  // Body text, in reading order: column 1 then column 2, page by page.
  for (const p of placed) {
    const s = sheets[p.page - 1]!;
    const f = p.bold ? bold : font;
    if (p.num) s.drawText(p.num, { x: p.x - NUM_W, y: top(s, p.y, p.size), size: p.size, font: bold, color: ink });
    s.drawText(p.line, { x: p.x, y: top(s, p.y, p.size), size: p.size, font: f, color: ink });
  }

  // A red "RECEIVED" stamp lying over the end of clause 4.1's first line, as a rubber stamp does.
  const target = boxesFor['l1-4-1']![0]!;
  const stampPage = sheets[target.page - 1]!;
  const cx = Math.min(target.x1 - 30, A4_W - MARGIN - 60);
  const cy = target.y0 + 4;
  const angle = 9;
  const rad = (angle * Math.PI) / 180;
  const at = (u: number, v: number) => ({ x: cx + u * Math.cos(rad) - v * Math.sin(rad), y: A4_H - cy + u * Math.sin(rad) + v * Math.cos(rad) });
  const red = rgb(0.72, 0.1, 0.1);
  const o = at(-52, -17);
  stampPage.drawRectangle({ x: o.x, y: o.y, width: 104, height: 34, rotate: degrees(angle), borderColor: red, borderWidth: 1.6, opacity: 0, borderOpacity: 0.8 });
  const t1 = at(-40, 2);
  stampPage.drawText('RECEIVED', { x: t1.x, y: t1.y, size: 13, font: bold, color: red, rotate: degrees(angle), opacity: 0.8 });
  const t2 = at(-38, -11);
  stampPage.drawText('12 MAR 2026', { x: t2.x, y: t2.y, size: 9, font: bold, color: red, rotate: degrees(angle), opacity: 0.8 });

  writeFileSync(join(dir, FILE), await pdf.save());

  // boxes.json: every clause the answers point at, in points from the top-left, one entry per page/column it sits in.
  const r1 = (n: number) => Math.round(n * 10) / 10;
  const boxes: Record<string, Record<string, unknown>> = { [FILE]: {} };
  for (const [id, list] of Object.entries(boxesFor)) {
    boxes[FILE]![id] = list.map((b) => ({ page: b.page, x: r1(b.x0), y: r1(b.y0), w: r1(b.x1 - b.x0), h: r1(b.y1 - b.y0) }));
  }
  writeFileSync(join(dir, 'boxes.json'), JSON.stringify(boxes, null, 2) + '\n');

  // The answers, worked out with the same date arithmetic the engine uses.
  const start = '2026-08-01';
  const end = addDays(addMonths(start, 24), -1);
  const renewal = addDays(end, 1);
  const cancel = addDays(renewal, -90);
  const asAt = '2026-10-14';
  const expected = {
    asAt,
    alertWindows: { attention: 30, upcoming: 90 },
    agreements: {
      l1: {
        fields: {
          counterparty: { value: 'Kloof Storage (Pty) Ltd', source: ['l1-1-1'] },
          premises: { value: 'Unit 12, Kloof Business Yard, Pinetown', source: ['l1-2-1'] },
          startDate: { value: start, source: ['l1-3-1'] },
          termMonths: { value: 24, source: ['l1-3-2'] },
          endDate: { value: end, source: ['l1-3-2'], derived: 'start + 24 months − 1 day' },
          renewal: { value: { kind: 'automatic', periodMonths: 12 }, source: ['l1-5-1'] },
          notice: { value: { amount: 90, unit: 'days', before: 'renewal' }, source: ['l1-5-2'] },
          fee: { value: { cents: 1850000, per: 'month', vat: 'excluded' }, source: ['l1-4-1'] },
          feeChange: { value: { kind: 'percent_escalation', percent: 7, every: 'anniversary' }, source: ['l1-4-2'] },
          deposit: { value: 3700000, source: ['l1-4-3'] },
        },
        flags: [],
        dates: [
          { key: 'cancellation_deadline', label: 'Cancellation deadline', value: cancel, derivation: `${renewal} − 90 days`, status: 'later' },
          { key: 'renewal', label: 'Renewal date', value: renewal, derivation: 'end date + 1 day', status: 'later' },
        ],
      },
    },
  };
  writeFileSync(join(dir, 'expected.json'), JSON.stringify(expected, null, 2) + '\n');
  writeFileSync(
    join(dir, 'sample.json'),
    JSON.stringify({ synthetic: true, asAt, organisation: 'Marula Office Supplies (Pty) Ltd', agreements: [{ id: 'l1', files: [FILE] }] }, null, 2) + '\n',
  );

  // The answer a perfect extractor gives, quoting the text as it sits on the page.
  const q = (id: string) => CLAUSES.find((c) => c.id === id)!.text;
  const cand = (value: unknown, id: string, clause: string, page?: number) => ({ value, quote: q(id), file: FILE, page: page ?? boxesFor[id]![0]!.page, clause });
  mkdirSync(join(dir, 'recorded'), { recursive: true });
  writeFileSync(
    join(dir, 'recorded', 'extract-perfect.json'),
    JSON.stringify(
      {
        _note: 'Hand-built from expected.json and the clause text: what a perfect extractor returns for layout-lakeside.',
        l1: {
          amendments: [],
          fields: {
            counterparty: [cand('Kloof Storage (Pty) Ltd', 'l1-1-1', 'cl. 1.1')],
            premises: [cand('Unit 12, Kloof Business Yard, Pinetown', 'l1-2-1', 'cl. 2.1')],
            startDate: [cand(start, 'l1-3-1', 'cl. 3.1')],
            termMonths: [cand(24, 'l1-3-2', 'cl. 3.2')],
            renewal: [cand({ kind: 'automatic', periodMonths: 12 }, 'l1-5-1', 'cl. 5.1')],
            notice: [cand({ amount: 90, unit: 'days', before: 'renewal' }, 'l1-5-2', 'cl. 5.2')],
            fee: [cand({ cents: 1850000, per: 'month', vat: 'excluded' }, 'l1-4-1', 'cl. 4.1')],
            feeChange: [cand({ kind: 'percent_escalation', percent: 7, every: 'anniversary' }, 'l1-4-2', 'cl. 4.2')],
            deposit: [cand(3700000, 'l1-4-3', 'cl. 4.3')],
          },
        },
      },
      null,
      2,
    ) + '\n',
  );
  console.log(`layout-lakeside: ${FILE}, ${pages} pages, ${Object.keys(boxesFor).length} clauses with boxes; stamp on page ${target.page}`);
}

// ---------------------------------------------------------------------------
// watermark-marula
// ---------------------------------------------------------------------------
async function watermarkSample() {
  const from = join(root, 'demo-marula');
  const dir = join(root, 'watermark-marula');
  if (!existsSync(join(from, 'sample.json'))) throw new Error('Run render-demo.ts first: eval/contracts/demo-marula/ is missing');
  mkdirSync(dir, { recursive: true });
  const sample = JSON.parse(readFileSync(join(from, 'sample.json'), 'utf8')) as { agreements: { files: string[] }[] };
  let pages = 0;
  for (const file of sample.agreements.flatMap((a) => a.files)) {
    const pdf = await PDFDocument.load(readFileSync(join(from, file)));
    pdf.setCreationDate(FIXED);
    pdf.setModificationDate(FIXED);
    const font = await pdf.embedFont(StandardFonts.HelveticaBold);
    for (const p of pdf.getPages()) {
      const { width, height } = p.getSize();
      // Three darker marks down each page, over the body text. (One big pale mark was ignored by LlamaParse: it
      // read the same text as for the plain PDF, so it tested nothing.)
      const size = 64;
      const text = 'SAMPLE';
      const angle = 30;
      const rad = (angle * Math.PI) / 180;
      const tw = font.widthOfTextAtSize(text, size);
      for (const [fx, fy] of [[0.5, 0.26], [0.5, 0.52], [0.5, 0.78]] as const) {
        const cx = width * fx;
        const cy = height * fy;
        const x = cx - (tw / 2) * Math.cos(rad) + (size * 0.35) * Math.sin(rad);
        const y = cy - (tw / 2) * Math.sin(rad) - (size * 0.35) * Math.cos(rad);
        p.drawText(text, { x, y, size, font, color: rgb(0.35, 0.35, 0.35), rotate: degrees(angle), opacity: 0.6 });
      }
      pages++;
    }
    writeFileSync(join(dir, file), await pdf.save());
  }
  for (const f of ['expected.json', 'boxes.json']) copyFileSync(join(from, f), join(dir, f));
  mkdirSync(join(dir, 'recorded'), { recursive: true });
  copyFileSync(join(from, 'recorded', 'extract-perfect.json'), join(dir, 'recorded', 'extract-perfect.json'));
  writeFileSync(join(dir, 'sample.json'), JSON.stringify({ ...JSON.parse(readFileSync(join(from, 'sample.json'), 'utf8')), note: 'The demo contracts with three dark grey diagonal SAMPLE marks over every page.' }, null, 2) + '\n');
  console.log(`watermark-marula: ${sample.agreements.flatMap((a) => a.files).length} files, ${pages} pages watermarked`);
}

await layoutSample();
await watermarkSample();
