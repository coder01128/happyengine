# Contracts eval: Phase 4 report (30 Sep 2026, rescored after D13)

Made-up documents only. Claude Sonnet 5.5, LlamaParse EU with pinned versions (cost-effective 2026-09-28, agentic 2026-09-29). Every number below is from `npm run eval:contracts -- --parser llamaparse --extractor claude --repeat 3` and is re-scored for free from the recorded runs with `--extractor fixture:extract-claude-sonnet-5-5 --repeat 3`.

**Rescored after D13.** The same recorded Claude runs, re-scored with three changes: descriptive fields (agreement type, scope) no longer raise flags, the free-text fee is compared loosely, and the C5 Schedule A answer-key box now includes the footnote. No new Claude calls. The first version of this report scored 105 / 105 / 104 fields and 35 unexpected flags.

## What was measured

| Sample | What it is | Parsed at |
| --- | --- | --- |
| `demo-marula` | Five demo contracts as digital PDFs (a lease with an addendum, a subscription, a cleaning contract with a conflict, a copier rental, a courier agreement with a blank) | cost-effective |
| `scan-marula` | The same as photographed pages, no text layer | agentic |
| `watermark-marula` | The same digital PDFs with three dark diagonal SAMPLE marks per page | cost-effective |
| `layout-lakeside` | A different layout: two columns in small type, running on to a second page, with a red RECEIVED stamp lying over a clause | cost-effective |

121 field answers per run (37 + 37 + 37 + 10), each checked against a hand-written answer key. The free check (a perfect extractor on the digital PDFs, no network) must stay at `fields 95/95 · grounding 138/138 · highlights 111/111 · flags 12/12 (0 unexpected) · key dates 18/18`.

## Results (three Claude runs)

| | Run 1 | Run 2 | Run 3 |
| --- | --- | --- | --- |
| Fields correct (of 121) | 108 | 107 | 106 |
| Highlights on the expected quote (of 126) | 123 | 119 | 120 |

**Per-field accuracy** (all samples, all three runs):

| Field | Correct | | Field | Correct |
| --- | --- | --- | --- | --- |
| counterparty | 48/48 (100%) | | notice | 36/48 (75%) |
| deposit | 12/12 (100%) | | premises | 3/3 (100%) |
| endDate | 27/30 (90%) | | renewal | 45/48 (93.8%) |
| fee | 37/48 (77.1%) | | startDate | 47/48 (97.9%) |
| feeChange | 21/30 (70%) | | termMonths | 45/48 (93.8%) |

Agreement type and scope are not scored (the answer key has no value for them; they are descriptive).

**Grounding match rate: 639/640 (99.8%)**, every one exact (none needed fuzzy matching). None was refused as appearing in more than one place (descriptive fields take the first place; a repeated quote on a money or date field would still be refused). One was not found.

**Highlight on the expected quote: 362/372 (97.3%)** of the sources cited at places the answer key lists. Under the older overlap-only rule the same sources score 271/372 (72.8%): the key's boxes are padded round each clause, so a tight box round the right words scored low. A further 28 sources were cited at places the key doesn't list for that field and are counted apart, not as misses.

**Flags:** 24/27 expected found, 21 unexpected across the three runs (7 per run). **Key dates:** 72/78 correct.

Sample by sample, fields correct per run: `demo-marula` 34/34/34 of 37, `scan-marula` 30/30/29, `watermark-marula` 34/33/33, `layout-lakeside` 10/10/10.

## What the eval found in the pipeline (fixed)

| Finding | Effect | Fix |
| --- | --- | --- |
| The extractor was never told which party is "us" | It named the organisation itself as the counterparty: counterparty accuracy **70.8%** | The organisation's name goes into the instructions. Now **100%** |
| LlamaParse gives no word boxes for the second-column part of a paragraph that runs across columns | The chip said "Source found" with nothing to highlight | Under 60% of the words positioned means no highlight; the chip says "no highlight" in words |
| A rubber stamp made LlamaParse place one word 80 pt from the rest of its sentence | The highlight would have landed in the wrong place | A word far from all the others is left out; the highlight is marked approximate |
| Any rotated word switched off line merging and outlier trimming for the whole quote | Scans and stamped pages got worse highlights | Rotated words are handled one by one; a tilt under 3° counts as upright |
| The eval counted a source cited at an unlisted place as a wrong highlight | Highlight rate looked like 85.5% | Counted apart. The rate is 97.3% on scored places |
| Failures were counted across samples as if they were runs | "9/3" | Failures now carry their sample name |
| Two different descriptions of a scope, or a title repeated on a page, were flagged for review | 14 of the 35 unexpected flags (40%) | D13: fields marked `descriptive` in the preset (agreement type, scope) keep every wording as a source, show the first, and never raise a flag. A quote in several places is taken at the first. Nothing found at all is still flagged |

