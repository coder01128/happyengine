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
  /** The organisation's offshore_processing_approved flag (or an eval sample's synthetic: true). */
  offshoreAllowed: boolean;
  fetch?: typeof fetch;
  /** For parse(): how often to poll and when to give up. */
  pollIntervalMs?: number;
  timeoutMs?: number;
  /** Backoff before a retry, in ms (tests set 0). */
  retryDelayMs?: number;
}

export interface LlamaParser extends Parser {
  submit(file: Uint8Array, opts: { tier?: string; filename: string }): Promise<string>;
  fetchResult(jobId: string): Promise<ParsedDocument | 'pending'>;
}

// ---- response shapes (only the fields used)
interface LlamaBox { x: number; y: number; w: number; h: number }
interface LlamaWord { span: [number, number]; bbox: LlamaBox }
interface LlamaLine { span: [number, number]; bbox: LlamaBox; words?: LlamaWord[] | null }
interface LlamaCell { span?: [number, number]; bbox?: LlamaBox[] | LlamaBox; lines?: LlamaLine[] | null }
interface LlamaGrounding { source?: string; lines?: LlamaLine[]; rows?: (LlamaCell | null)[][] }
export interface LlamaItem { type?: string; md?: string; value?: string; grounding?: LlamaGrounding | null }
export interface LlamaPage {
  page_number: number;
  page_width?: number;
  page_height?: number;
  success?: boolean;
  error?: string;
  items?: LlamaItem[];
}
interface LlamaJobResponse {
  job?: { id: string; status: string; tier?: string; error_message?: string | null };
  items?: { pages?: LlamaPage[] };
  result_content_metadata?: { grounded_items?: { exists?: boolean; presigned_url?: string } };
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
        version: 'latest',
        disable_cache: true, // v2 name for do_not_cache; top level of the configuration
        output_options: { granular_bboxes: ['word', 'line'] },
      }),
    );
    const res = await call(`${base}/api/v2/parse/upload`, { method: 'POST', headers, body: form });
    const body = (await res.json()) as { id?: string };
    if (!body.id) throw new ParserError('bad_response', 'LlamaParse accepted the upload but returned no job id');
    return body.id;
  }

  async function fetchResult(jobId: string): Promise<ParsedDocument | 'pending'> {
    const res = await call(`${base}/api/v2/parse/${encodeURIComponent(jobId)}?expand=items`, { headers });
    const body = (await res.json()) as LlamaJobResponse;
    const status = body.job?.status;
    if (status === 'PENDING' || status === 'RUNNING') return 'pending';
    if (status !== 'COMPLETED') {
      throw new ParserError('failed', `LlamaParse job ${jobId} ${status?.toLowerCase() ?? 'returned no status'}${body.job?.error_message ? `: ${body.job.error_message}` : ''}`);
    }
    let pages = body.items?.pages ?? [];
    const sidecar = body.result_content_metadata?.grounded_items;
    if (sidecar?.exists !== false && sidecar?.presigned_url) {
      // Presigned: no auth header. The URL expires, so fetch it now.
      const side = await call(sidecar.presigned_url, {});
      pages = parseJsonl(await side.text());
    }
    const tier = body.job?.tier;
    const parsed = mapLlamaPages(pages);
    return {
      parser: 'llamaparse',
      tier,
      pageCount: parsed.length,
      pages: parsed,
      creditsEstimate: tier && CREDITS_PER_PAGE[tier] ? parsed.length * CREDITS_PER_PAGE[tier] : undefined,
    };
  }

  return {
    submit,
    fetchResult,
    async parse(file, opts) {
      const jobId = await submit(file, opts);
      const deadline = Date.now() + (cfg.timeoutMs ?? 10 * 60_000);
      for (;;) {
        const result = await fetchResult(jobId);
        if (result !== 'pending') return result;
        if (Date.now() > deadline) throw new ParserError('failed', `LlamaParse job ${jobId} still running after ${(cfg.timeoutMs ?? 600_000) / 1000}s`);
        await new Promise((r) => setTimeout(r, cfg.pollIntervalMs ?? 3000));
      }
    },
  };
}

export function parseJsonl(text: string): LlamaPage[] {
  return text
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as LlamaPage);
}

const toBox = (b: LlamaBox): Box => ({ x: b.x, y: b.y, w: b.w, h: b.h });

/** Words of a span of `md` with no word boxes of its own: each word gets its share of the span's box. */
function spreadWords(md: string, span: [number, number], box: LlamaBox, offset: number): Word[] {
  const text = md.slice(span[0], span[1]);
  const perChar = text.length ? box.w / text.length : 0;
  return [...text.matchAll(/\S+/g)].map((m) => ({
    text: m[0],
    start: offset + span[0] + m.index,
    end: offset + span[0] + m.index + m[0].length,
    box: { x: box.x + perChar * m.index, y: box.y, w: perChar * m[0].length, h: box.h },
  }));
}

function lineWords(md: string, lines: LlamaLine[], offset: number): Word[] {
  const words: Word[] = [];
  for (const line of lines) {
    if (line.words?.length) {
      for (const w of line.words) {
        words.push({ text: md.slice(w.span[0], w.span[1]), start: offset + w.span[0], end: offset + w.span[1], box: toBox(w.bbox) });
      }
    } else if (line.span && line.bbox) {
      words.push(...spreadWords(md, line.span, line.bbox, offset));
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
  return pages
    .slice()
    .sort((a, b) => a.page_number - b.page_number)
    .map((p) => {
      if (p.success === false) throw new ParserError('failed', `LlamaParse could not read page ${p.page_number}: ${p.error ?? 'no reason given'}`);
      if (!p.page_width || !p.page_height) throw new ParserError('bad_response', `LlamaParse page ${p.page_number} has no page_width/page_height`);
      let text = '';
      const words: Word[] = [];
      for (const item of p.items ?? []) {
        const md = item.md ?? '';
        if (!md) continue;
        if (text) text += '\n\n';
        const offset = text.length;
        text += md;
        const g = item.grounding;
        if (!g) continue;
        if (g.lines) words.push(...lineWords(md, g.lines, offset));
        for (const row of g.rows ?? []) {
          for (const cell of row) {
            if (!cell) continue;
            if (cell.lines?.length) words.push(...lineWords(md, cell.lines, offset));
            else if (cell.span && cell.bbox) {
              const box = Array.isArray(cell.bbox) ? cell.bbox[0] : cell.bbox;
              if (box) words.push(...spreadWords(md, cell.span, box, offset));
            }
          }
        }
      }
      if (text.trim() && !words.length) {
        throw new ParserError('bad_response', `LlamaParse returned no word boxes for page ${p.page_number} (granular_bboxes missing?)`);
      }
      words.sort((a, b) => a.start - b.start);
      return { page: p.page_number, width: p.page_width, height: p.page_height, text, words };
    });
}
