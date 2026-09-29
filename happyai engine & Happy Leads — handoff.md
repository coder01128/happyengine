# happyai engine & Happy Leads — handoff

Sep 29, 2026 · @Brad

## Where things stand

No code has been written. We are in planning, with two threads: a possible **Happy Leads** service card, and the **shared pipeline engine** behind all Happy services. The engine design is captured in the `happy-pipeline-engine` skill. The next real step is two gates: Brad's POPIA check on LlamaParse, and a 10-document test on real SA scans.

This handoff covers 28–29 Sep 2026. Prices and features quoted were looked up then and should be re-checked before relying on them.

## Decisions so far

| Area | Decision | Status |
| --- | --- | --- |
| Engine | All Happy services run one pipeline: ingest → parse → extract → check → review → draft → timeline. Each service is a per-client preset | Agreed; saved in the skill |
| Rules | Claude extracts; deterministic code decides pass/fail; a person approves every outcome | Agreed |
| Parser v1 | LlamaParse cloud API: EU region, `do_not_cache=True`, word-level bounding boxes | Conditional on the gates |
| Extraction | Claude, not LlamaExtract, so the parser stays swappable | Agreed |
| Parser later | LiteParse locally for digital PDFs, as a cost saving once volume justifies a worker server | Parked |
| First service | Month-End (closest to existing ProTax statement extraction) | Recommended |
| Happy Leads name | "Happy Leads" over "Happy Sales" (you don't close deals) | Recommended, not confirmed |
| Happy Leads delivery | Client-managed internal tool, optional retainer if Brad runs the scraping | Brad's intent |
| Happy Leads angle | Call-first weekly "Why-Now List" per industry preset, delivered on WhatsApp, with hit/miss feedback | Hypothesis, not validated |

## Happy Leads research

The market is crowded; the gap is scoring SA-specific "why now" signals against a client's own ideal customer. Scraping alone is commoditised.

| Who | What | Price (Sep 2026) |
| --- | --- | --- |
| [Apollo](https://hackingdemand.com/blog/apollo-io-pricing-2026) | Contact data, enrichment, sequencing | $49–$119/user/month |
| [Clay](https://www.warmly.ai/p/blog/clay-pricing) | Enrichment and scoring, credit-based | $149–$800/month |
| [Keyplay, UserGems, Koala, Warmly](https://gtmepulse.com/tools/best-sales-signal-tools/) | Signal tracking | $100/month to $15k+/year |
| [Apify actors](https://apify.com/jurassic_jove/google-maps-reputation-leads) | Maps bad-review, no-website and CIPC scrapers | Pay per use |
| [Tender Services](https://www.tenderservices.co.za/pricing) | SA tender alerts, unscored | R550/month |
| SA agencies | Managed lead gen | [R8k–R20k/month](https://www.growthpulsemedia.co.za/cost-of-b2b-lead-generation-south-africa/) (agency's own figure) |

What the sources agree makes lead scoring work:

- Keep **fit** (looks like our best customers) separate from **intent** (buying now) ([2x2](https://www.marketingcasebootcamp.com/post/your-lead-score-is-one-number-doing-two-jobs)).
- Signals decay within days to weeks, so alerts must arrive fast.
- Reps ignore scores after false positives: define "qualified" with sales, show why each lead scored, track acceptance ([Pedowitz](https://www.pedowitzgroup.com/blog/sales-doesnt-trust-your-lead-scoring-model.-heres-why-and-how-to-fix-it)).
- Use hot/warm/cool tiers mapped to actions; deliver where reps already work; recalibrate from outcomes.

Caveats: global tools have stale SA SMB data per [GrowthPulse](https://www.growthpulsemedia.co.za/b2b-lead-generation-tools-south-africa/). Cold email falls under POPIA s69 consent rules; cold calling does not ([POPIA Ready](https://www.popiaready.co.za/blog/direct-marketing-popia-rules)). Reddit was blocked, so no forum input was gathered. Willingness to pay is unknown.

## The pipeline engine

All four demos are one product with different settings, so we build one engine and sell each service as a preset.

&#91;embedded content: Happy pipeline · 7 stages\]

The preset (document types, fields, rules, review options, message templates) configures every stage; onboarding a client means editing a preset, not writing code.

| Service | Real difficulty | Why |
| --- | --- | --- |
| Month-End | Lowest | ProTax already extracts statements; matching is plain logic. Skipped by the demo: one deposit covering several invoices |
| Onboarding | Medium | Varied documents (ID photos, CIPC certificates); ID numbers raise the POPIA bar |
| Contracts | Medium | Clause references are feasible with quote checks; risk is missing a clause in long agreements |
| Invoicing | Highest | PO and goods-received matching needs live links to the client's accounting system |

The four hard parts, shared by every service:

1. **Source highlight on a real PDF** — parser word positions + Claude's quoted text + a grounding check; unmatched values go to review.
2. **Messy inputs** — classify first, keep per-field confidence, measure accuracy on the test set.
3. **Links into other systems** — start with manual upload; build connectors only for paying clients.
4. **A test set** — 20–50 real samples per service with checked answers, run on every change, reported as plain numbers.

## Parser research

LlamaParse covers what LiteParse can't (scans, handwriting, word-level positions) and removes the need for a worker server. Parsing costs cents per document; POPIA is the open risk.

|  | LlamaParse (cloud) | LiteParse (local) |
| --- | --- | --- |
| Licence / cost | Credits at $1.25 per 1,000. Fast 1, Cost-effective 3, Agentic 10, Agentic Plus 45 credits/page ([pricing](https://developers.llamaindex.ai/llamaparse/general/pricing/)) | Free, Apache-2.0 |
| Plans | Free 10k credits; Starter $50 for 40k; Pro $500 for 400k ([plans](https://www.llamaindex.ai/pricing)) | n/a |
| Positions | Word, line and table-cell boxes, **beta** since 9 Jun 2026 ([announcement](https://www.llamaindex.ai/blog/announcing-granular-bounding-boxes-in-llamaparse)) | Text items + table cells; word vs span unconfirmed ([docs](https://developers.llamaindex.ai/liteparse/guides/visual-citations/)) |
| Scans | Agentic tiers use AI models; no independent test found | Tesseract-grade; old scans 13–19% on its own benchmark |
| Hosting | HTTP API from Supabase, no server | Rust binary; needs a worker server (not Edge Functions) |
| Data | NA or EU only; no training on customer data; 48h cache unless `do_not_cache`; SOC 2 Type II ([regions](https://developers.llamaindex.ai/llamaparse/general/regions/), [enterprise](https://developers.llamaindex.ai/llamaparse/general/enterprise-readiness/)) | Stays on your server |

Cost per document = pages × credits per page × $0.00125. A 10-page pack on Agentic is about $0.13.

Pushback to keep in mind:

- Nearly all evidence is vendor or competitor material. Reducto cites an audited \~80% precision for LlamaExtract on long documents ([Reducto](https://llms.reducto.ai/reducto-vs-llamaparse)).
- LiteParse's README funnels users to paid LlamaParse; both are from LlamaIndex.
- LiteParse coordinates are PDF points from the top-left; PDF.js differs, so test highlight positions.
- Unknown: which AI models the Agentic tiers use, and whether the Fast tier OCRs scans at all.

## Open-source shortlist

Stars, licence and activity were checked via the GitHub API on 28 Sep 2026. Zero-star repos are blueprints to copy, not dependencies.

| Repo | Use | Stars · licence |
| --- | --- | --- |
| [liteparse](https://github.com/run-llama/liteparse) | Local parser for digital PDFs (later) | 12.7k · Apache-2.0 |
| [docling](https://github.com/docling-project/docling) | Backup parser with OCR | 68k · MIT |
| [PaddleOCR](https://github.com/PaddlePaddle/PaddleOCR) | OCR engine for bad photos | 90k · Apache-2.0 |
| [langextract](https://github.com/google/langextract) | Grounding idea (character offsets); no Claude support listed | 39k · Apache-2.0 |
| [fieldproof](https://github.com/antonsoo/fieldproof) | Blueprint for the grounding check + review UI | 0 · MIT |
| [react-pdf-highlighter](https://github.com/agentcooper/react-pdf-highlighter) | PDF highlights; stale since Nov 2024, prefer our own boxes over PDF.js | 1.4k · MIT |
| [promptfoo](https://github.com/promptfoo/promptfoo) | Runs the test set on every change | 25.5k · MIT |
| [label-studio](https://github.com/HumanSignal/label-studio) | Marking correct answers for the test set | 28k · Apache-2.0 |
| [invoice2data](https://github.com/invoice-x/invoice2data) | Template fallback for fixed-layout invoices | 2.2k · MIT |
| [xero-node](https://github.com/XeroAPI/xero-node) | Official Xero SDK | 264 · MIT |
| [google-maps-scraper](https://github.com/gosom/google-maps-scraper) | Happy Leads source; likely breaches Google's terms | 6.2k · MIT |

Avoid [Unstract](https://github.com/Zipstack/unstract): its AGPL-3.0 licence can force publishing your source if you host it for clients.

## Gates and open questions

No real client document goes through LlamaParse until gates 1 and 2 pass.

1. **POPIA cross-border transfer** — LlamaParse processes in North America or the EU only. Brad is investigating; confirm with a lawyer.
2. **LlamaParse subprocessors** — the list at security.llamaindex.ai didn't load. Ask support@runllama.ai which AI models the Agentic tiers use.
3. **Real-document test** — 10 real SA documents (ID phone photos, scanned affidavits, Afrikaans text) on the free tier, scored by grounding match rate and highlight accuracy.
4. **Fast tier on scans** — does it OCR, or only read existing text?
5. **"All paid tiers" for word boxes** — paid plan or paid parse tier?

Open business questions:

- Happy Leads: which industry is the first buyer, and what would they pay? Talk to 3–5 target buyers before building.
- Operator agreement template for happyai clients (POPIA s21) is not drafted.
- Sage and Pastel connector options are not researched.

## Next steps

- [ ] Brad: settle the POPIA cross-border position for LlamaParse
- [ ] Email support@runllama.ai for the subprocessor list and Agentic model providers
- [ ] Gather 10 real SA documents for the parser test (with permission or anonymised)
- [ ] Run the parser test on LlamaParse's free tier; record grounding match rate
- [ ] Collect 20–50 Month-End samples with hand-checked answers for the test set
- [ ] Happy Leads: pick one target industry and talk to 3–5 buyers

Where things live:

- **Skill:** `happy-pipeline-engine` — architecture, parser layer, gates, POPIA, build order. Load it at the start of any build session.
- **Repo:** `C:\ccode\git-repos\happyai` — `demo-*.html` (UI spec) and `docs/happy-*-demo-brief.md` (behaviour spec).
- **Memory:** Brad's happyai notes hold the LiteParse assessment and Happy Leads intent.