## Silent errors: wrong fields that show "Source found" with no flag

Of the wrong fields per run (13 / 14 / 15), 5 / 6 / 7 were flagged for review, so a person would look at them. The other 8 per run (24 of 42 across the three runs) carried no flag on the field:

| What | Per run | Across 3 runs | Where |
| --- | --- | --- | --- |
| **Wrong value, green chip:** fee change recorded as "8% every anniversary" from cl. 5.2, when the schedule gives fixed steps (in 7 of the 9 cases Claude also gave the schedule, but its quote did not hold the three amounts, so the value check refused it and it was dropped without a flag; in the other 2 it gave no schedule) | 3 | 9 | C1 lease, in all three copies |
| **"Not stated" when the contract states it** (renewal, notice period): the extractor said not stated and cited a clause; no flag because these fields are not required | 2 | 6 | C4 copier, scanned copy only |
| **Marked wrong only by the answer key:** the notice is right (3 months) and the old 2-month clause is marked replaced by Add. 1 cl. 2, but the key's "replaced" value leaves out "before expiry" | 3 | 9 | C1 lease, in all three copies |

Points for the reader:

- The third row is a fault in the answer key, not in the system. The first version of this report said the old notice period was not marked as replaced; that was wrong. It is marked. So the real silent errors are 15 of 42 (5 per run): the fee change on C1 and the "not stated" on the scanned C4.
- **A gap in the rules behind the first row:** a candidate that fails the value check is dropped, and if another candidate for the same field stands, nothing tells the reviewer that a differing wording was refused. A proposal, not made: when a refused candidate carries a different value from the one recorded, raise a flag ("another cited wording was refused"). It would have caught 7 of the 9 fee-change cases.
- Every one of the 24 sits on an agreement that is flagged for another reason (C1 has a fee conflict, the scanned C4 has an end date that is not verified). So no wrong field sat on an agreement that showed as ready. That is a property of these samples, not a guarantee.
- The scanned C4 "not stated" also drops two key dates (the notice deadline and the end of the initial period) without a flag of their own. The end date is flagged, so the register shows the agreement as pending review.
- Descriptive fields are not scored, so silent errors there are not counted. A read through the recorded values found no wrong ones.

## What is still wrong

**Extraction quality (the same on all three runs, so not luck):**

1. **C1, the lease with an addendum and a schedule** (fee and fee change: 6 of the 13–15 wrong fields per run, across the three copies). The lease's Schedule 2 lists three rent steps and clause 5.2 says 8% each year; the addendum adds a separate parking charge (2 bays at R450). Claude reports Year 1's rent and the parking charge as two competing fees (flagged as a conflict), and gives the 8% clause as the fee change (its schedule of fixed steps was refused by the value check in 7 of 9 cases, see above). The model cannot say "the fee is a list of dated steps plus a separate charge". See the assessment below.
2. **Scans only:** C4's end date is quoted without its day, so the value check refuses it. C4's renewal and notice are said to be "not stated" in 2 of 3 runs. C5's blank line is not read as a blank by OCR, so the "blank in signed copy" flag is not raised (safe direction: it is flagged for review, but as "not verified").
3. **C5 fee** is a free-text answer ("Rates per Schedule A"). Claude words it differently each run. Now compared loosely (every word of the key must appear), which removed 7 wrong answers that were a measurement fault. Two remain: in 2 of 9 runs Claude cited both clause 5.1 and Schedule A with different wording, and the engine flagged the difference as a conflict on the fee.

**Parser limits (LlamaParse):**

