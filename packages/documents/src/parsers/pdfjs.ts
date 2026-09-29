// Local PDF.js parser. For development and digital PDFs (with a text layer) only: it is not an OCR
// parser and must not be used for production scans. A page with almost no text fails with
// ParserError('no_text_layer'), the signal that the file is a scan and needs LlamaParse.
//
// Node only (eval, tests, scripts). It is exported from '@happy/documents/pdfjs', not the package
// index, so edge functions never load pdfjs-dist.

import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { ParserError } from '../errors.ts';
import type { ParsedDocument, ParsedPage, Parser, Word } from '../types.ts';

const MIN_PAGE_CHARS = 20;

/** The fields of a PDF.js text item that are used here. */
interface PdfTextItem {
  str: string;
  transform: number[];
  width: number;
  height: number;
  hasEOL: boolean;
}

export interface PdfjsOptions {
  /** A page with almost no text: 'throw' (default) fails the parse with no_text_layer; 'keep' returns the page
   *  flagged positionsOk: false with no text or words, so the other pages can still be read (used by the coordinate test). */
  onEmptyPage?: 'throw' | 'keep';
}

export function createPdfjsParser(opts: PdfjsOptions = {}): Parser {
  return {
    async parse(file) {
      // PDF.js may detach the buffer it is given; pass a copy.
      const task = getDocument({ data: new Uint8Array(file), verbosity: 0 });
      const doc = await task.promise;
      try {
        const pages: ParsedPage[] = [];
        for (let n = 1; n <= doc.numPages; n++) {
          const page = await doc.getPage(n);
          const viewport = page.getViewport({ scale: 1 });
          const content = await page.getTextContent();
          const items = content.items.flatMap((i) => ('str' in i ? [i as PdfTextItem] : []));
          const parsed = pageFromItems(n, viewport.width, viewport.height, items, (x, y) => viewport.convertToViewportPoint(x, y) as [number, number]);
          if (parsed.text.replace(/\s/g, '').length < MIN_PAGE_CHARS) {
            const message = `Page ${n} has no text layer (it looks scanned). Use an OCR parser.`;
            if (opts.onEmptyPage !== 'keep') throw new ParserError('no_text_layer', message);
            pages.push({ page: n, width: viewport.width, height: viewport.height, text: '', words: [], positionsOk: false, positionsError: message });
          } else pages.push(parsed);
          page.cleanup();
        }
        return { parser: 'pdfjs', pageCount: doc.numPages, pages } satisfies ParsedDocument;
      } finally {
        await task.destroy();
      }
    },
  };
}

/** Builds page text in reading order from PDF.js text items, with a box for every word. */
export function pageFromItems(
  page: number,
  width: number,
  height: number,
  items: PdfTextItem[],
  toViewport: (x: number, y: number) => [number, number],
): ParsedPage {
  let text = '';
  const words: Word[] = [];
  let last: { baseline: number; endX: number; size: number } | null = null;

  for (const item of items) {
    const [a, b, c, d, e, f] = item.transform as [number, number, number, number, number, number];
    const size = Math.hypot(c, d) || item.height || Math.hypot(a, b);
    // Baseline start in viewport space (top-left origin); the glyph box sits from 0.8 × size above
    // the baseline to 0.2 × size below it.
    const [x, baseline] = toViewport(e, f);

    if (item.str.length) {
      if (last && text.length && !/\s$/.test(text)) {
        if (Math.abs(baseline - last.baseline) > last.size * 0.5) text += '\n';
        else if (x - last.endX > size * 0.15 && !/^\s/.test(item.str)) text += ' ';
      }
      const offset = text.length;
      text += item.str;
      // An item can hold several words. PDF.js only gives the item's width, so each word's box is
      // estimated from its share of the item's characters.
      const perChar = item.str.length ? item.width / item.str.length : 0;
      for (const m of item.str.matchAll(/\S+/g)) {
        words.push({
          text: m[0],
          start: offset + m.index,
          end: offset + m.index + m[0].length,
          box: { x: x + perChar * m.index, y: baseline - size * 0.8, w: perChar * m[0].length, h: size },
        });
      }
      last = { baseline, endX: x + item.width, size };
    }
    if (item.hasEOL && text.length && !text.endsWith('\n')) text += '\n';
  }
  return { page, width, height, text: text.trimEnd(), words };
}
