# Engine architecture (copy of the `happy-pipeline-engine` skill)

> Copied into the repo on 29 Sep 2026 so Claude Code has it even where the skill is not installed. If the skill is updated, update this file too. Where it says "this skill", read "this document".


Use this skill whenever a build starts on a real (non-demo) happyai service, or when a new "Happy" service is proposed. Read it before planning, ticketing or writing code.

## Core idea: one engine, many presets

Every Happy service runs the same pipeline:

```
INGEST → PARSE → EXTRACT → CHECK → REVIEW → DRAFT → TIMELINE
documents  text +    fields    rules set   a person    message to    audit record
come in    word      pulled    per client  decides     send/approve  of every step
           positions out
```

Build the engine once. Each service (Onboarding, Invoicing, Month-End, Contracts, and later Leads) is a **preset**: a document-type list, extraction schema, rule set, review options and message templates. Onboarding a new client means copying a preset and changing its settings, not writing new code. If a feature can't be expressed as preset settings, first ask whether it belongs in the engine (so every service gets it) before building it for one service.

## Shared engine components (build once)

| Component | What it does |
|---|---|
| Auth + organisations | Login, one organisation per client, user roles (uploader, reviewer, admin) |
| Per-client storage | Documents and extracted data isolated by `org_id` (Supabase Postgres + Storage with row-level security on every table and bucket) |
| Ingest | Upload, plus source connectors behind one adapter interface (email inbox, portal download, accounting export) |
| Parser (adapter) | Turns each page into text + word-level positions. v1 = LlamaParse (see Parser layer). Swappable behind one interface |
| Extraction | Claude extracts to the preset's schema, returning value + exact quoted source text + page, then the grounding check (Hard part 1) |
| Rules runner | Evaluates the preset's checks and outputs Pass / Flag plus a one-line reason per check |
| Review queue | Flagged items, resolution options (alphabetical), required notes, approve/hold |
| Draft generator | Messages generated from data and decisions, never hard-coded; always editable; never auto-sent |
| Timeline | Append-only audit log of every step, who did it and when |
| Settings | Preset editor: document types, fields, rules, alert windows, approval limits, templates |
| Source viewer | Renders the original PDF/image with a highlight box on the exact field (Hard part 1) |

The demo HTML files in the `happyai` repo (`demo-*.html`) and their briefs in `docs/` are the UI and behaviour spec. Reuse their layout, stepper, badges, modal and copy. Replace the inline `FIXTURE` with real data from the engine.

## Preset shape

Keep presets as data (a JSON row per organisation per service), shaped like the demo fixtures:

```js
{
  service: "Happy Onboarding",
  documentTypes: [ { id, label, required, fields: [ { key, label, type } ] } ],
  checks: [ { id, label, ruleSource: "organisation" | "regulatory", logic, reasonTemplate } ],
  review: { options: [ ... ], notesRequiredFor: [ ... ], approvalLimits: [ ... ] },
  messages: { email: template, whatsapp: template },
  alertWindows: { ... },
  parser: { tier: "agentic" | "cost_effective" | "fast" }   // per document type if needed
}
```

The rules runner must be deterministic code reading the preset. The AI extracts; it never decides pass/fail.

## Parser layer (decided Sep 2026 — conditional on the gates below)

### v1: LlamaParse only (cloud API)
Why: it returns **word-level bounding boxes** and handles scans/handwriting, and it's called over HTTP from Supabase, so **no worker server, no PaddleOCR service, no LibreOffice**. That removes the ops work Brad can't maintain by hand. At current prices parsing costs cents per document, so it isn't the margin constraint.

Settings for every call:
- **EU region** (`cloud.eu.llamaindex.ai`) — the safer default for POPIA.
- `do_not_cache=True` — otherwise files are cached for 48 hours.
- Output option `granular_bboxes: ["word"]` (line and table-cell levels also exist).
- Parse tier set per document type in the preset. Use `is_complex`-style routing: cheap tier for clean digital PDFs, Agentic for scans/photos.

