# Brief 05: Contracts engine — schema, rules, key dates, register, reminders, eval

**Repo:** `happyengine` · **Branch:** `contracts/engine` · **Requires:** briefs 01–04 merged

Read `CLAUDE.md`, `docs/contracts-plan.md`, and `happyai/docs/happy-contracts-demo-brief.md` §2–§4 first.

## Goal

Pure TypeScript in `packages/contracts` that turns parsed pages and an extraction into a register record. No database or network code here: the edge functions (brief 06) and the eval call it.

```
parsed pages + extraction ──▶ ground every quote ──▶ rules ──▶ fields + flags + key dates
register(records, asAt) ──▶ rows, key-date list with statuses, preset searches, reminder draft
```

**The AI states what the documents say. Code decides what is flagged and calculates every date.**

## Part 1: extraction schema and instructions (`src/extraction.ts`)

Export `contractsSchema` (JSON Schema for the tool input) and `contractsInstructions` (text), both passed to the `documents` extractor.

**Per field,** a list of **candidates**. Claude returns one candidate for every place the value is stated, not a merged answer.

```ts
interface Candidate {
  value: FieldValue | 'not_stated' | 'blank';
  quote: string;          // copied character for character from the page
  file: string;           // e.g. "c1-lease.pdf"
  page: number;
  clause?: string;        // as written: "cl. 18.2", "Order form item 4", "Sch. 2"
}
```

Typed values match brief 02's `expected.json`:
- dates ISO; money integer cents
- `notice { amount, unit: 'days' | 'months', before?: 'expiry' | 'renewal' | 'end_of_initial_period' }`
- `renewal { kind: 'option' | 'automatic' | 'month_to_month' | 'none', periodMonths? }`
- `feeChange { kind: 'schedule' | 'percent_escalation' | 'unquantified' | 'none', … }`
- `fee { cents, per, vat } | { text }`

Also a top-level `amendments` list: `{ file, page, clause, quote, targetClause, fieldKeys[] }` for every addendum clause that replaces or changes a clause.

**Instructions must tell Claude to:**

- copy quotes verbatim from inside one `<page>` tag
- report **every** clause that states a field's value, including clauses that disagree, and never pick one
- use `blank` when the document has an unfilled line where the value belongs, and quote the line
- use `not_stated` when the value is absent, and quote the nearest relevant clause
- state only what's written: no computed end dates, no deadlines, no interpretation of enforceability
- mark a fee change with no amount, cap or index as `unquantified`
- list addendum amendments with the clause number they change

## Part 2: build the record (`src/record.ts`)

`buildRecord({ files, parsed, extraction, preset }) → AgreementRecord`

**1. Ground every candidate**
- Call `ground(quote, page, preset.grounding.minScore)` for each candidate.
- Store the result on the candidate: status, score, boxes.

**2. Check the clause label**
- Check the clause label's number (e.g. `18.2`) appears on the same page.
- If it doesn't, keep the page-only chip ("p.3") and set `clauseChecked: false`.
- Not a flag.

**3. Amendments**
- An amendment is applied only when both of these hold:
  - its quote is grounded, and
  - its `targetClause` number appears in an earlier file's parsed text.
- When applied:
  - the addendum candidate becomes current
  - the candidate citing the target clause becomes `superseded`
  - no flag is raised
- Otherwise: an `unclear` review item, "Amendment target not found".
- Test case: C1, Addendum cl. 2 changes 18.2.

**4. Rules** (deterministic, in this order)

| Rule | Condition | Result |
| --- | --- | --- |
| not_verified | A field has no grounded, non-superseded candidate | Field status `not_verified`; review item `not_verified` |
| blank | Current candidate is `blank` **and** its grounded text contains the blank token `⎵` | Status `blank`; review item `blank` |
| blank, unconfirmed | Candidate says `blank` but no `⎵` in the matched text | Treated as not_verified |
| conflict | 2 or more grounded, non-superseded candidates whose normalised values differ | Status `conflict`; review item `conflict` listing every candidate as a source |
| unquantified | `feeChange.kind === 'unquantified'` | Review item `unclear`, "Fee change not quantified" |
| required | A preset `required` field is `not_stated` | Review item `unclear`, "{label} not stated". Default preset: no required fields, which matches the demo |

**5. Derived values** (code, not AI; each keeps the sources it came from)
- `endDate` = `startDate` + `termMonths` − 1 day, when no end date is stated.
- `tags`, which the preset searches use:
  - `auto`: renewal is `automatic` or `month_to_month`
  - `fee-change`: feeChange is anything but `none`
  - `unquantified`
  - `notice`: on notice-type key dates

**6. Key dates** (`addMonths` / `addDays` from `core`)

| Situation | Dates |
| --- | --- |
| End date, renewal `option` or `none` | "Expiry" = endDate |
| End date, renewal `automatic` | "Renewal date" = endDate + 1 day |
| End date, renewal `month_to_month` | "End of initial period" = endDate |
| Notice `before: expiry` | "Renewal notice deadline" (option) or "Notice deadline" = expiry − notice |
| Notice `before: renewal` | "Cancellation deadline" = renewal date − notice |
| Notice `before: end_of_initial_period` | "Termination notice deadline" = end date − notice |
| Notice with no `before` | No deadline date; the notice period is recorded only |
| Any input in conflict, blank, not verified, or under review | Date is `null` with `pending_reason` ("Pending review") |

