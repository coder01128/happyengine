// Which parser the contracts-process edge function uses. Pure: the function reads its environment and the
// organisation's flag and passes them in, so the offshore gate can be tested without a network or a database.
//
// PARSER=fixture (default) replays a saved parse. PARSER=llamaparse sends the file to LlamaParse (EU) and is
// refused for an organisation that hasn't been approved for offshore processing. The local PDF.js parser is
// Node only and is not offered here.

import {
  createLlamaParseParser, ParserError,
  type ParsedDocument,
} from '../../documents/src/index.ts';

/** A finished parse: the document, the raw sidecar text to keep, and the credits the job reported. */
export interface ParseFetched { document: ParsedDocument; sidecar?: string; creditsUsed?: number }

/** Two steps, because an edge function can't wait for a long parse: send the file, then ask for the result. */
export interface AsyncParser {
  name: 'fixture' | 'llamaparse';
  submit(file: Uint8Array, opts: { tier: string; filename: string }): Promise<string>;
  fetch(jobId: string): Promise<ParseFetched | 'pending'>;
}

export interface ParserEnv { PARSER?: string; LLAMA_CLOUD_API_KEY?: string; LLAMA_CLOUD_BASE_URL?: string }

export interface ParserContext {
  /** The organisation's offshore_processing_approved flag. */
  offshoreAllowed: boolean;
  /** The preset's pinned parser version per tier (preset.parser.versions). */
  versions?: Record<string, string>;
  /** The saved parse for a file (JSON text of a ParsedDocument), or null when there isn't one. */
  readFixture(filename: string): Promise<string | null>;
  fetch?: typeof fetch;
}

export function chooseParser(env: ParserEnv, ctx: ParserContext): AsyncParser {
  const name = env.PARSER?.trim() || 'fixture';

  if (name === 'fixture') {
    return {
      name: 'fixture',
      async submit(_file, opts) {
        if ((await ctx.readFixture(opts.filename)) === null) throw new ParserError('failed', `No recorded parse for ${opts.filename}`);
        return `fixture:${opts.filename}`;
      },
      async fetch(jobId) {
        const filename = jobId.replace(/^fixture:/, '');
        const text = await ctx.readFixture(filename);
        if (text === null) throw new ParserError('failed', `No recorded parse for ${filename}`);
        return { document: JSON.parse(text) as ParsedDocument };
      },
    };
  }

  if (name === 'llamaparse') {
    // Throws OffshoreNotApproved for an unapproved organisation, before anything is sent.
    const llama = createLlamaParseParser({
      apiKey: env.LLAMA_CLOUD_API_KEY ?? '',
      baseUrl: env.LLAMA_CLOUD_BASE_URL || undefined,
      offshoreAllowed: ctx.offshoreAllowed,
      versions: ctx.versions,
      fetch: ctx.fetch,
    });
    return {
      name: 'llamaparse',
      submit: (file, opts) => llama.submit(file, opts),
      fetch: (jobId) => llama.fetchWithRaw(jobId),
    };
  }

  throw new ParserError('failed', `PARSER "${name}" is not available here. Use fixture or llamaparse.`);
}
