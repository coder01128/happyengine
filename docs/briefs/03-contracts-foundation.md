# Brief 03: Contracts foundation — dates, preset, database

**Repo:** `happyengine` · **Branch:** `contracts/foundation` · **Requires:** briefs 01 and 02 merged

Read `CLAUDE.md` and `docs/contracts-plan.md` first.

## Goal

Lay the groundwork the Contracts pipeline sits on, with no AI and no parser yet:

1. Month-based date maths in `core`.
2. The Contracts preset (type and default JSON).
3. New database tables with row-level security, plus the offshore-processing gate.

## Out of scope

- Parser, extraction, edge functions, app screens (briefs 04–07).
- **No edits to existing migrations.** Everything is a new migration file.
- No Month-End behaviour changes.

## Part 1: dates (`packages/core/src/dates.ts`)

Add these, all UTC date-only, with unit tests in `packages/core/test/`:

- `addDays(d, n)`: n may be negative.
- `addMonths(d, n)`: calendar months, **clamped to the month end** (2026-01-31 + 1 month = 2026-02-28; 2027-01-31 − 3 months = 2026-10-31).
- `todayInZone(zone = 'Africa/Johannesburg')`: today's calendar date in that zone as an `IsoDate`. The only function allowed to read the clock. Everything else takes dates as arguments.

Tests must include every date in the demo brief's §4 `console.assert` list and in `expected.json` from brief 02:

- 2027-01-31 − 3 months = 2026-10-31
- 2027-03-01 − 60 days = 2026-12-31
- 2026-10-31 − 3 months = 2026-07-31
- 2026-03-01 + 12 months − 1 day = 2027-02-28
- leap years: 2024-02-29 + 12 months = 2025-02-28

## Part 2: preset

Create `packages/contracts/` (`@happy/contracts`) with `src/preset.ts` and `src/index.ts`. It imports `core` by relative path (see `CLAUDE.md`).

```ts
export interface ContractsPreset {
  service: 'Happy Contracts';
  version: number;
  parser: { tier: 'cost_effective' | 'agentic' | 'agentic_plus'; scannedTier: 'agentic' | 'agentic_plus'; maxPagesPerAgreement: number };
  grounding: { minScore: number };               // fuzzy match threshold, 0–1
  fields: { key: string; label: string; required: boolean }[];   // display order in the register
  alertWindows: { attention: number; upcoming: number };          // days
  reviewOptions: { id: string; label: string; outcome: 'reviewed' | 'with_legal'; singleValueOnly: boolean }[];
  presetSearches: { id: string; question: string; kind: 'fieldTag' | 'datesBefore' | 'review'; tag?: string; beforeDays?: number }[];
  reminders: { to: string; subject: string; intro: string; item: string; outro: string; empty: string };
}
```

Write `presets/contracts.default.json` from the demo:

- **Parser:** tier `cost_effective`, scannedTier `agentic`, max 60 pages. Grounding minScore 0.9.
- **Fields,** in this order: counterparty, agreementType, premises, startDate, endDate, termMonths, renewal, notice, fee, feeChange, deposit, scope.
- **Alert windows:** 30 / 90.
- **Review options:** the demo's three, **sorted alphabetically by label**.
- **Preset searches:** the demo's four. "Notice deadlines on or before…" uses `beforeDays: 90` from today, not a fixed date.
- **Reminder templates:** copied from the demo `FIXTURE.reminders`.

Add `validateContractsPreset()` that throws a clear error for a missing or invalid setting, following the Month-End `validatePreset` pattern. Test it with the default preset and two broken copies.

## Part 3: database (new migration `…_contracts.sql`)

Follow the patterns in the existing migrations exactly:

- `org_id` on every table
- composite foreign keys `(id, org_id)`
- RLS through `private.is_member` / `private.has_role`
- explicit grants
- engine output written only through `private.*` functions called by the service role

**Changes to shared tables:**

