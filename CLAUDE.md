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
| `packages/engine/src/money.ts`, `dates.ts` | Integer cents, `R12 450.00` formatting, UTC date-only arithmetic | Shared by every service |
| `packages/engine/src/` (the rest) | Month-End: CSV/OFX ingest, matching Rules 1–6, splits, reconciliation, approval gate | Month-End only |
| `supabase/migrations/…_core.sql`, `…_storage.sql` | Organisations, memberships, roles, RLS helpers, append-only timeline, private documents bucket | Shared |
| `supabase/migrations/…_month_end.sql`, `…_split_suggestions.sql` | presets, runs, documents, lines, matches, exceptions, journals, decisions, checklist | Month-End (the presets table is meant to be shared) |
| `supabase/functions/_shared/http.ts` | Auth, role checks, JSON helpers for edge functions | Shared |
| `supabase/functions/_shared/engine.ts` | The single place edge functions import engine code from | Shared |
| `app/src/supabase.ts`, `components/Modal.tsx`, `components/ui.tsx`, `pages/SignIn.tsx`, `styles.css` | App shell | Shared |
| `app/src/` (the rest) | Month-End screens | Month-End only |
| `eval/<service>/` | Test set per service. Real client data is git-ignored | Per service |

**Planned layout.** See `docs/briefs/01-split-core.md`; update this table once that brief is done.

**Happy Contracts** is built here, not in the separate `happycontracts` repo. Plan: `docs/contracts-plan.md`. Briefs: `docs/briefs/02`–`07`, one per session, in order. Never start a brief whose predecessors aren't merged.

```
packages/core        money, dates (shared)
packages/month-end   everything Month-End
packages/documents   later: LlamaParse adapter, Claude extraction, quote check
packages/contracts   later
```

## Boundaries

- Code moves into `packages/core` only when a second service actually needs it. Don't build general-purpose abstractions ahead of time.
- A service package never imports another service package. Services share code only through `core` (and later `documents`).
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
