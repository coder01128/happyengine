# Brief 06: Contracts backend — edge functions, decisions, reminders, smoke

**Repo:** `happyengine` · **Branch:** `contracts/backend` · **Requires:** briefs 01–05 merged

Read `CLAUDE.md` and the existing `run-matching` / `approve-run` functions first. Follow their patterns for auth, roles, errors and one-transaction writes through `private.*` SQL functions.

## Goal

Three edge functions and their SQL functions, so an uploaded agreement moves from files to register record, a reviewer can decide flagged items, and a reminder draft can be approved or held. **Nothing is ever sent.**

## Adapter selection (`supabase/functions/_shared/contracts-adapters.ts`)

- **Env vars.**
  - `PARSER=fixture|pdfjs|llamaparse`, default `fixture`. `pdfjs` only if brief 04 found it runs in Deno.
  - `EXTRACTOR=fixture|claude`, default `fixture`.
- **Pure selector.** `chooseAdapters(env, org)` is a pure function with unit tests. It returns the live adapters only when `org.offshore_processing_approved` is true. Otherwise it throws `OffshoreNotApproved`, whose message is shown to the user: "This organisation isn't approved for cloud processing yet."
- **Fixture adapters.** They read their saved JSON from storage at `<org_id>/<agreement_id>/_fixtures/<filename>.parsed.json` and `…/_fixtures/extract.json`. The smoke script puts them there with the service role. That keeps the edge code free of eval paths.

## Function 1: `contracts-process` — `POST { agreementId, retry? }`

Advances **one step per call** and returns the new status. The app calls it again every 3 seconds while the status is `parsing` or `extracting`. Edge functions have a wall-clock limit, so no call waits on a long LlamaParse job.

| From | Step | To |
| --- | --- | --- |
| `uploaded` | Check page count ≤ `preset.parser.maxPagesPerAgreement`; submit each file to the parser (tier = `scannedTier` if `agreements.scanned`, else `tier`); store the job ids | `parsing` |
| `parsing` | Fetch each pending file's result. Any still pending: return `parsing`. All done: store `parsed_pages` | `parsed` (then continue in the same call) |
| `parsed` | Run the extractor on all pages; run `buildRecord`; store fields, key dates and review items in **one transaction** (`private.store_contract_record`) | `ready` (no review items) or `flagged` |
| any | On error: store a plain-language `error` | `failed` |
| `failed` + `retry: true` | Clear the parse and extraction output; keep the files | `uploaded` |

- **Roles.** `uploader`, `reviewer` or `admin`.
- **Preset snapshot.** Store the preset used in `agreements.preset_snapshot` at the first step, so later preset edits never change an existing record (as Month-End does).
- **Timeline events,** each with its details:
  - `agreement_uploaded`
  - `parse_submitted` (parser, tier, pages, credits estimate)
  - `parsed`
  - `extracted` (model, tokens, fields recorded)
  - `flagged` (count)
  - `processing_failed` (error)
- **Idempotent.** Two overlapping calls must not submit twice. Use a status check-and-set in SQL (`update … where status = 'uploaded' returning`).

## Function 2: `contracts-decide` — `POST { agreementId, reviewItemId, optionId, chosenValueIndex?, note?, reviewVersion }`

- **Role.** `reviewer` or `admin`.
- **Stale screens.** Refuse if `reviewVersion` differs from the stored one, and tell the user to reload, following the `approve-run` pattern.
- **Validation.** Load the record, apply all decisions including this one with `applyDecisions` (brief 05), and store the result in one transaction (`private.record_contract_decision`):
  - the decision
  - the updated fields and key dates
  - `review_version + 1`
  - the agreement status: `with_legal` if any item went to legal, otherwise `reviewed` once every item is decided
- **Engine rules surface here.** `confirm` is refused on conflicts, and conflicts must carry `chosenValueIndex`. Return the engine's message.
- **Timeline:** `decision_recorded` (item, option, chosen source).

## Function 3: `contracts-reminders` — `POST { action, draftId?, body? }`

- **`draft`.** Builds the draft with `reminderDraft` as at `todayInZone()`, from every agreement in the organisation, and stores it in `reminder_drafts` as `draft`. Role: `reviewer` or `admin`.
- **Test date override.** `draft` accepts an optional `asAt` **only** when env `ALLOW_AS_AT_OVERRIDE=true`, which is set in local development only and never in production. Brief 07's `?asAt=` test uses it. Refuse it otherwise.
- **`approve` / `hold`.** Stores the edited `body` and the new status. The body can be edited by hand before approving.
  - Timeline: `reminders_approved` / `reminders_held`.
  - Approving **does not send anything**. Put a code comment at the top of the function saying so, and include no email or WhatsApp code.
- **Later, not now:** a daily scheduled draft.

## SQL (new migration `…_contracts_functions.sql`)

- `private.store_contract_record`, `private.record_contract_decision`, `private.store_reminder_draft`, `private.decide_reminder_draft`, plus thin public wrappers only the service role can call. Copy the Month-End pattern.
- A member can **read** `parsed_pages`. Word data is needed by the source viewer.
- A trigger or check keeps `agreements.status` moving only through the transitions in the table above.

## Smoke test (`scripts/smoke.ts`, new Contracts section)

Using the sample organisation (approved) and fixture adapters:

1. Create an agreement for each of C1–C5.
2. Upload the demo PDFs, plus the pdfjs parse and `extract-perfect.json` into `_fixtures/`.
3. Call `contracts-process` until each is `ready` or `flagged`. Check:
   - C1 and C4 are `ready`; C2, C3 and C5 are `flagged`
   - 3 review items in total
   - the key dates match brief 02's table as values (status depends on today)
4. Decide C3 by choosing cl. 9.1. Check its notice date is no longer pending and `review_version` went up.
5. Send a stale `reviewVersion`. It's refused.
6. `confirm` on C3's conflict. It's refused.
7. Create a reminder draft and approve it with an edited body. Check the timeline has every event in order.
8. **Gate test.** For the unapproved organisation, `chooseAdapters` with `PARSER=llamaparse` throws `OffshoreNotApproved`. Unit test, not a live call.
9. **Isolation.** A member of the other organisation can't read or call any of this for org A's agreements.

## Acceptance checks

- [ ] `supabase db reset` applies cleanly.
- [ ] `npm test`, `npm run typecheck` and both evals pass, with Month-End unchanged.
- [ ] `npm run smoke`: `All checks passed`, including the Contracts section.
- [ ] If LlamaParse and Anthropic keys are in `supabase/functions/.env` and `PARSER=llamaparse EXTRACTOR=claude`: process `c2-subscription.pdf` for the sample organisation and report the status reached. Otherwise say it wasn't run.
- [ ] One commit: "Add Contracts backend: process, decide, reminders".

## Report back with

The smoke output, each function's worst-case run time per call as measured locally, and anything that didn't fit the one-step-per-call design.