4. Second-column text of a paragraph that crosses columns has no word positions (layout sample, clauses 3.2 and 3.3: "no highlight" on all three runs).
5. Stamp text is read into the middle of a sentence ("R18 500.00 RECEIVED 13 MAR 2026 excluding VAT", and the date was misread). Grounding still works because the quote is copied verbatim, and the highlight covers the stamp words too (clause 4.1: 73–75% inside the expected box).
6. On picture-only pages, horizontal positions run about 1% narrow (see `llamaparse-findings.md`).
7. LlamaParse **ignores watermark overlays entirely** (the watermarked PDFs parse to the same text as the plain ones). The watermark sample therefore only exercises text-layer parsers; it proves nothing about `ignoreTokens` with LlamaParse.

**Answer key:** the C5 Schedule A box now includes the footnote "Rates exclude VAT" (it stopped at the table). The C1 notice key lacks "before expiry" on the replaced clause's value (open, needs a decision).

## Fee as a schedule (assessment only, not built)

Today a fee is one value: `{ cents, per, vat }` or `{ text }`. Two fee candidates with different amounts are a conflict. That is right for two clauses that disagree, and wrong for a stepped rent or an addendum that adds a charge.

**The smallest change** keeps the candidate model: each candidate is one fee line, `{ cents, per, vat, from?, what? }`, with its own quote and highlight. `from` is the date it starts; `what` names the charge ("rent", "parking bay"). The rules then merge lines instead of comparing them: lines with different `from` dates are steps, lines with different `what` are separate charges, and only two lines with the same `from` and `what` but different amounts conflict. The current fee is calculated by code as at a date (the latest step that has started). It is never chosen by the AI.

What changes:

- Types, extraction schema and instructions: two optional properties on the fee value; the instructions ask for one candidate per rent row and a `what` on every line.
- `record.ts`: a merge path for fee (like the descriptive path); an addendum step replaces the step it names; the value check tests each line's amount and date against its own quote.
- Fee change: derived from the steps. `feeChange` stays only for an escalation with no amounts (a percentage, "unquantified", "none"), and is not compared against steps.
- Register and viewer (brief 07 screens): show the current fee with the steps under it, each with its own source chip. The "which fees change" search reads the steps. Optional extra: a key date for each future step.
- Eval: the C1 answer key (fee as steps plus the parking line), a list comparison in the scorer, one box per rent row. C2–C5 are single-amount fees and do not change.
- No database migration (the value is JSON); nothing is deployed yet.

**What C1 would score (an estimate, not a measurement).** Now, per copy: fee wrong, fee change wrong, notice wrong only because of the answer key. With the change and a correct extraction: fee and fee change right in all three copies, so 6 more fields per run (108 / 107 / 106 → about 114 / 113 / 112 of 121), and the 9 silent fee-change errors go. With the notice key corrected as well: about 117 / 116 / 115. The extraction step has to be re-run live (about R50 for three runs) to know if Claude follows the new instructions.

**Risks:**

- A charge the extractor forgets to label (`what`) would merge into the rent as a step. The rule to prevent this: every line needs a `what`, and no `what` replaces another.
- A percentage escalation with no amounts cannot become steps unless code calculates them, which needs a rounding rule. Not proposed.
- One lease (three copies) is the evidence. Stepped rent is ordinary in commercial leases, so this is not fitted to one document, but the size of the gain is not measured on real ones.

## Threshold and rule proposals

