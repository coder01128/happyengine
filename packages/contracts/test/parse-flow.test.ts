import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { OffshoreNotApproved, ParserError, type ParsedDocument } from '../../documents/src/index.ts';
import {
  advanceParse, chooseParser, sha256Hex, validateContractsPreset,
  type AgreementRow, type AsyncParser, type FileRow, type ParseDeps, type ParseFetched, type ParseStore, type StoredPage,
} from '../src/index.ts';

const preset = validateContractsPreset(JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', '..', 'presets', 'contracts.default.json'), 'utf8')));
const enc = (s: string) => new TextEncoder().encode(s);

const doc = (pages: number, extra: Partial<ParsedDocument> = {}): ParsedDocument => ({
  parser: 'llamaparse',
  tier: 'cost_effective',
  pageCount: pages,
  pages: Array.from({ length: pages }, (_, i) => ({ page: i + 1, width: 595, height: 842, text: `Page ${i + 1}`, words: [{ text: 'Page', start: 0, end: 4, box: { x: 1, y: 2, w: 3, h: 4 } }] })),
  ...extra,
});

/** A database, a parser and file storage that live in memory. Records everything it is asked to do. */
function world(opts: { files: { filename: string; body: string; pages: number }[]; scanned?: boolean; results?: Record<string, ParseFetched | 'pending' | Error>; submitFails?: Error }) {
  const agreement: AgreementRow = { id: 'a1', org_id: 'o1', status: 'uploaded', scanned: opts.scanned ?? false, error: null };
  const files: FileRow[] = opts.files.map((f, i) => ({
    id: `f${i + 1}`, org_id: 'o1', agreement_id: 'a1', ord: i + 1, storage_path: `o1/a1/${f.filename}`, filename: f.filename,
    parse_job_id: null, parse_status: null, file_sha256: null,
  }));
  const bodies = new Map(opts.files.map((f) => [`o1/a1/${f.filename}`, f]));
  const log: string[] = [];
  const artifacts = new Map<string, string>();
  const stored: { fileId: string; pages: StoredPage[]; meta: object }[] = [];
  const submitted: { filename: string; tier: string }[] = [];
  const results = opts.results ?? {};

  const store: ParseStore = {
    async pinFile(fileId, sha) {
      const f = files.find((r) => r.id === fileId)!;
      if (f.file_sha256 && f.file_sha256 !== sha) throw new Error('db: file changed');
      f.file_sha256 ??= sha;
    },
    async claim(id) {
      log.push('claim');
      if (agreement.status !== 'uploaded') return { claimed: false, status: agreement.status };
      agreement.status = 'parsing';
      return { claimed: true, status: 'parsing' };
    },
    async recordSubmitted(fileId, _a, x) {
      log.push(`submitted ${fileId} ${x.tier} ${x.pages}p credits=${x.creditsEstimate}`);
      const f = files.find((r) => r.id === fileId)!;
      Object.assign(f, { parse_job_id: x.jobId, parse_status: 'parsing', file_sha256: f.file_sha256 ?? x.sha256 });
    },
    async storeParsedFile(fileId, _a, pages, meta) {
      log.push(`stored ${fileId}`);
      stored.push({ fileId, pages, meta });
      files.find((r) => r.id === fileId)!.parse_status = 'parsed';
      if (files.every((f) => f.parse_status === 'parsed')) agreement.status = 'parsed';
      return { stored: true, status: agreement.status };
    },
    async fail(_id, _a, error) { log.push(`fail: ${error}`); agreement.status = 'failed'; agreement.error = error; },
    async retry() {
      log.push('retry');
      agreement.status = 'uploaded';
      agreement.error = null;
      for (const f of files) Object.assign(f, { parse_job_id: null, parse_status: null }); // sha256 is kept
    },
    async status() { return agreement.status; },
  };

  const parser: AsyncParser = {
    name: 'llamaparse',
    async submit(_bytes, o) {
      if (opts.submitFails) throw opts.submitFails;
      submitted.push({ filename: o.filename, tier: o.tier });
      return `job-${o.filename}`;
    },
    async fetch(jobId) {
      const r = results[jobId.replace('job-', '')] ?? { document: doc(2) };
      if (r instanceof Error) throw r;
      return r;
    },
  };

  const deps: ParseDeps = {
    store, parser,
    async download(path) { return enc(bodies.get(path)!.body); },
    async putArtifact(path, text) { artifacts.set(path, text); },
    async countPages(bytes) { return [...bodies.values()].find((f) => f.body === new TextDecoder().decode(bytes))!.pages; },
    sha256: sha256Hex,
  };
  const step = (retry = false) => advanceParse(deps, { agreement: { ...agreement }, files: files.map((f) => ({ ...f })), preset, actor: 'u1', retry });
  return { agreement, files, log, artifacts, stored, submitted, step, deps };
}

describe('contracts parse flow', () => {
  it('sends every file once, tier from the preset, then stores the pages and moves to parsed', async () => {
    const w = world({ files: [{ filename: 'lease.pdf', body: 'L', pages: 5 }, { filename: 'addendum.pdf', body: 'A', pages: 2 }] });
    expect(await w.step()).toEqual({ status: 'parsing' });
    expect(w.submitted).toEqual([{ filename: 'lease.pdf', tier: 'cost_effective' }, { filename: 'addendum.pdf', tier: 'cost_effective' }]);
    expect(w.log).toEqual(['claim', 'submitted f1 cost_effective 5p credits=15', 'submitted f2 cost_effective 2p credits=6']);

    expect(await w.step()).toEqual({ status: 'parsed' });
    expect(w.stored.map((s) => s.fileId)).toEqual(['f1', 'f2']);
    expect(w.stored[0]!.pages[0]).toMatchObject({ page: 1, width: 595, height: 842, text: 'Page 1', positions_ok: true, positions_error: null });
  });

  it('uses the scanned tier for a scanned agreement', async () => {
    const w = world({ files: [{ filename: 'scan.pdf', body: 'S', pages: 1 }], scanned: true });
    await w.step();
    expect(w.submitted[0]!.tier).toBe('agentic');
    expect(w.log[1]).toContain('credits=10');
  });

  it('does not send anything twice when two callers overlap', async () => {
    const w = world({ files: [{ filename: 'a.pdf', body: 'A', pages: 1 }] });
    const first = await w.step();
    const second = await advanceParse(w.deps, { agreement: { ...w.agreement, status: 'uploaded' }, files: w.files, preset, actor: 'u2' }); // read the row before the first claimed it
    expect(first.status).toBe('parsing');
    expect(second).toEqual({ status: 'parsing' }); // claim refused
    expect(w.submitted).toHaveLength(1);
  });

  it('stays parsing while a job is pending, and stores the finished files as they arrive', async () => {
    const w = world({ files: [{ filename: 'a.pdf', body: 'A', pages: 1 }, { filename: 'b.pdf', body: 'B', pages: 1 }], results: { 'b.pdf': 'pending' } });
    await w.step();
    expect(await w.step()).toEqual({ status: 'parsing' });
    expect(w.stored.map((s) => s.fileId)).toEqual(['f1']);
    w.stored.length = 0;
    w.files[0]!.parse_status = 'parsed';
    w.deps.parser.fetch = async () => ({ document: doc(1) });
    expect(await w.step()).toEqual({ status: 'parsed' });
    expect(w.stored.map((s) => s.fileId)).toEqual(['f2']); // the parsed file is not stored again
  });

  it('keeps the raw sidecar out of the client-writable bucket path, version and credits with the pages', async () => {
    const w = world({ files: [{ filename: 'a.pdf', body: 'A', pages: 1 }], results: { 'a.pdf': { document: doc(1, { version: '2026-01-08' }), sidecar: '{"page_number":1}\n', creditsUsed: 3 } } });
    await w.step();
    await w.step();
    expect(w.artifacts.get('o1/a1/f1/grounding.jsonl')).toBe('{"page_number":1}\n');
    expect(w.stored[0]!.meta).toEqual({ version: '2026-01-08', credits: 3, sidecarPath: 'o1/a1/f1/grounding.jsonl' });
  });

  it('stores an unreadable page flagged, with its reason', async () => {
    const d = doc(2);
    d.pages[1] = { page: 2, width: 595, height: 842, text: '', words: [], positionsOk: false, positionsError: 'render failed' };
    const w = world({ files: [{ filename: 'a.pdf', body: 'A', pages: 2 }], results: { 'a.pdf': { document: d } } });
    await w.step();
    await w.step();
    expect(w.stored[0]!.pages[1]).toMatchObject({ page: 2, positions_ok: false, positions_error: 'render failed', words: [] });
  });

  it('refuses an agreement over the page limit before sending or claiming anything', async () => {
    const w = world({ files: [{ filename: 'big.pdf', body: 'B', pages: 61 }] });
    expect(await w.step()).toEqual({ status: 'failed', error: 'This agreement has 61 pages. The limit is 60.' });
    expect(w.submitted).toHaveLength(0);
    expect(w.log).toEqual(['fail: This agreement has 61 pages. The limit is 60.']);
  });

  it('fails with the parser\'s plain message, and a retry starts again from the same files', async () => {
    const w = world({ files: [{ filename: 'a.pdf', body: 'A', pages: 1 }], submitFails: new ParserError('credits', 'LlamaParse credits are used up. Top up the LlamaCloud account, then try again.') });
    expect(await w.step()).toEqual({ status: 'failed', error: 'LlamaParse credits are used up. Top up the LlamaCloud account, then try again.' });
    expect(await w.step()).toEqual({ status: 'failed', error: 'LlamaParse credits are used up. Top up the LlamaCloud account, then try again.' }); // no retry asked
    expect(await w.step(true)).toEqual({ status: 'uploaded' });
    expect(w.agreement.status).toBe('uploaded');
  });

  it('fails when the parser reports a failed job', async () => {
    const w = world({ files: [{ filename: 'a.pdf', body: 'A', pages: 1 }], results: { 'a.pdf': new ParserError('failed', 'LlamaParse job j failed: corrupt file') } });
    await w.step();
    expect(await w.step()).toEqual({ status: 'failed', error: 'LlamaParse job j failed: corrupt file' });
  });

  it('will not read an original whose fingerprint no longer matches the first one', async () => {
    const w = world({ files: [{ filename: 'a.pdf', body: 'A', pages: 1 }] });
    w.files[0]!.file_sha256 = 'f'.repeat(64);
    expect(await w.step()).toEqual({ status: 'failed', error: '"a.pdf" is not the file that was first uploaded, so it was not read.' });
    expect(w.submitted).toHaveLength(0);
  });

  it('records each file\'s fingerprint on first submit', async () => {
    const w = world({ files: [{ filename: 'a.pdf', body: 'A', pages: 1 }] });
    await w.step();
    expect(w.files[0]!.file_sha256).toBe(await sha256Hex(enc('A')));
    expect(w.files[0]!.file_sha256).toHaveLength(64);
  });

  it('pins the fingerprint on the first read even when the agreement is then refused', async () => {
    const w = world({ files: [{ filename: 'big.pdf', body: 'B', pages: 61 }] });
    await w.step();
    expect(w.files[0]!.file_sha256).toBe(await sha256Hex(enc('B')));
  });

  it('rethrows an unexpected error without marking the agreement failed', async () => {
    const w = world({ files: [{ filename: 'a.pdf', body: 'A', pages: 1 }], submitFails: new Error('connection reset') });
    await expect(w.step()).rejects.toThrow('connection reset');
    expect(w.agreement.status).toBe('parsing'); // claimed, and a retry call can still see it
    expect(w.log.some((l) => l.startsWith('fail'))).toBe(false);
  });

  it('does nothing for an agreement that is past parsing', async () => {
    const w = world({ files: [{ filename: 'a.pdf', body: 'A', pages: 1 }] });
    w.agreement.status = 'flagged';
    expect(await w.step()).toEqual({ status: 'flagged' });
    expect(w.log).toEqual([]);
  });
});

describe('chooseParser', () => {
  const ctx = (offshoreAllowed: boolean, fixtures: Record<string, string> = {}) => ({ offshoreAllowed, readFixture: async (f: string) => fixtures[f] ?? null });

  it('defaults to the fixture parser, which needs no approval and replays the saved parse', async () => {
    const saved = doc(1, { parser: 'fixture' });
    const p = chooseParser({}, ctx(false, { 'a.pdf': JSON.stringify(saved) }));
    expect(p.name).toBe('fixture');
    const job = await p.submit(new Uint8Array(1), { tier: 'cost_effective', filename: 'a.pdf' });
    expect(job).toBe('fixture:a.pdf');
    expect(await p.fetch(job)).toEqual({ document: saved });
  });

  it('says so when there is no saved parse for a file', async () => {
    const p = chooseParser({ PARSER: 'fixture' }, ctx(true));
    await expect(p.submit(new Uint8Array(1), { tier: 'cost_effective', filename: 'x.pdf' })).rejects.toThrow('No recorded parse for x.pdf');
  });

  it('refuses LlamaParse for an organisation that is not approved for offshore processing', () => {
    expect(() => chooseParser({ PARSER: 'llamaparse', LLAMA_CLOUD_API_KEY: 'llx-key' }, ctx(false))).toThrow(OffshoreNotApproved);
  });

  it('gives LlamaParse to an approved organisation, and needs its key', () => {
    expect(chooseParser({ PARSER: 'llamaparse', LLAMA_CLOUD_API_KEY: 'llx-key' }, ctx(true)).name).toBe('llamaparse');
    expect(() => chooseParser({ PARSER: 'llamaparse' }, ctx(true))).toThrow(/LLAMA_CLOUD_API_KEY is empty/);
  });

  it('does not offer PDF.js or an unknown parser in an edge function', () => {
    expect(() => chooseParser({ PARSER: 'pdfjs' }, ctx(true))).toThrow(/not available here/);
  });
});
