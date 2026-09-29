# Brief 04: `packages/documents` — parsers, extractor, quote check

**Repo:** `happyengine` · **Branch:** `contracts/documents` · **Requires:** briefs 01–03 merged

Read `CLAUDE.md`, `docs/contracts-plan.md` and the **Parser layer** and **Hard part 1** sections of `docs/engine-architecture.md` first.

## Goal

Build a service-neutral package (`@happy/documents`) that Contracts uses first and Onboarding and Invoicing reuse later:

1. **Parser adapters** turn a PDF into pages of text with word boxes, all in one common shape.
2. An **extractor adapter** asks Claude for values, each with an exact quote and a page number.
3. A **quote check** (grounding) finds each quote on its page and returns its boxes, or marks the value "not verified".

Nothing in this package knows about contracts. The schema and instructions are passed in by the service package.

## Out of scope

- The contracts schema, prompt and rules (brief 05). Edge functions (brief 06). UI (brief 07).
- LlamaExtract. We don't use it (see `docs/engine-architecture.md`).

## Common shapes (`src/types.ts`)

```ts
/** Box in the page's own units, top-left origin. Viewers scale by (x / page.width) × rendered width,
 *  so the unit (points or pixels) never matters as long as box and page use the same one. */
export interface Box { x: number; y: number; w: number; h: number }
export interface Word { text: string; start: number; end: number; box: Box }   // start/end: offsets into page.text
export interface ParsedPage { page: number; width: number; height: number; text: string; words: Word[] }
export interface ParsedDocument { parser: 'fixture' | 'pdfjs' | 'llamaparse'; tier?: string; pageCount: number; pages: ParsedPage[]; creditsEstimate?: number }

export interface Parser { parse(file: Uint8Array, opts: { tier?: string; filename: string }): Promise<ParsedDocument> }
```

## Part 1: parser adapters (`src/parsers/`)

**`fixture`.** Reads a saved `ParsedDocument` JSON. Used by unit tests and the smoke test. No network.

**`pdfjs` (local, digital PDFs only).**
- Use `pdfjs-dist` (the legacy build for Node). Build `text` from `getTextContent()` items in reading order, and split items into words.
- Where an item holds several words, estimate each word's box by its share of the item's width. Say so in a code comment.
- Convert PDF.js coordinates (bottom-left origin, transform matrix) to top-left. Width and height come from the page viewport at scale 1 (points).
- If a page has fewer than 20 characters of text, the parse fails with `ParserError('no_text_layer')`. That's the signal a file is a scan and needs LlamaParse.
- Add a comment that this is for development and digital PDFs, not a production OCR parser.
- **Check whether `pdfjs-dist` runs in the Supabase edge runtime (Deno)**, and report the answer. If it doesn't, it's Node-only (eval and tests), and edge functions use `fixture` or `llamaparse`.

**`llamaparse` (cloud, EU).** Read the current docs before coding, because the v2 API changed field names:
- API reference: https://developers.llamaindex.ai/llamaparse/parse/guides/api-reference/
- Word boxes: https://developers.llamaindex.ai/llamaparse/parse/examples/parse_granular_bboxes/
- v1 → v2 migration: https://developers.llamaindex.ai/llamaparse/parse/guides/migration-v1-to-v2/
- Regions: https://developers.llamaindex.ai/llamaparse/general/regions/