Use LlamaParse **only for parsing and positions**. Do **not** use LlamaExtract for schema extraction: Claude does extraction, which keeps the parser swappable and avoids LlamaExtract's weaker reported long-document accuracy (a competitor-cited audit: ~80% precision).

Facts as researched on 28–29 Sep 2026 (re-check before relying on them — pricing and features change):
- Credits cost $1.25 per 1,000. Parse tiers per page: Fast 1, Cost-effective 3, Agentic 10, Agentic Plus 45. Layout extraction +3 per page.
- Plans: Free 10k credits/month; Starter $50/month for 40k; Pro $500/month for 400k; Enterprise custom (needed for self-hosting / your own cloud account).
- Cost per document = pages × credits per page × $0.00125. Model it this way with the real page counts; don't assume page counts.
- Word-level boxes were announced 9 Jun 2026 and are **beta**. "All paid tiers" is ambiguous (paid plan vs paid parse tier) — confirm.
- Regions: North America and EU only. No Africa region.
- No training on customer data by default. SOC 2 Type II.
- Unknown: which third-party AI models the Agentic tiers use (the subprocessor page didn't load). Whether the Fast tier OCRs scans at all or only reads existing text.

### Later: LiteParse as a cost saving
LiteParse (run-llama/liteparse, Apache-2.0, same company) runs locally and is strong on **native digital PDFs** (emailed invoices, downloaded statements, Word-exported contracts). Bring it in only when volume makes a worker server worth running. Notes for that day:
- `lit is-complex` flags pages needing OCR with reasons (`scanned`, `garbled`, `sparse-text`…). Use it as the router: simple → LiteParse text path; scans → LlamaParse; hopeless → straight to review.
- Table cells carry their own bbox (good for Month-End and Invoicing line items). `--extract-form-fields` reads filled PDF forms exactly (useful for onboarding forms).
- It's a Rust native binary: it **won't run in Supabase Edge Functions**. It needs one small worker server (Fly.io, Railway or similar). PaddleOCR would be a second Python service; Office files need LibreOffice.
- Its benchmarks are vendor-run against model-free tools only, with low absolute scores (old scans 13–19%, visual grounding ~0.31). Its README itself sends scans and handwriting to LlamaParse.
- Unconfirmed: whether `text_items` are single words or longer spans. Its docs say a phrase "may span multiple text items", so the grounding matcher must join adjacent items.
- Coordinates are PDF points (1/72 inch) from the **top-left**; screenshots need scaling by `dpi / 72`. PDF.js uses a different origin. Test highlight positions, not just values.

### Parser gates (must pass before committing to production)
1. **POPIA:** the template pack in the POPIA section is signed off by an SA privacy lawyer, and the LlamaParse subprocessor list checks out.
2. **Real-document test (free tier is enough):** 10 real SA documents including phone photos of IDs, scanned affidavits and Afrikaans text (municipal accounts, affidavits). Score by **grounding match rate** (share of extracted values whose quote is found on the page with correct boxes) and highlight position accuracy — not by vendor benchmarks. Include a check of what the Fast tier does with a scan.
3. If LlamaParse fails the test on scans, compare against a second provider (Azure Document Intelligence, Google Document AI or AWS Textract) behind the same parser adapter.

## The four hard parts (plan these first)

### 1. "View source" highlight on a real PDF — biggest single piece of work
AI models read text well but can't reliably say where on the page it sits. The approach:
- The parser returns **word-level bounding boxes** (see Parser layer).
- Claude returns each extracted value **plus the exact quoted source text and page number**.
- **Grounding check:** find the quoted text in the parser's words for that page (normalised, fuzzy-tolerant, joining adjacent items). If it isn't found, the value is marked "Not verified — review" and goes to the review queue. No value is shown without a source.
- Store the matched boxes. The source viewer draws the highlight from them, converting coordinates to the viewer's system.
- Blueprint to copy (not depend on): `antonsoo/fieldproof` (MIT, new, unused) — every field is `{value, evidence, page}`, exact-then-fuzzy matching, statuses verified / needs_review / unsupported. Google's `langextract` uses the same idea with character offsets.
- Viewer: draw our own boxes over PDF.js rather than using the stale `react-pdf-highlighter` (last updated Nov 2024).

### 2. Messy inputs
Real inputs are phone photos of IDs, skewed scans, stamped affidavits and 40-page leases, not the demos' clean HTML paper.
- Classify the document type before extracting. A wrong classification must go to review, not be guessed.
- Keep a confidence per field. Low confidence goes to review.
- Accuracy is **measured on the test set** (Hard part 4), never assumed or claimed from a few good runs. A high review rate is safe but kills the product's value, so track it.

### 3. Links into other systems
Accounts inboxes, supplier portals, and purchase orders, goods-received notes or ledger exports from Sage, Xero or Pastel. Every package is different.
- Start every service with **manual upload / file export** as the connector. Add live connectors only when a paying client needs one.
- Each connector implements the same adapter interface and outputs the same internal format, so the rest of the pipeline never knows the source.
- Budget connector time per accounting package separately. It is where Invoicing's effort goes. Xero has an official Node SDK (`XeroAPI/xero-node`, MIT); Sage and Pastel not yet checked.

### 4. A test set — build it before the pipeline
Brad does not debug code by hand, so the test set is how anyone knows the system works.
- For each service, collect **20–50 real (anonymised or permissioned) sample documents** with a hand-checked `expected.json` of correct field values, check outcomes and expected highlight regions.
- Store under `eval/<service>/` in the repo. Label Studio (Apache-2.0) can be used to mark the correct answers.
- An eval script (promptfoo, MIT, or a plain script) runs the full pipeline on every sample and reports per-field accuracy, grounding match rate, highlight position errors and wrong check outcomes.
- Run it on **every change**. A change that lowers accuracy does not ship.
- Report results to Brad as plain numbers ("invoice total: 48/50 correct"), not "looks good".

## Build order

1. Parser gates (POPIA confirmation + 10-document real test).
2. Test set for the first service (Hard part 4).
3. Engine skeleton: auth, organisations, storage + RLS, timeline.
4. Parser adapter (LlamaParse) + Claude extraction + grounding check (Hard part 1) for the first service.
5. Rules runner + review queue + draft generator, driven by the preset.
6. Source viewer with highlights.
7. Eval passes at an agreed accuracy bar → pilot with one client.
8. Next service = new preset + its own test set. Only add engine code if the preset can't express it.

Default first service: **Month-End** (closest to existing ProTax bank-statement extraction). Difficulty order, easiest first: Month-End, Onboarding, Contracts, Invoicing (connectors).

## Non-negotiable product rules (carried over from the demo briefs)

- The system **extracts, checks, flags and drafts**. It never approves, pays, posts, sends or gives legal advice. A person approves every outcome.
- Wording: "appears missing", "flagged for review", "ready for approval". Never "verified", "compliant" or "approved" as something the system decided.
- No fake registry checks (CIPC, SARS, banks) unless a real, contracted integration exists.
- Rules that are organisation policy are labelled as such, separately from regulatory rules.
- Messages to third parties are generated from data, editable, and never auto-sent.
- Money is handled in integer cents and displayed as `R12 450.00`, with a true minus sign for negatives.
- Dates use UTC date-only arithmetic.

## POPIA

Researched 29 Sep 2026 from SA law-firm and vendor sources. Claude is not a lawyer: flag these points for legal confirmation and never present them as settled.

### Roles
When happyai hosts or runs the engine for a client, the client is the **responsible party** and happyai is an **operator**. Section 72 is legally the client's obligation, but happyai chooses the subprocessors, so solving it is happyai's design job.

### Cross-border transfer (section 72) — applies to the whole pipeline
- Sending SA personal information to a foreign provider is a transfer. **No caching (`do_not_cache`) does not avoid it**, because transmitting it for processing is itself processing.
- It applies to **every offshore step**: LlamaParse (NA/EU only) **and the Claude API**, not just the parser.
- Section 72 allows a transfer only if one applies: (a) the recipient is bound by a law, binding corporate rules or a **binding agreement** giving adequate protection; (b) the person **consents**; (c) it is necessary for a contract with the person; (d) it is for a contract made for their benefit; (e) it benefits them and consent is impractical.
- Realistic grounds for happyai: **(a) binding agreement** and **(b) consent**. Contract necessity is shaky for onboarding, because the directors whose IDs are processed usually aren't parties to the contract.
- There is **no official adequacy list**: the Regulator's cross-border guidance note was still unpublished. EU (GDPR) is a stronger adequacy argument than the US (Schrems II).
- Penalties: fines up to R10 million and/or up to 10 years' imprisonment. The Regulator is increasingly active (e.g. R5m notice to the Department of Justice, R500k fine to Blouberg Municipality).

### ID documents and special personal information
- An ID photo is **not automatically biometric**; it becomes biometric only with "technical processing" for identification (e.g. face matching). **Never add face matching** without a separate POPIA review.
- Special personal information (incl. biometrics) or children's information sent to a country without adequate protection needs the Regulator's **prior authorisation (s57)**.
- ID numbers are unique identifiers; prior authorisation applies only when they're linked with other organisations' data for a different purpose. Don't build that.

### The template pack (build once, reuse for every client)
1. **Consent + notice at collection:** the client's form names the providers (LlamaParse, Anthropic) and countries, with a consent tick.
2. **Operator agreement (happyai ↔ client):** scope, security, breach notification, return/deletion, and the subprocessor list with countries and safeguards.
3. **DPAs with LlamaParse and Anthropic** including cross-border clauses (the binding-agreement ground).
4. **Minimisation:** send only the pages needed, no face matching, mask ID numbers in the UI.
5. **One sign-off by an SA privacy lawyer** on the pack before the first real client.
6. **In-country fallback:** Azure Document Intelligence in South Africa North (data stays in-region by default) as the parser for clients who require local processing. Note: the AI extraction step can't currently stay in SA — Claude via AWS Cape Town uses global cross-region inference.

### Always
- LlamaParse: EU region, `do_not_cache=True`. Get its subprocessor list (security.llamaindex.ai or support@runllama.ai) and which AI models the Agentic tiers use.
- Data encrypted at rest, isolated per organisation with RLS, access-logged, deleted on contract end.
- No real client documents through any offshore service until the template pack is signed off.

## Brad's standing UI and build rules

- 4.5:1 minimum text contrast and 13px minimum font size, badges included.
- Status is shown by colour **plus** a text label, never colour alone.
- Modals are centred (never bottom sheets), trap focus, close on Esc and scrim click, and return focus.
- Dropdown options are alphabetical.
- Works at 360px width with no horizontal scroll.
- Stack defaults: Supabase (auth, Postgres, storage, RLS, edge functions) + Vercel; vanilla HTML/JS by default, React/Vite where the review UI benefits. LlamaParse is called over HTTP, so v1 needs no extra server; LiteParse later would.
- Deploy by `git push` only; never run Vercel CLI commands.
- Terminal instructions for Brad use Windows syntax, one literal command per line, with what should appear on screen.
- Stay in planning mode until Brad explicitly says to build.

## Adding a new Happy service

Before proposing a new service (e.g. Happy Leads), map it onto the pipeline stages. If it fits, it's a preset plus possibly a new connector. For Leads: signal sources in (INGEST) → business fields (EXTRACT) → fit + intent scoring rules (CHECK) → rep marks hit/miss (REVIEW) → call opener (DRAFT) → outcome log (TIMELINE); it skips PARSE. If a service can't be mapped, say so explicitly: it is a separate product, not a preset.