Every date stores its **derivation**: base date and its source, the rule (`−3 months`), the quoted wording and the notice source. The UI prints it the way the demo does: "Expiry 31 Jan 2027 − 3 calendar months ('not less than three calendar months before expiry', Add. 1 cl. 2) = 31 Oct 2026".

**7. `applyDecisions(record, decisions)`**
- Recomputes after review.
- A conflict decision must carry `chosenValueIndex`. That candidate becomes the current value, and dependent dates are calculated.
- `with_legal` keeps dependent dates pending, with reason "With legal".
- `confirm` is only valid for single-value items. Enforce this and test it.

## Part 3: register and reminders (`src/register.ts`, `src/reminders.ts`)

- **`dateStatus(date, asAt, windows)`** returns one of:
  - `passed` (before asAt)
  - `attention` (0 to `attention` days away)
  - `upcoming` (up to `upcoming` days away)
  - `later`
- **`register(records, asAt, preset)`** returns rows, plus the key-date list sorted by date. Pending dates go last.
- **`presetSearch(id, register, asAt)`** returns the one-line answer and the matching rows. Answers are built from the data ("2 notice deadlines fall on or before 31 Dec 2026"), as in the demo.
  - `datesBefore` uses asAt + `beforeDays`.
  - Passed deadlines are listed separately as "already passed".
- **`reminderDraft(register, asAt, preset)`** fills the preset templates:
  - Includes `attention` and `upcoming` dates only.
  - Passed notice deadlines with a month-to-month continuation get a separate note line, as the demo does for C4.
  - Uses the Rand and date formatting from `core`.

## Part 4: fixtures and tests

- Hand-write `eval/contracts/demo-marula/recorded/extract-perfect.json`: the extraction a perfect extractor would return.
  - Values come from `expected.json`.
  - Quotes are copied from the demo fixture text.
  - It includes the superseded 18.2 candidate, the addendum amendment, C3's two notice candidates and C5's blank.
- Unit tests in `packages/contracts/test/` run `buildRecord` with the committed **pdfjs parse** from brief 04 and `extract-perfect.json`, then assert:
  - every field value and status in `expected.json`
  - exactly the 3 expected review items
  - every key date and status as at 2026-10-14, the demo §4 list
  - `applyDecisions`: choosing C3's cl. 9.1 candidate un-pends its notice (30 days, no fixed deadline, because there's no `before`)
  - the reminder draft contains C1 31 Oct, C4 31 Oct and C2 31 Dec, excludes Later and Passed dates, and has the C4 note line
  - changing asAt changes the draft with no other change
- Rule tests with small synthetic inputs: a quote not found; a fuzzy match just below the threshold; a conflict between two identical values after normalisation, which is **not** a conflict; an amendment whose target clause is missing.

## Part 5: eval runner (`eval/contracts/run.ts`, `npm run eval:contracts`)

**Options:**
- `--parser fixture|pdfjs|llamaparse`
- `--tier cost_effective|agentic`
- `--extractor fixture:<name>|claude`
- `--reparse`
- `--record`
- `--repeat N`
- `[sample]`

**Rules:**
- **Parse once.** Reuse the saved parse in `parsed/<parser>-<tier>/` unless `--reparse` is given. A LlamaParse run costs credits only the first time.
- **Recording.** `--record` saves Claude's output to `recorded/extract-<model>.json` so it can be replayed free with `--extractor fixture:extract-<model>`.
- **Offshore guard.** Live adapters run only when the sample's `sample.json` has `"synthetic": true`. Add it to both demo samples. For any other sample the runner refuses, unless `--allow-offshore` is passed, and prints why: real documents need the POPIA gates first.

**Report, as plain numbers per sample and in total:**
- fields correct / total (typed comparison), listing each miss
- grounding match rate: grounded quotes / all quotes
- highlight accuracy: sources whose boxes overlap the expected `data-field` box with IoU ≥ 0.5 / all sources
- flags: expected found / expected, plus unexpected flags
- key dates correct (value and status) / total
- cost: LlamaParse credits estimate and Claude input/output tokens
- with `--repeat N`: fields that changed between runs (Claude variance)

Exit code 1 on any wrong field, missed flag or wrong date, as Month-End's eval does.

## Acceptance checks

- [ ] `npm test` passes, including the contracts tests above.
- [ ] `npm run eval:contracts -- --parser pdfjs --extractor fixture:extract-perfect demo-marula` gives 100% on fields, flags and dates, and prints the grounding and highlight numbers.
- [ ] `npm run typecheck` prints nothing. The Month-End eval is unchanged.
- [ ] If `ANTHROPIC_API_KEY` and `ANTHROPIC_MODEL` are set, run `--extractor claude --record --repeat 3` on `demo-marula`, commit the recording, and report the numbers. If not, say it wasn't run.
- [ ] One commit: "Add Contracts engine: schema, rules, key dates, register, reminders, eval".

## Report back with

The eval output (copy the TOTAL lines), the test count, and any rule in this brief that the fixture data contradicted.
