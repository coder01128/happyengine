# Happy Contracts: source location and highlighting (handoff)

Save to: `C:\ccode\git-repos\happyengine\docs\contracts-source-highlight-handoff.md`
Status: spec, written 29 Sep 2026 without access to the repo. Phase 0 (discovery) confirms or corrects every assumption below before any code is written.

---

## 1. Goal

Every extracted contract value (term, fee, notice period, renewal) links to the exact place in the original PDF or scan it came from. Clicking a citation chip (e.g. `p.1 · cl. 2.1.7`) opens the page and highlights the words. **No value is shown without a source.** If the source can't be found, the value goes to review.

This is the engine's "source viewer" and "grounding check". Build it as **engine code** so Month-End, Onboarding and Invoicing get it for free. Only the extraction schema and labels are Contracts-specific.

## 2. Decisions already made

| Decision | Detail |
|---|---|
| Parser v1 | LlamaParse (cloud API) for **all** documents, digital and scanned. One code path. |
| Parser tier | **Minimum `cost_effective`.** The `fast` tier has no item-level layout, so it returns **no** word boxes. Scans/photos → `agentic`. Tier set per document type in the preset. |
| Word boxes | `output_options.granular_bboxes: ["word", "line"]` |
| Region / privacy | EU endpoint. Caching off. Only fictional sample documents go through LlamaParse until the POPIA template pack is signed off. |
| Extraction | Claude, not LlamaExtract. Parser stays swappable. |
| Viewer | PDF.js plus our own overlay. No `react-pdf-highlighter`. |
| Coordinate storage | Fractions of the page (0–1), converted **once** at ingest. The viewer only ever sets CSS percentages. |
| Later, not now | PDF.js text-layer parser for digital PDFs (free, in-browser). Same parser interface, no downstream change. |

## 3. How LlamaParse returns positions (verified from docs, 29 Sep 2026)

Source: https://developers.llamaindex.ai/llamaparse/parse/examples/parse_granular_bboxes/

- Word boxes are **not** in the main response. They come in a separate **JSONL sidecar**. The result has `result_content_metadata.grounded_items.presigned_url`.
- **The presigned URL is temporary.** Download it immediately and store it ourselves.
- The JSONL has one line per page, with either `{ page_number, page_width, page_height, success: true, items: [...] }` or `{ page_number, success: false, error }`. Always check `success`.
- In text items, `item.grounding.lines[].words[]` each have `span: [start, end)` (a character range into `item.md`) and `bbox: { x, y, w, h, r? }`. The word text is `item.md.slice(start, end)`.
- Units are PDF points. The docs' examples put the origin at the **top-left**, but that must be confirmed by the coordinate test (Phase 1).
- `page_width` / `page_height` already include PDF `/Rotate`. `r` rotates a box clockwise around its centre. Never add the page orientation angle to `r`.
- Table items use `grounding.rows[r][c].bbox[]`. These aren't needed for v1 Contracts, but store them; Month-End and Invoicing will need cell boxes.

**Unverified. Phase 0 must check each one against the docs:**
1. The exact REST endpoints and auth for upload, create job, get job and delete file (prefer plain `fetch` over the SDK inside Supabase Edge Functions, i.e. Deno).
2. The EU base URL for the v2 API, and whether an API key created on the US site works there.
3. What the "don't cache / don't retain" option is called in v2 (the v1 name was `do_not_cache`).
4. Whether webhooks exist for parse jobs, and how their authenticity is verified.
5. Whether granular boxes cost extra credits on top of the tier price.
6. Whether a parse `version` can be pinned instead of `latest`.
7. Whether files can be deleted from LlamaParse after parsing.

## 4. Data model (additive; match the existing naming and RLS pattern)

