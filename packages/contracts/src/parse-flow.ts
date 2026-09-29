// The parse half of contracts-process: advances one agreement one step per call.
//
//   uploaded ── read the originals, check size, claim, send each file to the parser ──▶ parsing
//   parsing  ── ask for each file's result; store pages, positions and the raw sidecar ──▶ parsed
//   failed + retry ──▶ uploaded
//
// No database or network code here: the edge function passes in a store, a parser and file access, so the
// state machine is tested without either. Extraction (parsed → extracting → ready/flagged) is a later step.

import { CREDITS_PER_PAGE, OffshoreNotApproved, ParserError, type ParsedPage } from '../../documents/src/index.ts';
import type { AsyncParser } from './adapters.ts';
import type { ContractsPreset } from './preset.ts';

/** A problem with this agreement's files or limits, with a message fit to show to the person who uploaded it. */
export class ParseProblem extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ParseProblem';
  }
}

export interface AgreementRow { id: string; org_id: string; status: string; scanned: boolean; error: string | null }
export interface FileRow {
  id: string;
  org_id: string;
  agreement_id: string;
  ord: number;
  storage_path: string;
  filename: string;
  parse_job_id: string | null;
  parse_status: string | null;
  file_sha256: string | null;
}

/** A page as stored in parsed_pages. Word boxes are PDF points. */
export interface StoredPage {
  page: number;
  width: number;
  height: number;
  text: string;
  words: ParsedPage['words'];
  positions_ok: boolean;
  positions_error: string | null;
}

/** Every step is one database function that changes state and logs its timeline event together. */
export interface ParseStore {
  /** Pins the fingerprint of an original the first time the server reads it; refuses a later read that doesn't match. */
  pinFile(fileId: string, sha256: string): Promise<void>;
  claim(agreementId: string, actor: string, preset: ContractsPreset): Promise<{ claimed: boolean; status: string }>;
  recordSubmitted(fileId: string, actor: string, x: { jobId: string; parser: string; tier: string; pages: number; sha256: string; creditsEstimate: number | null }): Promise<void>;
  storeParsedFile(fileId: string, actor: string, pages: StoredPage[], meta: { version?: string; credits?: number; sidecarPath?: string }): Promise<{ stored: boolean; status: string }>;
  fail(agreementId: string, actor: string, error: string): Promise<void>;
  retry(agreementId: string, actor: string): Promise<void>;
  status(agreementId: string): Promise<string>;
}

export interface ParseDeps {
  store: ParseStore;
  parser: AsyncParser;
  /** The uploaded original. */
  download(storagePath: string): Promise<Uint8Array>;
  /** Keeps the parser's raw output where clients can't touch it. */
  putArtifact(path: string, text: string): Promise<void>;
  countPages(bytes: Uint8Array): Promise<number>;
  sha256(bytes: Uint8Array): Promise<string>;
}

export interface ParseInput {
  agreement: AgreementRow;
  files: FileRow[];
  preset: ContractsPreset;
  actor: string;
  retry?: boolean;
}

export interface ParseOutcome { status: string; error?: string }

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const toStoredPage = (p: ParsedPage): StoredPage => ({
  page: p.page,
  width: p.width,
  height: p.height,
  text: p.text,
  words: p.words,
  positions_ok: p.positionsOk !== false,
  positions_error: p.positionsOk === false ? p.positionsError ?? 'no reason given' : null,
});

/** Problems that stop this agreement, with what to tell the person. Anything else is unexpected and is rethrown. */
function plainMessage(err: unknown): string | null {
  if (err instanceof ParseProblem || err instanceof ParserError || err instanceof OffshoreNotApproved) return err.message;
  return null;
}

