# happyengine — instructions for Claude Code

The shared engine behind the happyai "Happy" services. Month-End is built. Contracts is next, then Onboarding and Invoicing. Each service is a **preset** (settings as data) on shared code, not a separate app.

Before planning or writing code, read `docs/engine-architecture.md` (a copy of the `happy-pipeline-engine` skill; use the skill instead if it's installed and newer). It covers the architecture, the parser layer, the POPIA rules and the build order.

UI and behaviour specs live in the `happyai` repo: `demo-<service>.html` and `docs/happy-<service>-demo-brief.md`.

## Do not read these (token cost and secrets)

Never open, list or search inside:

- `node_modules/` and `app/node_modules/`
- `dist/` and `app/dist/`
- `supabase/.temp/`
- `package-lock.json`
- `.local/`
- `.env`, `.env.*`, `app/.env.local`

These are blocked in `.claude/settings.json` for the Read, Grep and Glob tools. Bash commands aren't covered by that block, so:

- Don't run recursive listings (`ls -R`, `tree`, `dir /s`, or `find` without excluding the folders above).
- To find files, use the Glob and Grep tools. They skip everything in `.gitignore`.

## Layout

| Path | What | Shared? |
| --- | --- | --- |
| `packages/core/` (`@happy/core`) | Money and dates: integer cents, `R12 450.00` formatting, UTC date-only arithmetic (days, calendar months), today in Johannesburg | Shared by every service |
| `packages/month-end/` (`@happy/month-end`) | Month-End: CSV/OFX ingest, matching Rules 1–6, splits, reconciliation, approval gate | Month-End only |
| `packages/contracts/` (`@happy/contracts`) | Contracts engine: preset, extraction schema and instructions, `buildRecord` (grounding, amendments, rules, key dates), `applyDecisions`, register, preset searches, reminder draft | Contracts only |
| `packages/documents/` (`@happy/documents`) | Parser adapters (fixture, LlamaParse; local PDF.js at `src/parsers/pdfjs.ts`, Node only), Claude extractor, quote check (grounding), offshore guard | Shared by document services |
| `supabase/migrations/…_core.sql`, `…_storage.sql` | Organisations, memberships, roles, RLS helpers, append-only timeline, private documents bucket | Shared |
| `supabase/migrations/…_month_end.sql`, `…_split_suggestions.sql` | presets, runs, documents, lines, matches, exceptions, journals, decisions, checklist | Month-End (the presets table is shared) |
| `supabase/migrations/…_contracts.sql` | agreements, agreement_files, parsed_pages, agreement_fields, key_dates, review_items, reminder_drafts; `orgs.offshore_processing_approved`; `timeline_events.agreement_id` | Contracts (the org flag is shared) |
| `supabase/functions/_shared/http.ts` | Auth, role checks, JSON helpers for edge functions | Shared |
| `supabase/functions/_shared/core.ts`, `month-end.ts` | The single place edge functions import package code from | Shared |
| `app/src/supabase.ts`, `components/Modal.tsx`, `components/ui.tsx`, `pages/SignIn.tsx`, `styles.css` | App shell | Shared |
| `app/src/` (the rest) | Month-End screens | Month-End only |
| `eval/<service>/` | Test set per service. Real client data is git-ignored | Per service |

**Happy Contracts** is built here, not in the separate `happycontracts` repo. Plan: `docs/contracts-plan.md`. Briefs: `docs/briefs/02`–`07`, one per session, in order. Never start a brief whose predecessors aren't merged.


## Boundaries

- Code moves into `packages/core` only when a second service actually needs it. Don't build general-purpose abstractions ahead of time.
- A service package never imports another service package. Services share code only through `core` and `documents`.
- Inside `packages/`, import other packages by **relative path to their `src/index.ts`**, not by package name. The Supabase edge runtime (Deno) doesn't resolve npm workspace names.
- Edge functions import engine code only through files in `supabase/functions/_shared/`.

## Non-negotiable rules

- AI extracts; deterministic code decides pass or flag; a person approves every outcome. Nothing is posted, paid, sent or approved automatically.
- Wording: "flagged for review", "ready for approval". Never "verified", "compliant" or "approved" as something the system decided.
- Money in integer cents. Dates are UTC date-only.
- Every table has `org_id` and row-level security. The timeline is append-only.
- Never edit a migration that has been applied. Add a new migration.
- Real client documents never go in git and never go through any offshore service (LlamaParse, Claude API) until the POPIA gates in `docs/engine-architecture.md` are signed off.
- UI:
  - text contrast at least 4.5:1 and text at least 13px, badges included
  - status shown by colour plus a text label
  - modals centred (never bottom sheets), with a focus trap and Esc to close
  - dropdown options alphabetical
  - works at 360px width
- Deploy by `git push` only. Never run Vercel CLI commands.

## Checks (run all before reporting done)

| Command | Expected |
| --- | --- |
| `npm test` | `Tests  N passed (N)`, with no failures |
| `npm run typecheck` | Prints nothing |
| `npm run eval` | Same TOTAL line as before the change |
| `npm run smoke` | `All checks passed`. Needs `supabase start` and `supabase functions serve` running |

A change that lowers eval accuracy does not ship.

## Reporting to Brad

- Brad doesn't read or debug code. Report results as plain numbers ("74/74 tests passed, eval unchanged"), never "looks good".
- Any command he has to run: Windows syntax, one literal command per line, where to type it, and what should appear on screen afterwards.
