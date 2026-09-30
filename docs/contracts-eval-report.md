# Contracts eval: Phase 4 report (30 Sep 2026)

Made-up documents only. Claude Sonnet 5.5, LlamaParse EU with pinned versions (cost-effective 2026-09-28, agentic 2026-09-29). Every number below is from `npm run eval:contracts -- --parser llamaparse --extractor claude --repeat 3` and is re-scored for free from the recorded runs with `--extractor fixture:extract-claude-sonnet-5-5 --repeat 3`.

## What was measured

| Sample | What it is | Parsed at |
| --- | --- | --- |
| `demo-marula` | Five demo contracts as digital PDFs (a lease with an addendum, a subscription, a cleaning contract with a conflict, a copier rental, a courier agreement with a blank) | cost-effective |
| `scan-marula` | The same as photographed pages, no text layer | agentic |
| `watermark-marula` | The same digital PDFs with three dark diagonal SAMPLE marks per page | cost-effective |
| `layout-lakeside` | A different layout: two columns in small type, running on to a second page, with a red RECEIVED stamp lying over a clause | cost-effective |

121 field answers per run (37 + 37 + 37 + 10), each checked against a hand-written answer key. The free check (a perfect extractor on the digital PDFs, no network) must stay at `fields 84/84 · grounding 103/103 · highlights 87/87 · flags 6/6 (0 unexpected) · key dates 18/18`.

## Results (three Claude runs)

| | Run 1 | Run 2 | Run 3 |
| --- | --- | --- | --- |
| Fields correct (of 121) | 105 | 105 | 104 |
| Highlights on the expected quote (of 126) | 120 | 117 | 118 |

**Per-field accuracy** (all samples, all three runs):

| Field | Correct | | Field | Correct |
| --- | --- | --- | --- | --- |
| counterparty | 48/48 (100%) | | notice | 36/48 (75%) |
| deposit | 12/12 (100%) | | premises | 3/3 (100%) |
| endDate | 27/30 (90%) | | renewal | 45/48 (93.8%) |
| fee | 30/48 (62.5%) | | startDate | 47/48 (97.9%) |
| feeChange | 21/30 (70%) | | termMonths | 45/48 (93.8%) |

**Grounding match rate: 633/640 (98.9%)**, every one exact (none needed fuzzy matching). Six were refused as appearing in more than one place (a title repeated on the page); one was not found.

**Highlight on the expected quote: 355/372 (95.4%)** of the sources cited at places the answer key lists. Under the older overlap-only rule the same sources score 271/372 (72.8%): the key's boxes are padded round each clause, so a tight box round the right words scored low. A further 28 sources were cited at places the key doesn't list for that field and are counted apart, not as misses.

**Flags:** 24/27 expected found, 35 unexpected across the three runs (about 12 per run). **Key dates:** 72/78 correct.

Sample by sample, fields correct per run: `demo-marula` 33/33/33 of 37, `scan-marula` 29/29/29, `watermark-marula` 33/33/32, `layout-lakeside` 10/10/10.

## What the eval found in the pipeline (fixed)

| Finding | Effect | Fix |
| --- | --- | --- |
| The extractor was never told which party is "us" | It named the organisation itself as the counterparty: counterparty accuracy **70.8%** | The organisation's name goes into the instructions. Now **100%** |
| LlamaParse gives no word boxes for the second-column part of a paragraph that runs across columns | The chip said "Source found" with nothing to highlight | Under 60% of the words positioned means no highlight; the chip says "no highlight" in words |
| A rubber stamp made LlamaParse place one word 80 pt from the rest of its sentence | The highlight would have landed in the wrong place | A word far from all the others is left out; the highlight is marked approximate |
| Any rotated word switched off line merging and outlier trimming for the whole quote | Scans and stamped pages got worse highlights | Rotated words are handled one by one; a tilt under 3° counts as upright |
| The eval counted a source cited at an unlisted place as a wrong highlight | Highlight rate looked like 85.5% | Counted apart. The rate is 95.4% on scored places |
| Failures were counted across samples as if they were runs | "9/3" | Failures now carry their sample name |

## What is still wrong

**Extraction quality (the same on all three runs, so not luck):**