- **`grounding.minScore` (0.9): no change.** Of 639 grounded quotes, none needed fuzzy matching, so the threshold is never exercised on this set. There is no evidence for moving it either way. Real scans of poorer quality are the test.
- **`grounding.ignoreTokens`: no change.** LlamaParse removes watermarks itself. Keep it for text-layer parsers.
- **Done (D13): descriptive fields do not raise conflicts.** `agreementType` and `scope` are marked `descriptive` in the preset. Dates, money, periods and notice keep the current rules.
- **Done (D13): free-text fees are compared loosely in the eval; the C5 Schedule A box is widened.**
- **Do not tune the extraction prompt for C1 yet.** A prompt that fixes the lease-with-schedule case would be fitted to one made-up lease. Collect two or three real addenda first (the real-document gate), then decide. (The fee-as-schedule change is a data-model change, assessed above, not a prompt tune.)
- **Open: correct the C1 notice answer key** (add "before expiry" to the replaced clause's value).

## Limits of this evidence

- Four made-up samples (three from one template plus one different layout), one model, one prompt. Nothing here is a claim about real client contracts.
- The scans are simulated (greyed, blurred, noisy JPEG images), not photographs.
- The real-document gate (10 real South African documents, including Afrikaans and phone photos) has not started; it needs the POPIA gates.
- Claude's answers vary a little between runs (23 fields changed at least once, mostly descriptive ones such as scope and agreement type); the scored fields were stable at 108 / 107 / 106.

## Cost

LlamaParse: about 156 credits for the new samples (about $0.20). Claude: about 930,000 input and 165,000 output tokens across the two full live runs and the watermark reruns. The D13 rescore made no new calls.

## Running it

```
npm run eval:contracts -- --parser pdfjs --extractor fixture:extract-perfect
npm run eval:contracts -- --parser llamaparse --extractor fixture:extract-claude-sonnet-5-5 --repeat 3
npm run eval:contracts -- --parser llamaparse --extractor claude --repeat 3 --record
```

The first is free and must stay at 100%. The second re-scores the recorded runs (free). The third makes new Claude calls (about $2–3) and re-records.

## D17 live result (30 Sep 2026): fee as lines, three new Claude runs

The recordings in `eval/contracts/*/recorded/extract-claude-sonnet-5-5*.json` were replaced by three new live runs with the fee-lines instructions (the earlier recordings, and the numbers above, are in git history at commit 0198b88). Rules in force: D13, D15, D16, D17. Parses were reused (0 LlamaParse credits); Claude used 419,733 input and 79,944 output tokens.

| Per run | Run 1 | Run 2 | Run 3 | Before D17 (same rules, old recordings) |
| --- | --- | --- | --- | --- |
| Fields correct (of 121) | 114 | 112 | 115 | 111 / 110 / 109 |
| Grounding | 229/229 | 227/227 | 223/223 | 214/214 |
| Highlights on the expected quote | 141/146 | 147/151 | 135/138 | 126/129, 122/126, 123/126 |
| Unexpected flags | 5 | 6 | 4 | 9 / 9 / 10 (with D16 on the old recordings) |

- **C1 (the lease with the addendum and the schedule):** fee change right in 9/9 copy-runs (was 0/9), fee right in 8/9 (was 0/9), notice 9/9. The one C1 fee miss is a scanned copy where Claude left VAT off the rent lines (amounts and start dates right).
- **The D16 flag fired 0 times** on these runs: with the fee lines, Claude no longer gives a schedule that the value check refuses.
- **New problems the change created:**
  1. A charge stated in words (an insurance levy of 1.5%, copy charges "R0.19 / R1.45 per copy") is recorded as a `{ text }` fee next to the lines. A text fee has no charge name, so the merge falls back to the ordinary rules and the fee is flagged as a conflict: 4 of 12 runs of C4 or C5 (scan C5 twice, watermark C5 once, demo C4 once). Flagged, not silent, but a false alarm. Proposal: allow `{ text, what }` beside lines.
  2. A rate card (C5 Schedule A) is now recorded as seven lines where the answer key expects the words "Rates per Schedule A". The seven lines are correct amounts. Counted as wrong by the key (5 of 12 runs of C5); one run recorded only 3 of the 7 rows, which is a real incomplete reading with no flag.
- Answer-key gaps (proposals, not changed): C5 and C4 keys do not list rate-card or copy-charge lines; the scorer compares VAT strictly when Claude leaves it out.

## D18–D22 live result (30 Sep 2026): categories, required fields, VAT status, charges in words

Third set of live recordings (the D17 set is in git history at commit ad02a6e). New in force: categories with required renewal, notice and end date (D18/D19), the confirm flag for "not applied" categories, `{ text, what }` beside fee lines (D21), VAT status required on every amount line and the C5 rate card and C4 copy charges accepted as lines in the keys (D22). The answer keys now include the category, so 137 field answers per run (121 + 16); "of 121" below excludes the category. Claude used 456,357 input and 78,037 output tokens; 0 LlamaParse credits.

| Per run | Run 1 | Run 2 | Run 3 |
| --- | --- | --- | --- |
| Fields correct (of 137) | 129 | 131 | 130 |
| Same, without the category (of 121) | 113 | 115 | 114 |
| Grounding | 256/256 | 257/257 | 253/253 |
| Highlights on the expected quote | 153/156 | 155/158 | 153/156 |
| Unexpected flags | 8 | 7 | 5 |

- **Category: 48/48 right** (16 agreements × 3 runs). No agreement was classified into a "not applied" category, so the confirm flag did not fire on the eval set (it is tested in the unit tests).
- **Required fields:** the scanned C4's renewal and notice, "not stated" in 3 of 3 runs, are now flagged every time (before, they were silent). The courier agreement C5's three unstated fields are flagged as expected. A required field with no wording at all is flagged too. An end date worked out from start and term is not flagged.
- **VAT:** no amount line came back without a VAT status; the `not_stated` answer was used for the C3 fee and the C4 copy charges.
- **Fee accuracy 42/48 (87.5%),** fee change 28/30.

**Silent errors (wrong or incomplete, green chip, no flag on the field): 3 / 1 / 3 per run.**

- The C4 copy charges recorded as one line of words ("Mono R0.19 · colour R1.45 per copy") instead of two amount lines: 5 of 9 C4 runs. The amounts are visible but not structured, so the fee is compared wrong. (Not a wrong number.)
- The C1 fee change shown as "8% each anniversary" instead of the three steps: 2 of 9 C1 runs (run 1 watermark, run 3 scan). Cause: Claude named the rent lines "rent (year 1)", "rent (year 2)", "rent (year 3)". The merge groups by the charge name, so they became three charges with one date each, not one charge with three steps. The amounts and dates are right; the fee change is not derived and the register would show three rents.

Other flags worth knowing: the D16 flag fired once (demo C4, run 2: the rental line was refused and only the copy charges were recorded, so the fee was flagged instead of silently wrong). One new random miss: demo C1 deposit in run 1, "value not found in cited text", flagged.

### D23 rule tested on the recordings (not built)

"Possibly incomplete": for a recorded fee, take each text row (line) of the cited section; if the row holds a Rand amount and none of the row's amounts is in any recorded amount line or the deposit, flag "possibly incomplete: R… is not in any fee line". A row that already holds a recorded amount is treated as covered (this stops the table's "Rate / m²" column from being flagged). On the D17 recordings: 44 fee fields checked, 8 flagged, all 8 real (7 C4 copy charges left out, 1 C5 rate card with only 3 of 7 rows), 0 false. On the D18 recordings: 48 checked, 5 flagged, all 5 real (the C4 copy charges as words), 0 false. Judging the whole cited block instead of the row falsely flagged 9 C1 lease rows (the "Rate / m²" column) in every set.