export async function advanceParse(deps: ParseDeps, input: ParseInput): Promise<ParseOutcome> {
  const { agreement, actor } = input;

  if (agreement.status === 'failed') {
    if (!input.retry) return { status: 'failed', error: agreement.error ?? undefined };
    await deps.store.retry(agreement.id, actor);
    return { status: 'uploaded' };
  }
  if (agreement.status === 'uploaded') return submitAll(deps, input);
  if (agreement.status === 'parsing') return collect(deps, input);
  return { status: agreement.status };
}

async function stop(deps: ParseDeps, input: ParseInput, err: unknown): Promise<ParseOutcome> {
  const message = plainMessage(err);
  if (message === null) throw err;
  await deps.store.fail(input.agreement.id, input.actor, message);
  return { status: 'failed', error: message };
}

async function submitAll(deps: ParseDeps, input: ParseInput): Promise<ParseOutcome> {
  const { agreement, files, preset, actor } = input;
  const tier = agreement.scanned ? preset.parser.scannedTier : preset.parser.tier;

  // Read and check everything first, so an agreement that is refused is never left half-submitted.
  const read: { file: FileRow; bytes: Uint8Array; sha256: string; pages: number }[] = [];
  try {
    if (!files.length) throw new ParseProblem('No file is attached to this agreement.');
    let total = 0;
    for (const file of [...files].sort((a, b) => a.ord - b.ord)) {
      const bytes = await deps.download(file.storage_path);
      const sha256 = await deps.sha256(bytes);
      // The first read pins the file's fingerprint. A later read (a retry) of an original that no longer
      // matches it must not be used.
      if (file.file_sha256 && file.file_sha256 !== sha256) {
        throw new ParseProblem(`"${file.filename}" is not the file that was first uploaded, so it was not read.`);
      }
      await deps.store.pinFile(file.id, sha256);
      const pages = await deps.countPages(bytes);
      total += pages;
      read.push({ file, bytes, sha256, pages });
    }
    if (total > preset.parser.maxPagesPerAgreement) {
      throw new ParseProblem(`This agreement has ${total} pages. The limit is ${preset.parser.maxPagesPerAgreement}.`);
    }
  } catch (err) {
    return stop(deps, input, err);
  }

  // Only one caller gets to send the files.
  const claim = await deps.store.claim(agreement.id, actor, preset);
  if (!claim.claimed) return { status: claim.status };

  for (const { file, bytes, sha256, pages } of read) {
    try {
      const jobId = await deps.parser.submit(bytes, { tier, filename: file.filename });
      const perPage = CREDITS_PER_PAGE[tier];
      await deps.store.recordSubmitted(file.id, actor, {
        jobId,
        parser: deps.parser.name,
        tier,
        pages,
        sha256,
        creditsEstimate: deps.parser.name === 'llamaparse' && perPage ? pages * perPage : null,
      });
    } catch (err) {
      return stop(deps, input, err);
    }
  }
  return { status: 'parsing' };
}

async function collect(deps: ParseDeps, input: ParseInput): Promise<ParseOutcome> {
  const { agreement, files, actor } = input;
  for (const file of [...files].sort((a, b) => a.ord - b.ord)) {
    if (file.parse_status === 'parsed') continue;
    try {
      if (!file.parse_job_id) throw new ParseProblem(`"${file.filename}" was never sent to be read.`);
      const result = await deps.parser.fetch(file.parse_job_id);
      if (result === 'pending') continue;
      // The parser's raw output is kept first (its download link expires), then the pages.
      let sidecarPath: string | undefined;
      if (result.sidecar !== undefined) {
        sidecarPath = `${file.org_id}/${agreement.id}/${file.id}/grounding.jsonl`;
        await deps.putArtifact(sidecarPath, result.sidecar);
      }
      await deps.store.storeParsedFile(file.id, actor, result.document.pages.map(toStoredPage), {
        version: result.document.version,
        credits: result.creditsUsed,
        sidecarPath,
      });
    } catch (err) {
      return stop(deps, input, err);
    }
  }
  return { status: await deps.store.status(agreement.id) };
}