1. **C1, the lease with an addendum and a schedule** (fee, fee change, notice: 9 of the 16 wrong fields per run, across the three copies). Claude reports the addendum's new fee and Schedule 2's steps as competing values, and doesn't mark the old notice period as replaced, because the addendum changes a schedule that has no clause number.
2. **Scans only:** C4's end date is quoted without its day, so the value check refuses it. C4's renewal and notice are said to be "not stated" in 2 of 3 runs. C5's blank line is not read as a blank by OCR, so the "blank in signed copy" flag is not raised (safe direction: it is flagged for review, but as "not verified").
3. **C5 fee** is a free-text answer ("Rates per Schedule A"). Claude words it differently each run and the eval compares text exactly, so this counts as wrong about once in three runs. That is a fault of the comparison, not of the reading.

**Parser limits (LlamaParse):**

4. Second-column text of a paragraph that crosses columns has no word positions (layout sample, clauses 3.2 and 3.3: "no highlight" on all three runs).
5. Stamp text is read into the middle of a sentence ("R18 500.00 RECEIVED 13 MAR 2026 excluding VAT", and the date was misread). Grounding still works because the quote is copied verbatim, and the highlight covers the stamp words too (clause 4.1: 73–75% inside the expected box).
6. On picture-only pages, horizontal positions run about 1% narrow (see `llamaparse-findings.md`).
7. LlamaParse **ignores watermark overlays entirely** (the watermarked PDFs parse to the same text as the plain ones). The watermark sample therefore only exercises text-layer parsers; it proves nothing about `ignoreTokens` with LlamaParse.

**Answer key:** the C5 Schedule A "highlight elsewhere" misses (three copies) are the key's fault. Claude cited the footnote "Rates exclude VAT" just below the table; the box is exactly on that footnote, but the key's box covers only the table.

## Threshold and rule proposals

Only where the numbers justify them.

- **`grounding.minScore` (0.9): no change.** Of 633 grounded quotes, none needed fuzzy matching, so the threshold is never exercised on this set. There is no evidence for moving it either way. Real scans of poorer quality are the test.
- **`grounding.ignoreTokens`: no change.** LlamaParse removes watermarks itself. Keep it for text-layer parsers.
- **Proposal (needs a decision): descriptive fields should not raise conflicts.** 14 of the 35 unexpected flags (40%) are `scope` conflicts (8) and `agreementType` "appears in more than one place" refusals (6). Two different descriptions of the scope aren't a contradiction, and a title repeated on the page is not a risk. Suggested rule: for `agreementType` and `scope`, differing wording is recorded (all sources kept), not flagged. Dates, money, periods and notice keep the current rules. This changes review behaviour, so I have not made it.
- **Proposal: do not tune the extraction prompt for C1 yet.** A prompt that fixes the lease-with-schedule case would be fitted to one made-up lease. Collect two or three real addenda first (the real-document gate), then decide.
- **Proposal: compare free-text fees loosely** (or leave `{text}` fees unscored) in the eval. It is a measurement fault.
- **Proposal: widen the C5 Schedule A box in the answer key** to include the footnote.

## Limits of this evidence

- Four made-up samples (three from one template plus one different layout), one model, one prompt. Nothing here is a claim about real client contracts.
- The scans are simulated (greyed, blurred, noisy JPEG images), not photographs.
- The real-document gate (10 real South African documents, including Afrikaans and phone photos) has not started; it needs the POPIA gates.
- Claude's answers vary a little between runs (23 fields changed at least once, mostly descriptive ones such as scope and agreement type); the scored fields were stable at 105/105/104.

## Cost

LlamaParse: about 156 credits for the new samples (about $0.20). Claude: about 930,000 input and 165,000 output tokens across the two full live runs and the watermark reruns.

## Running it

```
npm run eval:contracts -- --parser pdfjs --extractor fixture:extract-perfect
npm run eval:contracts -- --parser llamaparse --extractor fixture:extract-claude-sonnet-5-5 --repeat 3
npm run eval:contracts -- --parser llamaparse --extractor claude --repeat 3 --record
```

The first is free and must stay at 100%. The second re-scores the recorded runs (free). The third makes new Claude calls (about $2–3) and re-records.
