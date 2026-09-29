# happyengine

The shared engine behind the Happy services. The first service is **Happy Month-End**: matching a bank statement against a cash book, listing exceptions, and gating approval on an unexplained difference of R0.00. A person approves every outcome. Nothing is posted.

Behaviour and UI spec: `happyai/docs/happy-month-end-demo-brief.md` and `happyai/demo-month-end.html`.

## Layout

| Path | What |
| --- | --- |
| `packages/engine/src/` | Pure TypeScript: money (integer cents), dates (UTC date-only), CSV/OFX ingest, matching Rules 1–5, reconciliation panel, review/approval gate |
| `packages/engine/test/` | Unit tests. `marula.test.ts` is the demo brief's fixture and verified arithmetic; `rule5.test.ts` covers suggestions |
| `presets/month-end.default.json` | Default Month-End preset: column mappings, matching settings, journal labels, resolution options, close checklist |
| `eval/month-end/<sample>/` | Test set: one folder per real month (see below) |
| `eval/run.ts` | Runs every sample and prints plain numbers |
| `eval/synth/generate.ts` | Generates the synthetic `synth-*` samples (clean, narrative, messy) with their true answers |

## Matching rules

| Rule | Condition | Outcome |
| --- | --- | --- |
| 1 | Same amount, date and reference | Matched |
| 2 | Same amount and reference, dates within `dateToleranceDays` (3) | Matched |
| 3 | Same reference, different amount | Flagged: amount difference |
| 4 | Unmatched cash book entry with the same reference, amount and date as another | Flagged: possible duplicate |
| 5 | Same amount, dates within `suggestionWindowDays` (7), exactly one candidate each way; references missing or different | **Suggested only**: a person confirms or rejects. Rejecting needs a note and leaves the difference open |

Anything left is a timing item (cash book entry within `timingWindowDays` of period end), not in the cash book (bank line → proposed journal), or not on the statement (older cash book entry → review). Known gap: one deposit settling several invoices is not matched yet.

## Commands (Windows, from `C:\ccode\git-repos\happyengine`)

```
npm install
```
Installs dev tools. Ends with `found 0 vulnerabilities`.

```
npm test
```
Runs the unit tests. Ends with `Tests  60 passed (60)`.

```
npm run eval
```
Runs the test set. Prints each sample, a TOTAL line, and a table of true matches by kind (auto / suggested / missed).

```
npm run synth
```
Regenerates the synthetic samples. Same seeds, same files. Prints one line per sample.

```
npm run typecheck
```
Checks types. Prints nothing when everything is fine.

## Adding a real sample to the test set

Real client data is **git-ignored** (only `demo-marula` and the synthetic `synth-*` samples are committed). Anonymise it or get permission first.

Create `eval/month-end/<name>/` with:

- `bank.csv` (or `bank.ofx`): the statement export exactly as the bank gives it
- `ledger.csv`: the cash book export from the accounting package
- `sample.json`: period end, opening balances in cents, and column names if they differ from the default preset:
  ```json
  {
    "periodEnd": "2026-08-31",
    "opening": { "bank": 18425000, "ledger": 18425000 },
    "sources": {
      "bank": { "dateFormat": "YYYY-MM-DD", "date": "Posting Date", "description": "Narrative", "amount": "Amount" }
    }
  }
  ```
- `expected.json`: the correct answer, marked by hand. Statement rows are `s1, s2, …` and cash book rows are `l1, l2, …`, numbered in file order and skipping header and total rows. Copy the shape from `demo-marula/expected.json`.

Then run `npm run eval -- <name>` for that sample alone. Missed and wrong results are listed line by line.
