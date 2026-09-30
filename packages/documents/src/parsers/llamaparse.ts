// LlamaParse (cloud, EU region) via the v2 REST API. Returns word boxes from its granular grounding.
// Docs checked 29 Sep 2026:
//   https://developers.llamaindex.ai/llamaparse/parse/guides/api-reference/
//   https://developers.llamaindex.ai/llamaparse/parse/examples/parse_granular_bboxes/
//   https://developers.llamaindex.ai/llamaparse/parse/guides/migration-v1-to-v2/
//   https://developers.llamaindex.ai/llamaparse/general/regions/
// Word boxes are not inline in `items`: they come in a JSONL sidecar (one line per page) whose
// presigned URL is at result_content_metadata.grounded_items. Inline item grounding is used if present.
//
// Runs in Node and Deno (plain fetch, FormData, Blob). Offshore: callers must pass the organisation's
// offshore_processing_approved flag.

import { ParserError, requireOffshore } from '../errors.ts';
import type { Box, ParsedDocument, ParsedPage, Parser, Word } from '../types.ts';

export const LLAMA_EU_BASE_URL = 'https://api.cloud.eu.llamaindex.ai';

/** Credits per page by tier. Prices checked 29 Sep 2026 ($1.25 per 1,000 credits); re-check before relying on them. */
export const CREDITS_PER_PAGE: Record<string, number> = { cost_effective: 3, agentic: 10, agentic_plus: 45 };
const TIERS = Object.keys(CREDITS_PER_PAGE);

export interface LlamaParseConfig {
  apiKey: string;
  /** Defaults to the EU region. Never defaults to North America. */
  baseUrl?: string;
  /** Parser version to pin per tier, as a release date ("2026-09-28"). A tier not listed uses "latest", which the
   *  API never reports back, so a run on "latest" can't be repeated later. Only real release dates are accepted. */
  versions?: Record<string, string>;
  /** The organisation's offshore_processing_approved flag (or an eval sample's synthetic: true). */
  offshoreAllowed: boolean;
  fetch?: typeof fetch;
  /** For parse(): how often to poll and when to give up. */
  pollIntervalMs?: number;
  timeoutMs?: number;
  /** Backoff before a retry, in ms (tests set 0). */
  retryDelayMs?: number;
}

/** A finished job: the mapped document, the raw JSONL sidecar exactly as LlamaParse sent it (so a file can be
 *  re-grounded later without paying to parse again), and the credits the job reports using, when it says. */
export interface LlamaFetched { document: ParsedDocument; sidecar?: string; creditsUsed?: number }

export interface LlamaParser extends Parser {
  submit(file: Uint8Array, opts: { tier?: string; filename: string }): Promise<string>;
  fetchResult(jobId: string): Promise<ParsedDocument | 'pending'>;
  fetchWithRaw(jobId: string): Promise<LlamaFetched | 'pending'>;
  parseWithRaw(file: Uint8Array, opts: { tier?: string; filename: string }): Promise<LlamaFetched>;
}

// ---- response shapes (only the fields used)
interface LlamaBox { x: number; y: number; w: number; h: number; r?: number }
interface LlamaWord { span: [number, number]; bbox: LlamaBox }
interface LlamaLine { span: [number, number]; bbox: LlamaBox; words?: LlamaWord[] | null }
interface LlamaCell { span?: [number, number]; bbox?: LlamaBox[] | LlamaBox; lines?: LlamaLine[] | null }
interface LlamaGrounding { source?: string; lines?: LlamaLine[]; rows?: (LlamaCell | null)[][] }
export interface LlamaItem { type?: string; md?: string; value?: string; rows?: string[][]; grounding?: LlamaGrounding | null }
export interface LlamaPage {
  page_number: number;
  page_width?: number;
  page_height?: number;
  success?: boolean;
  error?: string;
  items?: LlamaItem[];
}
interface LlamaJobResponse {
  job?: { id: string; status: string; tier?: string; error_message?: string | null; usage?: unknown };
  items?: { pages?: LlamaPage[] };
  metadata?: { version?: string };
  usage?: unknown;
  result_content_metadata?: { grounded_items?: { exists?: boolean; presigned_url?: string } };
}

