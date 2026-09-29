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
| `supabase/migrations/` | Database: organisations, memberships, runs, engine output, review state, append-only timeline, storage bucket. Row-level security on every table |
| `supabase/functions/` | `run-matching` (upload → engine → stored in one transaction) and `approve-run` (re-checks with the engine, approves only at R0.00) |
| `scripts/smoke.ts` | End-to-end check against the local stack, including organisation isolation |

## Local Supabase

Runs in Docker Desktop next to n8n. Needs the Docker CLI on PATH (`C:\Users\mrbra\AppData\Local\Programs\DockerDesktop\resources\bin`).

```
supabase start -x realtime,imgproxy,logflare,vector,supavisor
```
Starts the stack. Ends with a table of URLs; Studio (the database browser) is at http://127.0.0.1:54323.

```
supabase functions serve
```
Serves the edge functions. Leave it running in its own terminal.

```
npm run smoke
```
Runs the end-to-end check. Ends with `All checks passed`. It creates throwaway organisations and test users and deletes them at the end.

```
supabase db reset
```
Rebuilds the local database from the migrations (wipes local data).

```
supabase stop
```
Stops the stack. Data is kept until `supabase db reset`.

Who can do what:

| Role | Can |
| --- | --- |
| uploader | Start runs, upload documents, run matching |
| reviewer | All of the above, record decisions, approve journals, approve the reconciliation |
| admin | Same as reviewer (organisation settings come later) |

Organisations, presets and memberships are created by happyai (service role) during onboarding. Deleting an organisation deletes all its rows, including its timeline; its storage files must be removed first (see `cleanup()` in `scripts/smoke.ts`).

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
