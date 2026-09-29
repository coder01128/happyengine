// Claude extractor: plain fetch to the Messages API (no SDK), so the same code runs in Node and Deno.
// Claude returns values with an exact quote and page; deterministic code (grounding, rules) decides the rest.
//
// Differences from the original brief, checked against the Claude API on 29 Sep 2026:
//   - Current models (Claude Opus 5.5, Claude Sonnet 5.5, Claude Fable 5.1) reject a forced tool_choice
//     ({type: "tool"}) with a 400. The tool is offered with tool_choice "auto", the instructions name it,
//     and a response without exactly one record_extraction call is an error. Nothing is guessed.
//   - The same models reject `temperature`. It is sent only when the caller sets one.

import { ExtractorError, requireOffshore } from '../errors.ts';
import type { ExtractRequest, ExtractResult, Extractor } from '../types.ts';

const API_URL = 'https://api.anthropic.com/v1/messages';
export const EXTRACTION_TOOL = 'record_extraction';

export interface ClaudeConfig {
  apiKey: string;
  /** From env ANTHROPIC_MODEL. Required; no default model. */
  model: string;
  /** The organisation's offshore_processing_approved flag (or an eval sample's synthetic: true). */
  offshoreAllowed: boolean;
  /** Only sent when set; current models reject it. */
  temperature?: number;
  maxTokens?: number;
  fetch?: typeof fetch;
  /** Backoff before the one retry on 429/529 when there's no retry-after header, in ms (tests set 0). */
  retryDelayMs?: number;
}

const QUOTE_RULE =
  `Call the ${EXTRACTION_TOOL} tool exactly once with everything you found. ` +
  'Every quote must be copied character for character from inside one <page> tag, and its page number and ' +
  'file must be that tag\'s n and file. Never paraphrase, correct or join text from different pages in a quote.';

/** Pages wrapped as <page file="c1-lease.pdf" n="2">…</page>. */
export function pagesMessage(pages: ExtractRequest['pages']): string {
  return pages.map((p) => `<page file="${p.file.replace(/"/g, '&quot;')}" n="${p.page}">\n${p.text}\n</page>`).join('\n\n');
}

export function createClaudeExtractor(cfg: ClaudeConfig): Extractor {
  requireOffshore(cfg.offshoreAllowed, 'Claude');
  if (!cfg.apiKey) throw new ExtractorError('Anthropic key missing (ANTHROPIC_API_KEY is empty)');
  if (!cfg.model) throw new ExtractorError('ANTHROPIC_MODEL is not set. Choose the model explicitly; there is no default.');
  const doFetch = cfg.fetch ?? fetch;

  return {
    async extract(req: ExtractRequest): Promise<ExtractResult> {
      const body = {
        model: cfg.model,
        max_tokens: cfg.maxTokens ?? 16000,
        ...(cfg.temperature === undefined ? {} : { temperature: cfg.temperature }),
        system: `${req.instructions}\n\n${QUOTE_RULE}`,
        tools: [
          {
            name: EXTRACTION_TOOL,
            description: 'Record every extracted value with its exact source quote, file and page.',
            input_schema: req.schema,
          },
        ],
        tool_choice: { type: 'auto' },
        messages: [{ role: 'user', content: pagesMessage(req.pages) }],
      };
      const init: RequestInit = {
        method: 'POST',
        headers: { 'x-api-key': cfg.apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify(body),
      };

      let res = await doFetch(API_URL, init);
      if (res.status === 429 || res.status === 529) {
        const after = Number(res.headers.get('retry-after'));
        await new Promise((r) => setTimeout(r, Number.isFinite(after) && after > 0 ? after * 1000 : cfg.retryDelayMs ?? 5000));
        res = await doFetch(API_URL, init);
      }
      const raw = await res.json().catch(() => null);
      if (!res.ok) {
        if (res.status === 401) throw new ExtractorError('Anthropic key missing or wrong', raw);
        throw new ExtractorError(`Claude API returned ${res.status}: ${JSON.stringify(raw?.error ?? raw).slice(0, 300)}`, raw);
      }

      if (raw?.stop_reason === 'refusal') throw new ExtractorError('Claude declined the request (stop_reason: refusal)', raw);
      if (raw?.stop_reason === 'max_tokens') throw new ExtractorError('Claude ran out of output tokens before finishing; the output is incomplete', raw);
      const calls = (raw?.content ?? []).filter((b: { type?: string; name?: string }) => b.type === 'tool_use' && b.name === EXTRACTION_TOOL);
      if (calls.length !== 1) throw new ExtractorError(`Expected one ${EXTRACTION_TOOL} call, got ${calls.length}`, raw);
      const output = calls[0].input;
      if (typeof output !== 'object' || output === null || Array.isArray(output)) {
        throw new ExtractorError(`${EXTRACTION_TOOL} input is not an object`, raw);
      }
      const required = (req.schema as { required?: string[] }).required ?? [];
      const missing = required.filter((k) => !(k in output));
      if (missing.length) throw new ExtractorError(`${EXTRACTION_TOOL} input is missing ${missing.join(', ')}`, raw);

      return {
        output,
        model: raw.model ?? cfg.model,
        usage: { input: raw.usage?.input_tokens ?? 0, output: raw.usage?.output_tokens ?? 0 },
      };
    },
  };
}