/** The credits a job reports using: `usage` as a number, or the first numeric field with "credit" in its name.
 *  The docs don't give the usage shape, so anything else is "unknown" rather than a guess. */
export function creditsFromUsage(usage: unknown): number | undefined {
  if (typeof usage === 'number' && Number.isFinite(usage)) return usage;
  if (usage && typeof usage === 'object') {
    for (const [k, v] of Object.entries(usage)) {
      if (/credit/i.test(k) && typeof v === 'number' && Number.isFinite(v)) return v;
    }
  }
  return undefined;
}

export function createLlamaParseParser(cfg: LlamaParseConfig): LlamaParser {
  requireOffshore(cfg.offshoreAllowed, 'LlamaParse');
  if (!cfg.apiKey) throw new ParserError('auth', 'LlamaParse key missing or wrong (LLAMA_CLOUD_API_KEY is empty)');
  const base = (cfg.baseUrl || LLAMA_EU_BASE_URL).replace(/\/+$/, '');
  const doFetch = cfg.fetch ?? fetch;
  const retryDelay = cfg.retryDelayMs ?? 2000;
  const headers = { Authorization: `Bearer ${cfg.apiKey}` };

  /** At most two retries, only for network errors, 429 and 5xx. */
  async function call(url: string, init: RequestInit): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      let res: Response | null = null;
      try {
        res = await doFetch(url, init);
      } catch (err) {
        if (attempt >= 2) throw new ParserError('failed', `LlamaParse could not be reached: ${(err as Error).message}`);
      }
      if (res) {
        if (res.ok) return res;
        const body = await res.text();
        if (res.status === 401 || res.status === 403) throw new ParserError('auth', 'LlamaParse key missing or wrong');
        if (res.status === 402 || /credit/i.test(body)) {
          throw new ParserError('credits', 'LlamaParse credits are used up. Top up the LlamaCloud account, then try again.');
        }
        if (!(res.status === 429 || res.status >= 500) || attempt >= 2) {
          throw new ParserError('failed', `LlamaParse returned ${res.status}: ${body.slice(0, 300)}`);
        }
      }
      await new Promise((r) => setTimeout(r, retryDelay * (attempt + 1)));
    }
  }

  async function submit(file: Uint8Array, opts: { tier?: string; filename: string }): Promise<string> {
    const tier = opts.tier ?? 'cost_effective';
    if (!TIERS.includes(tier)) throw new ParserError('failed', `LlamaParse tier "${tier}" gives no word boxes; use one of ${TIERS.join(', ')}`);
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(file)], { type: 'application/pdf' }), opts.filename);
    form.append(
      'configuration',
      JSON.stringify({
        tier,
        version: cfg.versions?.[tier] ?? 'latest',
        disable_cache: true, // v2 name for do_not_cache; top level of the configuration
        output_options: { granular_bboxes: ['word', 'line'] },
      }),
    );
    const res = await call(`${base}/api/v2/parse/upload`, { method: 'POST', headers, body: form });
    const body = (await res.json()) as { id?: string };
    if (!body.id) throw new ParserError('bad_response', 'LlamaParse accepted the upload but returned no job id');
    return body.id;
  }

  /**
   * The job, with its items, metadata (the version 'latest' resolved to) and usage (credits). The docs list
   * these expand values but not the response shape of the last two, so if this account's API rejects them
   * (400/422) the call is repeated with items only, and version and credits are left unknown.
   */
  async function getJob(jobId: string): Promise<Response> {
    const url = (expand: string) => `${base}/api/v2/parse/${encodeURIComponent(jobId)}?expand=${expand}`;
    try {
      return await call(url('items,metadata,usage'), { headers });
    } catch (err) {
      if (err instanceof ParserError && err.code === 'failed' && /returned (400|422)\b/.test(err.message)) return call(url('items'), { headers });
      throw err;
    }
  }

  async function fetchWithRaw(jobId: string): Promise<LlamaFetched | 'pending'> {
    const res = await getJob(jobId);
    const body = (await res.json()) as LlamaJobResponse;
    const status = body.job?.status;
    if (status === 'PENDING' || status === 'RUNNING') return 'pending';
    if (status !== 'COMPLETED') {
      throw new ParserError('failed', `LlamaParse job ${jobId} ${status?.toLowerCase() ?? 'returned no status'}${body.job?.error_message ? `: ${body.job.error_message}` : ''}`);
    }
    let pages = body.items?.pages ?? [];
    let raw: string | undefined;
    const sidecar = body.result_content_metadata?.grounded_items;
    if (sidecar?.exists !== false && sidecar?.presigned_url) {
      // Presigned: no auth header. The URL expires, so fetch it now.
      const side = await call(sidecar.presigned_url, {});
      raw = await side.text();
      pages = parseJsonl(raw);
    }
    const tier = body.job?.tier;
    const parsed = mapLlamaPages(pages);
    const version = body.metadata?.version ?? (tier ? cfg.versions?.[tier] : undefined);
    const creditsUsed = creditsFromUsage(body.job?.usage ?? body.usage);
    return {
      document: {
        parser: 'llamaparse',
        tier,
        // The API doesn't report a version, so the one we pinned for this tier is what the file was read with.
        ...(version ? { version } : {}),
        pageCount: parsed.length,
        pages: parsed,
        creditsEstimate: tier && CREDITS_PER_PAGE[tier] ? parsed.length * CREDITS_PER_PAGE[tier] : undefined,
      },
      ...(raw === undefined ? {} : { sidecar: raw }),
      ...(creditsUsed === undefined ? {} : { creditsUsed }),
    };
  }

  /** Submits, then polls until the job is done. Returns the raw sidecar with the mapped document. */
  async function parseWithRaw(file: Uint8Array, opts: { tier?: string; filename: string }): Promise<LlamaFetched> {
    const jobId = await submit(file, opts);
    const deadline = Date.now() + (cfg.timeoutMs ?? 10 * 60_000);
    for (;;) {
      const result = await fetchWithRaw(jobId);
      if (result !== 'pending') return result;
      if (Date.now() > deadline) throw new ParserError('failed', `LlamaParse job ${jobId} still running after ${(cfg.timeoutMs ?? 600_000) / 1000}s`);
      await new Promise((r) => setTimeout(r, cfg.pollIntervalMs ?? 3000));
    }
  }

  async function fetchResult(jobId: string): Promise<ParsedDocument | 'pending'> {
    const r = await fetchWithRaw(jobId);
    return r === 'pending' ? r : r.document;
  }

  return {
    submit,
    fetchResult,
    fetchWithRaw,
    parseWithRaw,
    async parse(file, opts) {
      return (await parseWithRaw(file, opts)).document;
    },
  };
}

