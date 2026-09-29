import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createLlamaParseParser, creditsFromUsage, ground, LLAMA_EU_BASE_URL, OffshoreNotApproved, ParserError, type LlamaParser } from '../src/index.ts';

// Saved sample response (see _note in the JSON): the poll result and its grounded_items sidecar.
const fixtures = join(import.meta.dirname, 'fixtures');
const jobJson = readFileSync(join(fixtures, 'llamaparse-job.json'), 'utf8');
const sidecar = readFileSync(join(fixtures, 'llamaparse-grounded.jsonl'), 'utf8');

interface Call { url: string; init: RequestInit }
function mockFetch(responses: (Response | ((c: Call) => Response))[]) {
  const calls: Call[] = [];
  const fn = (async (url: string | URL | Request, init: RequestInit = {}) => {
    const call = { url: String(url), init };
    calls.push(call);
    const next = responses.shift();
    if (!next) throw new Error(`unexpected request to ${call.url}`);
    return typeof next === 'function' ? next(call) : next;
  }) as typeof fetch;
  return { fn, calls };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const make = (fetchFn: typeof fetch, extra: Partial<Parameters<typeof createLlamaParseParser>[0]> = {}): LlamaParser =>
  createLlamaParseParser({ apiKey: 'llx-test', offshoreAllowed: true, fetch: fetchFn, retryDelayMs: 0, pollIntervalMs: 0, ...extra });

describe('llamaparse adapter', () => {
  it('uploads to the EU region with the v2 configuration', async () => {
    const m = mockFetch([json({ id: 'job-123', status: 'PENDING' })]);
    const jobId = await make(m.fn).submit(new Uint8Array([37, 80, 68, 70]), { filename: 'c2.pdf', tier: 'agentic' });
    expect(jobId).toBe('job-123');
    const { url, init } = m.calls[0]!;
    expect(url).toBe(`${LLAMA_EU_BASE_URL}/api/v2/parse/upload`);
    expect(LLAMA_EU_BASE_URL).toBe('https://api.cloud.eu.llamaindex.ai');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer llx-test');
    const form = init.body as FormData;
    expect((form.get('file') as File).name).toBe('c2.pdf');
    expect(JSON.parse(form.get('configuration') as string)).toEqual({
      tier: 'agentic',
      version: 'latest',
      disable_cache: true,
      output_options: { granular_bboxes: ['word', 'line'] },
    });
  });

  it('refuses the fast tier, which has no word boxes', async () => {
    await expect(make(mockFetch([]).fn).submit(new Uint8Array(1), { filename: 'x.pdf', tier: 'fast' })).rejects.toThrow(/no word boxes/);
  });

  it('reports a job that is still running as pending', async () => {
    const m = mockFetch([json({ job: { id: 'job-123', status: 'RUNNING' } })]);
    expect(await make(m.fn).fetchResult('job-123')).toBe('pending');
    expect(m.calls[0]!.url).toBe(`${LLAMA_EU_BASE_URL}/api/v2/parse/job-123?expand=items,metadata,usage`);
  });

  it('maps the grounded result: page text, word offsets, page size, credits', async () => {
    const m = mockFetch([json(JSON.parse(jobJson)), new Response(sidecar)]);
    const doc = await make(m.fn).fetchResult('job-123');
    if (doc === 'pending') throw new Error('pending');
    expect(m.calls[1]!.url).toBe('https://storage.example/grounded_items.jsonl?sig=abc');
    expect(m.calls[1]!.init.headers).toBeUndefined(); // presigned: no key sent

    expect(doc).toMatchObject({ parser: 'llamaparse', tier: 'cost_effective', pageCount: 2, creditsEstimate: 6 });
    const [p1, p2] = doc.pages;
    expect(p1!.page).toBe(1);
    expect(p1!).toMatchObject({ width: 612, height: 792 });
    expect(p1!.text).toBe('# Order form\n\nThe **Subscription Fee** is R4 850.00 per month.\n\n| Item | Rate |\n| --- | --- |\n| Local | R95.00 |');
    // Every word's offsets point at its own text in page.text.
    for (const p of doc.pages) for (const w of p.words) expect(p.text.slice(w.start, w.end)).toBe(w.text);
    // A line without word boxes is split by share of its box; table cells become words.
    expect(p1!.words.map((w) => w.text)).toEqual(['Order', 'form', 'The', '**Subscription', 'Fee**', 'is', 'R4', '850.00', 'per', 'month.', 'Item', 'Rate', 'Local', 'R95.00']);
    expect(p2!.words.find((w) => w.text === '60')!.box).toEqual({ x: 72 + 7 * 6 + 4 + 2 * 6 + 4, y: 90, w: 12, h: 12 });
  });

  it('grounds a quote on the mapped page through the markdown', async () => {
    const m = mockFetch([json(JSON.parse(jobJson)), new Response(sidecar)]);
    const doc = await make(m.fn).fetchResult('job-123');
    if (doc === 'pending') throw new Error('pending');
    const r = ground('The Subscription Fee is R4 850.00 per month', doc.pages[0]!, 0.9);
    expect(r).toMatchObject({ status: 'grounded', score: 1 });
    expect(r.boxes).toHaveLength(2);
    expect(ground('Local R95.00', doc.pages[0]!, 0.9).status).toBe('grounded');
  });

  it('uses inline grounding when there is no sidecar', async () => {
    const pages = sidecar.trim().split('\n').map((l) => JSON.parse(l));
    const m = mockFetch([json({ job: { id: 'j', status: 'COMPLETED', tier: 'agentic' }, items: { pages } })]);
    const doc = await make(m.fn).fetchResult('j');
    if (doc === 'pending') throw new Error('pending');
    expect(doc.pageCount).toBe(2);
    expect(doc.creditsEstimate).toBe(20);
  });

  it('fails when no word boxes come back', async () => {
    const m = mockFetch([json({ job: { id: 'j', status: 'COMPLETED' }, items: { pages: [{ page_number: 1, page_width: 612, page_height: 792, items: [{ md: 'Text' }] }] } })]);
    await expect(make(m.fn).fetchResult('j')).rejects.toThrow(/no word boxes/);
  });

  it('explains a failed job, a bad key and used-up credits', async () => {
    await expect(make(mockFetch([json({ job: { id: 'j', status: 'FAILED', error_message: 'corrupt file' } })]).fn).fetchResult('j')).rejects.toThrow(/failed: corrupt file/);
    await expect(make(mockFetch([json({ detail: 'Unauthorized' }, 401)]).fn).fetchResult('j')).rejects.toThrow('LlamaParse key missing or wrong');
    await expect(make(mockFetch([json({ detail: 'Payment required' }, 402)]).fn).fetchResult('j')).rejects.toMatchObject({ code: 'credits' });
  });

  it('retries a server error at most twice', async () => {
    const m = mockFetch([json({}, 503), json({}, 503), json({}, 503), json({}, 503)]);
    await expect(make(m.fn).fetchResult('j')).rejects.toBeInstanceOf(ParserError);
    expect(m.calls).toHaveLength(3);
  });

  it('parse() submits, polls until done and returns the document', async () => {
    const m = mockFetch([json({ id: 'job-123', status: 'PENDING' }), json({ job: { id: 'job-123', status: 'PENDING' } }), json(JSON.parse(jobJson)), new Response(sidecar)]);
    const doc = await make(m.fn).parse(new Uint8Array(4), { filename: 'c2.pdf' });
    expect(doc.pageCount).toBe(2);
  });

  it('uses LLAMA_CLOUD_BASE_URL when given', async () => {
    const m = mockFetch([json({ job: { id: 'j', status: 'RUNNING' } })]);
    await make(m.fn, { baseUrl: 'https://eu.example/' }).fetchResult('j');
    expect(m.calls[0]!.url).toBe('https://eu.example/api/v2/parse/j?expand=items,metadata,usage');
  });
});

describe('llamaparse adapter: positions, unreadable pages, version and usage', () => {
  const page = (n: number, extra: object = {}) => ({
    page_number: n,
    page_width: 842,
    page_height: 595,
    success: true,
    items: [{ type: 'text', md: 'Alpha Bravo', grounding: { lines: [{ span: [0, 11], bbox: { x: 10, y: 20, w: 100, h: 12 }, words: [
      { span: [0, 5], bbox: { x: 10, y: 20, w: 40, h: 12, r: 90 } },
      { span: [6, 11], bbox: { x: 60, y: 20, w: 50, h: 12 } },
    ] }] } }],
    ...extra,
  });

  it('keeps r exactly as given and numbers the lines', async () => {
    const m = mockFetch([json({ job: { id: 'j', status: 'COMPLETED' }, items: { pages: [page(1)] } })]);
    const doc = await make(m.fn).fetchResult('j');
    if (doc === 'pending') throw new Error('pending');
    const [a, b] = doc.pages[0]!.words;
    expect(a).toMatchObject({ text: 'Alpha', line: 0, box: { x: 10, y: 20, w: 40, h: 12, r: 90 } });
    expect(b!.box).toEqual({ x: 60, y: 20, w: 50, h: 12 }); // no r: upright, nothing added
    expect(doc.pages[0]).toMatchObject({ width: 842, height: 595 }); // page size as given, /Rotate already in it
  });

  it('keeps an unreadable page, flagged, and the readable pages around it', async () => {
    const bad = { page_number: 2, success: false, error: 'page render failed' };
    const m = mockFetch([json({ job: { id: 'j', status: 'COMPLETED' }, items: { pages: [page(3), bad, page(1)] } })]);
    const doc = await make(m.fn).fetchResult('j');
    if (doc === 'pending') throw new Error('pending');
    expect(doc.pages.map((p) => p.page)).toEqual([1, 2, 3]);
    expect(doc.pages[1]).toEqual({ page: 2, width: 842, height: 595, text: '', words: [], positionsOk: false, positionsError: 'page render failed' });
    expect(doc.pages[0]!.positionsOk).toBeUndefined();
  });

  it('fails when no page could be read', async () => {
    const m = mockFetch([json({ job: { id: 'j', status: 'COMPLETED' }, items: { pages: [{ page_number: 1, success: false, error: 'corrupt' }] } })]);
    await expect(make(m.fn).fetchResult('j')).rejects.toThrow(/could not read any page: corrupt/);
  });

  it('returns the raw sidecar text, the version it resolved to and the credits used', async () => {
    const job = { ...JSON.parse(jobJson), metadata: { version: '2026-01-08' }, usage: { credits_used: 6 } };
    const m = mockFetch([json(job), new Response(sidecar)]);
    const r = await make(m.fn).fetchWithRaw('job-123');
    if (r === 'pending') throw new Error('pending');
    expect(r.sidecar).toBe(sidecar);
    expect(r.document.version).toBe('2026-01-08');
    expect(r.creditsUsed).toBe(6);
  });

  it('leaves version and credits unknown when the job does not say', async () => {
    const m = mockFetch([json(JSON.parse(jobJson)), new Response(sidecar)]);
    const r = await make(m.fn).fetchWithRaw('job-123');
    if (r === 'pending') throw new Error('pending');
    expect(r.document.version).toBeUndefined();
    expect(r.creditsUsed).toBeUndefined();
  });

  it('repeats with items only when the account rejects the extra expand values', async () => {
    const m = mockFetch([json({ detail: 'invalid expand' }, 422), json({ job: { id: 'j', status: 'RUNNING' } })]);
    expect(await make(m.fn).fetchResult('j')).toBe('pending');
    expect(m.calls.map((c) => c.url.split('expand=')[1])).toEqual(['items,metadata,usage', 'items']);
  });

  it('reads credits from usage as a number or a credits field, and nothing else', () => {
    expect(creditsFromUsage(12)).toBe(12);
    expect(creditsFromUsage({ total_credits: 3, pages: 1 })).toBe(3);
    expect(creditsFromUsage({ pages: 1 })).toBeUndefined();
    expect(creditsFromUsage(undefined)).toBeUndefined();
  });
});

describe('offshore guard', () => {
  it('refuses to create the LlamaParse adapter for an unapproved organisation', () => {
    const m = mockFetch([]);
    expect(() => createLlamaParseParser({ apiKey: 'llx-test', offshoreAllowed: false, fetch: m.fn })).toThrow(OffshoreNotApproved);
    expect(m.calls).toHaveLength(0);
  });
});
