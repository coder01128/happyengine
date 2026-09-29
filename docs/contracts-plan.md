# Happy Contracts — build plan

Happy Contracts is built inside `happyengine`, not in the separate `happycontracts` repo (that repo stays empty and can be deleted). It shares the database, logins, organisations, timeline and app shell with Month-End.

**Spec:** `happyai/demo-contracts.html` (UI and behaviour) and `happyai/docs/happy-contracts-demo-brief.md`. The real product does what the demo shows, on real PDFs.

## What changes from the demo

| Demo | Real build |
| --- | --- |
| Five agreements hard-coded as HTML | Uploaded PDFs (main agreement plus addenda), stored per organisation |
| Values and highlights written by hand | Parser gives word positions; Claude extracts value + exact quote + page; code checks the quote exists on that page and stores its boxes |
| Highlights on HTML "paper" | Highlights drawn over the real PDF page (PDF.js) |
| Fixed as-at date 14 Oct 2026 | Today's date (Johannesburg calendar day). Eval keeps 14 Oct 2026 |
| Review choices and reminders reset on reload | Stored, with every step in the timeline. Nothing is ever sent |

## The rules that don't change

- The system records and calculates. It never interprets enforceability or gives legal advice. Unclear or conflicting wording is flagged for review, never resolved automatically.
- No value is shown without a source. A quote that can't be found on its page is "Not verified — review".
- Dates show their derivation next to the quoted wording.
- AI extracts; deterministic code flags and calculates; a person decides.

## Build order (one brief per Claude Code session)

| Brief | What | Needs keys? |
| --- | --- | --- |
| `briefs/01-split-core.md` | Split the engine into `core` and `month-end` | No |
| `briefs/02-contracts-test-set.md` | Synthetic test set: the 5 demo agreements as real PDFs, plus scan-style copies, with correct answers and correct highlight boxes | No |
| `briefs/03-contracts-foundation.md` | Month-based date maths, the Contracts preset, database tables | No |
| `briefs/04-documents-package.md` | Parser adapters (fixture, local PDF.js, LlamaParse), Claude extractor, quote check | Only for the live adapters |
| `briefs/05-contracts-engine.md` | Extraction schema, rules, key dates, register, reminder draft, eval runner | Only for live eval |
| `briefs/06-contracts-backend.md` | Edge functions, review and reminder actions, smoke test | No (smoke uses recorded fixtures) |
| `briefs/07-contracts-app.md` | Contracts screens, including the PDF source viewer | No |

Everything up to and including brief 07 can be built and tested **without a LlamaParse account**:

- The **fixture** adapters replay recorded results.
- The **local PDF.js** adapter reads the digital test PDFs on your machine.

LlamaParse is needed for scanned documents, and for the real-document gate test. Setup steps are in `llamaparse-setup.md`.

## Gates before any real client contract

1. The POPIA template pack is signed off (see `docs/engine-architecture.md`).
2. DPAs are in place with LlamaIndex and Anthropic, and LlamaParse's subprocessor list checks out.
3. The organisation's `offshore_processing_approved` flag is set by happyai (brief 03). The code refuses to send that organisation's documents to LlamaParse or Claude until it is.
4. Real contracts are added under `eval/contracts/` (git-ignored), with hand-checked `expected.json`. The eval passes at an agreed bar.

## Known risks, measured by the eval rather than assumed

- **Missed clauses in long agreements.** Tracked as per-field recall.
- **Quotes that don't match the parser's text** (hyphenation, ligatures, OCR errors). Tracked as grounding match rate.
- **Highlight boxes in the wrong place.** Tracked as overlap with the expected boxes.
- **Addenda amending clauses.** C1 in the test set covers this.
- **Afrikaans contracts.** Not in the synthetic set; add real samples when they arrive.