/** A saved raw sidecar (JSONL text) mapped again: how a stored parse is re-read after the mapping changes, at no cost. */
export function documentFromSidecar(jsonl: string, tier?: string): ParsedDocument {
  const pages = mapLlamaPages(parseJsonl(jsonl));
  return {
    parser: 'llamaparse',
    ...(tier ? { tier } : {}),
    pageCount: pages.length,
    pages,
    creditsEstimate: tier && CREDITS_PER_PAGE[tier] ? pages.length * CREDITS_PER_PAGE[tier] : undefined,
  };
}

export function parseJsonl(text: string): LlamaPage[] {
  return text
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as LlamaPage);
}

/** r is kept exactly as LlamaParse gives it. Never add the page's own rotation to it: page_width/page_height already include /Rotate. */
const toBox = (b: LlamaBox): Box => (b.r ? { x: b.x, y: b.y, w: b.w, h: b.h, r: b.r } : { x: b.x, y: b.y, w: b.w, h: b.h });

/**
 * Where each cell's text sits in a markdown table's md: cells[row][col] = { start, text }. Rows are the md's
 * lines apart from the |---| rule, so row 0 is the header. `plain` is the sidecar's own cell text (item.rows),
 * used to find the text inside markup such as **bold**; a cell whose text can't be found is left out.
 */