`setup-database.sql` (or the repo's migration file) is the single source of truth. Every new table has `org_id` and row-level security copied from the existing tables.

```
documents (existing, add columns)
  parse_status   text   -- queued | parsing | parsed | failed
  parser         text   -- 'llamaparse'
  parser_tier    text
  parser_job_id  text
  page_count     int
  parsed_at      timestamptz

document_pages
  id, org_id, document_id, page_number
  width_pt, height_pt           -- from sidecar
  positions_ok   boolean        -- sidecar success flag
  positions_error text
  words  jsonb   -- [{ t, x, y, w, h, r, line }]  x/y/w/h as 0–1 fractions
  text   text    -- page text rebuilt from `words` (see 5.2), what Claude sees

field_evidence
  id, org_id, document_id, field_ref   -- field_ref links to the extracted field row
  role          text   -- primary | supporting | superseded
  page_number   int    -- page where the match was found
  claimed_page  int    -- page Claude said
  quote         text   -- Claude's verbatim quote
  label         text   -- e.g. 'cl. 2.1.7' or 'Sch. 2' (null if it failed its check)
  match_status  text   -- exact | fuzzy | not_found | ambiguous
  match_score   numeric
  boxes         jsonb  -- [{ x, y, w, h }] fractions, one rectangle per line
```

Also store the raw sidecar JSONL in a **private** storage bucket (`{org_id}/{document_id}/grounding.jsonl`), so documents can be re-grounded without paying to re-parse. Same retention and deletion rules as the original document.

## 5. Pipeline

### 5.1 Parse (async, never blocking)
1. Upload lands in storage and creates a `documents` row with status `queued`.
2. Edge function `parse-start`: sends the file to LlamaParse (EU, tier from preset, granular boxes on, caching off), saves `parser_job_id`, sets status `parsing`, and logs to the timeline.
3. Completion is detected by a webhook if one exists. The webhook payload is **only a trigger**: we then fetch the job by ID with our own key and never trust the payload's contents. There's also a fallback status check the UI can call. If the repo already has a job pattern (e.g. Month-End), **replicate it** instead.
4. Edge function `parse-complete`:
   - fetches the result, downloads the sidecar immediately and stores the raw JSONL
   - normalises each page and writes `document_pages` (5.2)
   - deletes the file from LlamaParse if the API allows
   - sets status `parsed`, logs to the timeline, then triggers extraction
5. A page with `success: false` is stored with `positions_ok = false`. Any evidence on that page becomes `not_found` with the reason "page could not be read for positions".

### 5.2 Normalise (once, at ingest)
- For each word: `x / page_width`, `y / page_height`, `w / page_width`, `h / page_height`. Keep `r`.
- Build the page `text` from the words in the parser's reading order: words joined by spaces, lines by `\n`, items by `\n\n`.
- **Claude receives this rebuilt text, not the markdown** (`item.md` contains `**`, `#`, table pipes). Because Claude quotes from exactly the text we match against, exact matches become the normal case.

### 5.3 Extract (modify the existing Contracts extraction)
Claude receives the page texts marked `=== PAGE n ===`. For every field it returns:

```json
{
  "value": "2027-01-31",
  "evidence": [
    { "page": 1, "quote": "“Lease Period” means the period commencing on the Commencement Date and ending on 31 January 2027", "label": "cl. 2.1.7", "role": "primary" }
  ]
}
```

Prompt rules:
- Quotes are copied **verbatim** as one continuous passage, with no ellipses and no paraphrase.
- Use the shortest passage that supports the value, but at least about 8 words, so it's unique on the page (include the defined term or clause heading).
- Give one evidence entry per separate passage.
- Where an addendum overrides a clause, the addendum is `primary` and the original clause is `superseded`.

Derived values (e.g. the notice deadline = expiry − 3 months) are computed by deterministic code in the rules runner. They have no quote of their own; they show the evidence of their inputs.

### 5.4 Ground (deterministic; a pure function in a shared module)
Write this as a dependency-free ES module (`shared/grounding.js` or the repo's equivalent) so the Edge Function and the Node eval script import the same code.

1. **Normalise** the quote and the page text identically:
   - NFKC, lowercase
   - curly quotes → straight; en/em dashes → `-`; non-breaking space → space
   - remove soft hyphens; collapse whitespace
   - rejoin words hyphenated at a line break ("in-\ncluding" → "including")
   - keep a map from each normalised character back to its word index
2. **Exact search** on the claimed page, then on pages ±1, then the whole document. If it's found on another page, record the actual `page_number` and keep `claimed_page` for audit.
3. **Fuzzy search** if there's no exact match: slide a window of word tokens (quote length ±20%) and score by token alignment that **tolerates a few inserted tokens**. Watermark words like "SAMPLE", "COPY" or "DRAFT" get read in the middle of sentences on real documents. Take the preset's `ignoreTokens` list into account.
   - Starting threshold: score ≥ 0.90 → `fuzzy`; below → `not_found`.
   - **These thresholds are guesses** until the eval set tunes them.
4. **More than one match** on the same page → `ambiguous` → review. Don't guess.
5. **Value-in-quote check** by field type:
   - money: the amount parsed from the quote equals the value in integer cents
   - date: a date parsed from the quote equals the value (formats like "31 January 2027", "31/01/2027", "1 Feb 2024")
   - integer and period: the number appears in the quote ("3 calendar months", "three (3) months")
   - text: skip

   If the check fails → review with the reason "value not found in cited text". This catches a real quote attached to a wrong value.
6. **Label check:** the clause number in `label` (e.g. `2.1.7`, `18.2`) must appear as a token on the matched page. If it doesn't, drop the label and show just `p.n`. Never display an unchecked AI label.
7. **Boxes:** group the matched words by `line`, merge each line into one rectangle, and store the list.
8. **Field status:** "Source found" only if at least one `primary` evidence is `exact` or `fuzzy` **and** the value-in-quote check passes. Otherwise it goes to the review queue with a one-line reason.

   Wording rule: never "verified". Use "Source found", "Source not found — review", "Flagged for review".

### 5.5 Timeline
Log parse started, completed or failed (with page count and tier), and a grounding summary per document ("14 fields: 12 source found, 2 flagged").

## 6. Source viewer

- Load the original from storage using a short-lived signed URL.
- **PDF:** use `pdfjs-dist` at a pinned version, with the worker configured.
  - One container per page, its aspect ratio set from `width_pt / height_pt` **before** rendering so scroll positions stay stable.
  - Lazy-render pages near the viewport (IntersectionObserver).
  - A clicked chip renders its target page first.
- **Image upload:** an `<img>` in the same container.
- **Overlay:** `position:absolute; inset:0` over each page.
  - Each box is a div with `left/top/width/height` set as percentages straight from the stored fractions.
  - For a clause-style highlight (as in the current demo), draw one padded rectangle around all of the line boxes, with the label tag above it.
- **Chip click:** scroll the page into view, draw the highlight, play a short pulse, and move focus to the highlight region for screen readers.
- **Rotation:** PDF.js applies `/Rotate`. If any box has non-zero `r`, draw it rotated around its centre (CSS `transform: rotate(rdeg)`). The coordinate test must cover this.
- **Chip states:**
  - "Source found": clickable chip.
  - "Source not found — review": text label, opens the claimed page with no highlight.
  - Superseded evidence: labelled "superseded" in text, not only by colour.
- **Brad's UI rules:**
  - text contrast at least 4.5:1, font size at least 13px (chips and labels included)
  - visible hover and focus on every chip
  - centred modals only
  - works at 360px width with no horizontal scroll
- Reuse the existing demo's chip, label and highlight styling, but replace its HTML "paper" with the real rendered page.

## 7. Tests (Brad does not debug by hand, so these are how anyone knows it works)

1. **Coordinate test (Phase 1, before any extraction work).**
   - Generate `eval/fixtures/coords.pdf` with `pdf-lib`, with known text at known positions on:
     - a portrait page
     - a landscape page
     - a page with `/Rotate 90`
     - a page that's just an embedded image of text (simulated scan)
   - Parse it through LlamaParse and compare each known word's stored fraction with the expected fraction.
   - Pass = every word within 1% of page size.
   - Also build `dev/highlight-test.html`, which renders the PDF with boxes drawn, as a visual check for Brad.
2. **Matcher unit tests** (pure function, no network). Cases:
   - exact match
   - curly quotes versus straight
   - hyphenation at a line break
   - watermark word inserted mid-quote
   - quote split across two pages
   - quote on the wrong claimed page
   - repeated quote (→ ambiguous)
   - paraphrased quote (→ not_found)
   - value mismatch (→ review)
   - label not on page (→ label dropped)
3. **Contracts eval** (`eval/contracts/`).
   - Fictional sample contracts, each with an `expected.json` of field values, the page, and the expected quote.
   - Include at least:
     - one clean digital PDF
     - one with a SAMPLE watermark
     - one printed and re-scanned or photographed
     - one with an addendum that supersedes a clause
   - Real contracts are added when the pilot client supplies them.
   - One command runs the full pipeline and prints plain numbers, for example: `renewal notice: 4/4 correct`, `grounding: 38/41 source found`, `highlight on expected quote: 37/38`.
   - Run it on every change. A drop in any number blocks the change.

## 8. Cost and logging

- Cost per document = pages × credits per page for the tier × $0.00125 (prices from 28–29 Sep 2026; check the pricing page before relying on them).
  - `cost_effective` = 3 credits/page, `agentic` = 10 credits/page.
  - Whether granular boxes add credits: **unknown, Phase 0 checks.**
- Store tier and page count per document so real costs can be calculated from real usage.

## 9. Environment variables

- `LLAMA_CLOUD_API_KEY`: an Edge Function secret, set by Brad in the Supabase dashboard, never printed from Claude Code.
- `LLAMA_CLOUD_BASE_URL`: the EU endpoint confirmed in Phase 0.
- Add both to `.env.example` and to the env var comment block in the setup SQL, with names identical everywhere.

## 10. Out of scope for this build

- PDF.js / LiteParse parser adapters
- Table-cell highlights in the UI (the data is stored; the UI comes later)
- Face matching or any biometric processing
- Real client documents through LlamaParse before POPIA sign-off