What was checked on 29 Sep 2026 (confirm each point against the docs, and write a unit test around the response mapping):
- **Base URL** from env `LLAMA_CLOUD_BASE_URL`, default `https://api.cloud.eu.llamaindex.ai`. Never default to the North America URL.
- **Auth:** `Authorization: Bearer ${LLAMA_CLOUD_API_KEY}`.
- **Endpoints:** upload with `POST /api/v2/parse/upload`. Poll `GET /api/v2/parse/{job_id}`; the status is under `job.status` when polling (at the top level in the create response).
- **Required:** `tier` (`cost_effective` / `agentic` / `agentic_plus`; `fast` does **not** support word boxes) and `version: "latest"`.
- **Caching:** `disable_cache: true` (replaces v1's `do_not_cache`). Confirm where it goes in the body.
- **Word boxes:** `output_options: { granular_bboxes: ["word", "line"] }` (nested, not top level).
- **Result:** items with `md`, and a `grounding` object: `lines[].span` and `lines[].words[].span` are `[start, end)` character ranges into the item's `md`, each with `bbox {x, y, w, h}` (top-left origin). Page rows carry `page_width` and `page_height`.

Mapping to `ParsedPage`:
- Join a page's item `md` values with `\n\n` into `page.text`.
- Shift each word's span by the item's offset.
- Use `page_width` and `page_height` as `width` and `height`.
- Keep the markdown as-is. The matcher (Part 3) handles markdown characters.

Also:
- **Two-step flow for edge functions.** Split into `submit(file) → jobId` and `fetchResult(jobId) → ParsedDocument | 'pending'`, because edge functions can't wait for long jobs (brief 06).
- **Credits estimate** on the result: `pageCount × credits per page` from a small table in code (cost_effective 3, agentic 10, agentic_plus 45). A comment says the prices were checked 29 Sep 2026 and must be re-checked.
- **Errors:** 401 → "LlamaParse key missing or wrong"; 402 or credits exhausted → a clear message. Don't retry more than twice.

## Part 2: extractor adapters (`src/extract/`)

```ts
export interface ExtractRequest {
  instructions: string;                 // service-specific (brief 05)
  schema: object;                       // JSON Schema for the tool input
  pages: { file: string; page: number; text: string }[];
}
export interface Extractor { extract(req: ExtractRequest): Promise<{ output: unknown; model: string; usage: { input: number; output: number } }> }
```

**`fixture`.** Returns a saved output. Used by tests and the smoke test.

**`claude`.**
- **Call.** Use plain `fetch` to `https://api.anthropic.com/v1/messages` (no SDK, so the same code runs in Node and Deno). Headers: `x-api-key: ${ANTHROPIC_API_KEY}` and `anthropic-version: 2023-06-01`.
- **Model and temperature.** The model comes from env `ANTHROPIC_MODEL` and is required. Don't hard-code a model name. Temperature 0.
- **Structured output.** Force one tool call (`tool_choice: { type: "tool", name: "record_extraction" }`) whose `input_schema` is `req.schema`. The tool input is the output.
- **Page text.** Wrap each page as `<page file="c1-lease.pdf" n="2">…</page>`. Tell Claude that quotes must be copied character for character from inside a page tag.
- **Errors.** Retry once on 429 or 529 with backoff. On a malformed tool input, fail with the raw response saved for debugging. Never "repair" output by guessing.

## Part 3: the quote check (`src/grounding.ts`)

```ts
export interface GroundingResult { status: 'grounded' | 'not_found'; score: number; page: number; start?: number; end?: number; boxes: Box[] }
export function ground(quote: string, page: ParsedPage, minScore: number): GroundingResult
```

**Normalise** both the quote and the page text, keeping an offset map back to the original page text:
- lowercase
- collapse whitespace, including line breaks
- straight and curly quotes to `'` or `"`
- en and em dashes to `-`
- ligatures (ﬁ ﬂ) expanded
- soft hyphens and line-end hyphenation removed
- markdown emphasis and table pipes (`**`, `__` used as emphasis, `|`, leading `#`) removed
- runs of 3 or more `_` or `.` become one blank token `⎵`. This is how a blank in a signed copy is detected (C5).

**Match:**
1. An exact normalised match first. If it occurs more than once on the page, take the first and set `score` to 0.99 so it's visible.
2. Otherwise a fuzzy match: slide a window over the page tokens and score it with token-level similarity (Levenshtein ratio). Accept at or above `minScore`.
3. Below `minScore`, the result is `not_found`. **No fallback to another page.** A quote that isn't on its page is a finding.

**Boxes:** take the words overlapping `[start, end)`. Merge them into one box per visual line (words on the same line within half a line-height), so a highlight looks like a highlighter, not a word cloud.

**Tests (at least):**
- exact match
- a curly-quote difference
- a line-break hyphenation (`termi-\nnation`)
- a markdown table cell
- a blank run of underscores
- a quote on the wrong page (not_found)
- a near-miss below threshold
- a quote spanning two lines, which gives two boxes

## Part 4: recording and env

- `scripts/parse-file.ts <pdf> --parser pdfjs|llamaparse [--tier agentic]` prints a summary (pages, words, credits estimate) and writes the `ParsedDocument` JSON beside the eval sample under `parsed/<parser>-<tier>/`.
- **Env loading.** Node scripts load `supabase/functions/.env` with `process.loadEnvFile`, so there's one secrets file. It is git-ignored; confirm with `git check-ignore`. Add `supabase/functions/.env.example` listing the variable names with empty values:
  - `LLAMA_CLOUD_API_KEY=`
  - `LLAMA_CLOUD_BASE_URL=https://api.cloud.eu.llamaindex.ai`
  - `ANTHROPIC_API_KEY=`
  - `ANTHROPIC_MODEL=`
- **Offshore guard.** The live adapters (`llamaparse`, `claude`) take a required `offshoreAllowed: boolean` argument and throw `OffshoreNotApproved` when it's false. Callers pass the organisation's flag (brief 06) or the eval sample's `synthetic: true` (brief 05). Test it.

## Acceptance checks

- [ ] `npm test` passes, with the new parser-mapping, grounding and guard tests.
- [ ] `npm run typecheck` prints nothing.
- [ ] `pdfjs` parses all 6 files in `eval/contracts/demo-marula/`. For every `data-field` box in `boxes.json`, some parsed words fall inside it. Print the count per file.
- [ ] `pdfjs` on `scan-marula/` fails with `no_text_layer`.
- [ ] Grounding: for each `data-field` element's own text (taken from the demo fixture), `ground()` on the pdfjs parse finds it, and the returned boxes overlap `boxes.json` with IoU ≥ 0.5. Print the pass counts as plain numbers (grounded N/N, IoU ≥ 0.5 N/N).
- [ ] The `llamaparse` adapter is unit-tested against a saved sample response. **Don't call the live API in tests.** If `LLAMA_CLOUD_API_KEY` is set, `scripts/parse-file.ts … --parser llamaparse` works on one demo PDF. Otherwise, say it wasn't run.
- [ ] Month-End tests and eval unchanged.
- [ ] One commit: "Add documents package: parser adapters, Claude extractor, grounding".

## Report back with

- Whether `pdfjs-dist` runs in the edge runtime.
- The grounding pass counts.
- Any LlamaParse field names that differed from this brief.