export function tableCells(md: string, plain?: string[][]): ({ start: number; text: string } | undefined)[][] {
  const out: ({ start: number; text: string } | undefined)[][] = [];
  let lineStart = 0;
  for (const line of md.split('\n')) {
    const at = lineStart;
    lineStart += line.length + 1;
    if (!line.includes('|') || /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(line)) continue;
    const r = out.length;
    // Cell segments: between unescaped pipes.
    const bars = [...line.matchAll(/(?<!\\)\|/g)].map((m) => m.index);
    const cells: ({ start: number; text: string } | undefined)[] = [];
    for (let i = 0; i + 1 < bars.length; i++) {
      const seg = line.slice(bars[i]! + 1, bars[i + 1]);
      const want = plain?.[r]?.[i];
      const idx = want === undefined ? seg.length - seg.trimStart().length : seg.indexOf(want);
      const text = want === undefined ? seg.trim() : want;
      cells.push(idx >= 0 && text ? { start: at + bars[i]! + 1 + idx, text } : undefined);
    }
    out.push(cells);
  }
  return out;
}

/** Numbers the visual lines of one page, in the order the parser lists them. */
interface LineCounter { n: number }

/**
 * Span offsets in the sidecar count UTF-8 bytes, not characters (seen on a live parse: "·" is span [2,4]).
 * Returns a function from a byte offset in `text` to the matching index in the JS string. Text with only
 * one-byte characters needs no conversion.
 */
function byteToIndex(text: string): (byte: number) => number {
  if (![...text].some((c) => c.charCodeAt(0) > 127)) return (b) => b;
  const at: number[] = [0];
  let index = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    const bytes = cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
    for (let k = 1; k <= bytes; k++) at.push(k === bytes ? index + ch.length : index); // a byte inside a character maps to its start
    index += ch.length;
  }
  return (b) => at[Math.min(Math.max(b, 0), at.length - 1)]!;
}

/** Words of a span of `md` with no word boxes of its own: each word gets its share of the span's box. */
function spreadWords(md: string, span: [number, number], box: LlamaBox, offset: number, line: number, conv = byteToIndex(md)): Word[] {
  const from = conv(span[0]);
  const text = md.slice(from, conv(span[1]));
  const perChar = text.length ? box.w / text.length : 0;
  return [...text.matchAll(/\S+/g)].map((m) => ({
    text: m[0],
    start: offset + from + m.index,
    end: offset + from + m.index + m[0].length,
    box: toBox({ x: box.x + perChar * m.index, y: box.y, w: perChar * m[0].length, h: box.h, r: box.r }),
    line,
  }));
}

function lineWords(md: string, lines: LlamaLine[], offset: number, counter: LineCounter): Word[] {
  const words: Word[] = [];
  const conv = byteToIndex(md);
  for (const line of lines) {
    const no = counter.n++;
    if (line.words?.length) {
      for (const w of line.words) {
        const start = conv(w.span[0]);
        const end = conv(w.span[1]);
        words.push({ text: md.slice(start, end), start: offset + start, end: offset + end, box: toBox(w.bbox), line: no });
      }
    } else if (line.span && line.bbox) {
      words.push(...spreadWords(md, line.span, line.bbox, offset, no, conv));
    }
  }
  return words;
}

/**
 * LlamaParse pages → ParsedPage. A page's text is its items' `md` joined with a blank line; word spans
 * (ranges into each item's md) are shifted by the item's offset. Markdown is kept as-is; the quote check
 * ignores markdown characters.
 */