## D24–D25 live result (30 Sep 2026): possibly-incomplete flag, charge names without period qualifiers

Fourth set of live recordings (the D18–D22 set is in git history at commit 7c8ceed). New in force: the "possibly incomplete" flag with the row rule (D24), charge names that ignore bracketed period qualifiers such as "(year 1)" and "(months 13–24)", and "one name per charge" in the prompt (D25). 137 field answers per run. Claude used 459,429 input and 78,072 output tokens; 0 LlamaParse credits.

| Per run | Run 1 | Run 2 | Run 3 |
| --- | --- | --- | --- |
| Fields correct (of 137) | 130 | 131 | 130 |
| Same, without the category (of 121) | 114 | 115 | 114 |
| Grounding | 251/251 | 256/256 | 248/248 |
| Highlights on the expected quote | 152/155 | 153/156 | 153/156 |
| Unexpected flags | 10 | 8 | 8 |
| Silent errors (wrong, green chip, no flag on the field) | 0 | 0 | 0 |

- **Every wrong field was flagged** (7, 6 and 7 per run). The C1 lease is now right on fee and fee change in all 9 copy-runs (fee change 30/30). The 8% fee-change error had exactly one cause: Claude named the rent lines "rent (year 1)" and so on in 2 of the 9 C1 runs of the previous set, so the merge saw three charges; with the qualifiers ignored, the same two recordings derive the three steps.
- **Possibly incomplete fired 8 times in 9 C4 runs, all real** (the copy charges recorded as one line of words, R0.19 and R1.45 in no amount line). The 9th C4 run was flagged by the refused-wording rule. No false flags on the 48 recorded fees.
- The "unexpected" flags are the true gaps the answer keys do not list (the scanned C4's unstated renewal and notice, the C4 possibly-incomplete flags, the C5 "fee change not quantified", the scanned C5 blank).
- Category 48/48 again. Fee 40/48 (83.3%): all 8 misses are the C4 copy charges as words, flagged.
- Remaining limits, unchanged: OCR does not read the C5 blank as a blank (3 of 3 runs); the scanned C4 end date is quoted without its day (value check refuses, flagged); no word positions for text that crosses columns in the L1 sample.