- `presets.service`: widen the check to `('contracts', 'month_end')`.
- `orgs`: add `offshore_processing_approved boolean not null default false`. Only the service role can change it. Add a comment on the column: "Set by happyai only after the POPIA template pack and the client's consent are in place."
- `timeline_events`: add a nullable `agreement_id uuid` with a foreign key `(agreement_id, org_id)` to `agreements`. Add a check that `run_id` and `agreement_id` aren't both set. Adding the column is DDL; the append-only triggers stay as they are.

**New tables:**

| Table | Key columns |
| --- | --- |
| `agreements` | `org_id`, `preset_id`, `preset_snapshot jsonb`, `title`, `status` (enum below), `scanned boolean` (set at upload: uses `scannedTier`), `error text`, `review_version int`, `created_by`, timestamps |
| `agreement_files` | `agreement_id`, `org_id`, `ord int` (1 = main agreement, 2+ = addenda in date order), `role` (`main` / `addendum`), `storage_path` (must start `<org_id>/<agreement_id>/`), `filename`, `page_count`, `parse_job_id`, `parse_status`, `parser`, `parser_tier`, `parsed_at` |
| `parsed_pages` | `file_id`, `org_id`, `page int`, `width`, `height`, `text`, `words jsonb`. Written only by the service role |
| `agreement_fields` | `agreement_id`, `org_id`, `key`, `values jsonb` (one or more candidate values, each with its sources and grounding result), `status` (`recorded` / `not_stated` / `blank` / `conflict` / `not_verified`), `tags text[]` |
| `key_dates` | `agreement_id`, `org_id`, `key`, `label`, `date date` (null when pending), `derivation jsonb` (base, rule, wording, sources), `pending_reason text` |
| `review_items` | `agreement_id`, `org_id`, `kind` (`blank` / `conflict` / `not_verified` / `unclear`), `field_key`, `summary`, `sources jsonb`, `option_id`, `chosen_value_index int`, `note`, `decided_by`, `decided_at` |
| `reminder_drafts` | `org_id`, `as_at date`, `body text`, `status` (`draft` / `approved` / `held`), `decided_by`, `decided_at`, `created_at` |

**Agreement status enum:** `uploaded`, `parsing`, `parsed`, `extracting`, `ready`, `flagged`, `reviewed`, `with_legal`, `failed`.

**RLS and grants:**

- Members **read** all rows of their organisation.
- `uploader`, `reviewer` and `admin` can **insert** `agreements` and `agreement_files`, and **delete** an agreement while its status is `uploaded` or `failed`.
- Everything else is written by `private.*` functions (added in brief 06). For now, create the tables only.
- Storage reuses the `documents` bucket and its policies. Paths are `<org_id>/<agreement_id>/<file>`.

**Deletion:** deleting an organisation deletes all its Contracts rows (cascade), matching Month-End.

## Part 4: seed and smoke

- `scripts/seed-local.ts`: add a Contracts preset (from `presets/contracts.default.json`) to the sample organisation, and set `offshore_processing_approved = true` on it, with a comment that it holds only synthetic sample data.
- Add a **second** sample organisation, "Unapproved Org (sample)", with the flag left `false`. Brief 06's smoke test uses it to prove the gate works.
- `scripts/smoke.ts`: add organisation-isolation checks for every new table. A member of org A can't read org B's agreements, files, pages, fields, dates, review items or reminder drafts. A client can't set `offshore_processing_approved`.

## Acceptance checks

- [ ] `supabase db reset` applies all migrations with no errors.
- [ ] `npm test`: all previous tests plus the new date and preset tests pass.
- [ ] `npm run typecheck` prints nothing.
- [ ] `npm run eval`: Month-End TOTAL line unchanged.
- [ ] `npm run smoke`: `All checks passed`, including the new isolation checks.
- [ ] `npm run seed -- --reset` works. Both sample organisations exist, with the flag true and false respectively.
- [ ] `git diff main --stat` shows no edits to existing migration files.
- [ ] One commit: "Add Contracts foundation: month dates, preset, tables".

## Report back with

The new test count, the smoke result, and the list of tables and policies added.