export function mapLlamaPages(pages: LlamaPage[]): ParsedPage[] {
  const sorted = pages.slice().sort((a, b) => a.page_number - b.page_number);
  if (!sorted.length) throw new ParserError('bad_response', 'LlamaParse returned no pages');
  if (sorted.every((p) => p.success === false)) {
    throw new ParserError('failed', `LlamaParse could not read any page: ${sorted[0]!.error ?? 'no reason given'}`);
  }
  // A page that couldn't be read may not say how big it is; it borrows the first readable page's size.
  const sized = sorted.find((p) => p.success !== false && p.page_width && p.page_height);
  if (!sized) throw new ParserError('bad_response', 'LlamaParse pages have no page_width/page_height');

  return sorted.map((p) => {
    if (p.success === false) {
      // One unreadable page must not lose the rest of the document: keep it, flagged, with no text or words.
      return {
        page: p.page_number,
        width: p.page_width || sized.page_width!,
        height: p.page_height || sized.page_height!,
        text: '',
        words: [],
        positionsOk: false,
        positionsError: p.error ?? 'no reason given',
      };
    }
    if (!p.page_width || !p.page_height) throw new ParserError('bad_response', `LlamaParse page ${p.page_number} has no page_width/page_height`);
    const counter: LineCounter = { n: 0 };
    // Each item's words, with offsets into its own md.
    const built = (p.items ?? [])
      .filter((item) => item.md)
      .map((item) => {
        const md = item.md!;
        const g = item.grounding;
        const own: Word[] = [];
        if (g?.lines) own.push(...lineWords(md, g.lines, 0, counter));
        // Table cells: a cell's word spans count from the start of the cell's own text, not of the table's md.
        const cells = g?.rows?.length ? tableCells(md, item.rows) : [];
        (g?.rows ?? []).forEach((row, r) => {
          row.forEach((cell, c) => {
            const at = cells[r]?.[c];
            if (!cell || !at) return; // a cell that can't be placed in the md gets no boxes rather than wrong ones
            if (cell.lines?.length) own.push(...lineWords(at.text, cell.lines, at.start, counter));
            else if (cell.span && cell.bbox) {
              const box = Array.isArray(cell.bbox) ? cell.bbox[0] : cell.bbox;
              if (box) own.push(...spreadWords(at.text, cell.span, box, at.start, counter.n++));
            }
          });
        });
        return { md, own };
      });
    // Seen on a live /Rotate 90 page: LlamaParse listed some words twice, as separate items at the same place. A
    // repeated item would make every quote from it look like it appears twice, so an item whose words are all
    // the same words at the same places as another item's is dropped (the later of two equal items).
    const wordKey = (w: Word) => `${w.text}|${Math.round(w.box.x * 2)}|${Math.round(w.box.y * 2)}|${Math.round(w.box.w * 2)}|${Math.round(w.box.h * 2)}`;
    const keys = built.map((b) => new Set(b.own.map(wordKey)));
    const redundant = built.map((b, i) => {
      if (!b.own.length) return false;
      // Covered by another item that is bigger, or equal and earlier (so of two equal items the first is kept).
      return keys.some((other, j) => j !== i && [...keys[i]!].every((k) => other.has(k)) && (other.size > keys[i]!.size || j < i));
    });

    let text = '';
    const words: Word[] = [];
    built.forEach((b, i) => {
      if (redundant[i]) return;
      if (text) text += '\n\n';
      const offset = text.length;
      text += b.md;
      words.push(...b.own.map((w) => ({ ...w, start: w.start + offset, end: w.end + offset })));
    });
    if (text.trim() && !words.length) {
      throw new ParserError('bad_response', `LlamaParse returned no word boxes for page ${p.page_number} (granular_bboxes missing?)`);
    }
    words.sort((a, b) => a.start - b.start);
    return { page: p.page_number, width: p.page_width, height: p.page_height, text, words };
  });
}
