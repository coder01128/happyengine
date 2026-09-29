# Brief 01: split `packages/engine` into `core` and `month-end`

**Repo:** `happyengine` · **Branch:** `refactor/split-core` · **Type:** a move with no change in behaviour

Read `CLAUDE.md` first, and follow its "Do not read" list.

## Goal

Contracts (next service) needs money and dates, but none of the Month-End matching code. Split the one package into:

- **`packages/core`** (`@happy/core`): shared by every service
- **`packages/month-end`** (`@happy/month-end`): everything that's Month-End only

**Nothing behaves differently afterwards.** Same test count, same eval output, same smoke result, same screens.

## Out of scope — do not touch

- **Any SQL.** No migration is added, edited or renamed. Widening `presets.service` belongs to the Contracts brief.
- **Any logic.** No renamed functions, no new abstractions, no "while I'm here" fixes. If you spot a bug, list it in the report and leave it.
- **Test assertions.** Tests move files; their contents don't change, except import paths.
- **`dates.ts` features.** Calendar-month subtraction is for the Contracts brief.
- **The `happycontracts` repo.**
- **App screens and styles.** Only import lines change.

## Step 0: record the baseline (before changing anything)

1. `git switch -c refactor/split-core`
2. Run `npm test` and note the passed count. The README says 74; use whatever it actually prints.
3. Run `npm run typecheck`. It should print nothing.
4. Run `npm run eval` and save the full output to `.local/eval-before.txt`. `.local/` is git-ignored.
5. If the local stack is running, run `npm run smoke` and note the result. If it isn't, say so in the report; don't start Docker yourself.

If any of steps 2–4 fail before you've changed anything, stop and report. Don't fix it as part of this brief.

## Step 1: the split

| File | Goes to |
| --- | --- |
| `money.ts`, `dates.ts` | `packages/core/src/` |
| `types.ts`, `preset.ts`, `refs.ts`, `match.ts`, `split.ts`, `reconcile.ts`, `review.ts`, `rows.ts`, `ingest/csv.ts`, `ingest/ofx.ts` | `packages/month-end/src/` |

- **Package files.** Each package gets `package.json` (copy the shape of the current one: `private`, `type: module`, `exports: { ".": "./src/index.ts" }`) and `src/index.ts`.
- **Core exports.** `core/src/index.ts` exports only money and dates.
- **Month-end exports.** `month-end/src/index.ts` exports only its own files. It **does not** re-export core, so the boundary stays visible.
- **Month-end → core imports.** Month-end files import money and dates by **relative path**: `../../core/src/index.ts` (from `ingest/`, `../../../core/src/index.ts`). Not `@happy/core`. The edge runtime (Deno) can't resolve workspace names.
- **Move with git.** Use `git mv` so file history is kept.
- **Old package.** Delete `packages/engine` once it's empty.

**Tests.** Move each test next to the code it covers:

- `marula.test.ts`, `rule5.test.ts` and `split.test.ts` go to `packages/month-end/test/`.
- `units.test.ts`: if it tests only money and dates, it goes to `packages/core/test/`. If it mixes, split it into `core/test/units.test.ts` and `month-end/test/units.test.ts`. Move each `it`/`test` block unchanged.
- The total test count must equal the baseline.

## Step 2: update the importers

- **Edge functions.** In `supabase/functions/_shared/`:
  - replace `engine.ts` with `core.ts` (re-exports `packages/core/src/index.ts`) and `month-end.ts` (re-exports `packages/month-end/src/index.ts`)
  - update the imports in `run-matching/index.ts` and `approve-run/index.ts`
- **Eval.** `eval/run.ts` imports from the two new package paths.
- **App.** In `app/package.json`, swap `@happy/engine` for `@happy/core` and `@happy/month-end`. Then update imports in `DraftPanel.tsx`, `Exceptions.tsx`, `labels.ts`, `RunReview.tsx` and `Runs.tsx`: `formatRand`, `formatDate` and `parseAmount` come from core, everything else from month-end.
- **Install.** Run `npm install` so the workspace links update. Don't add or upgrade any dependency.
- **Config.** Root `tsconfig.json` already includes `packages/*/src` and `packages/*/test`, so no change should be needed. Confirm it.

## Step 3: docs

- `README.md`: update the Layout table rows for `packages/`.
- `CLAUDE.md`: update the Layout table to match the new structure, and remove the "Planned layout" note for `core` and `month-end` (keep the lines for `documents` and `contracts` as later).

## Acceptance checks (all must pass)

- [ ] `npm test`: same passed count as the baseline, 0 failed.
- [ ] `npm run typecheck`: prints nothing.
- [ ] `npm run eval`: save to `.local/eval-after.txt` and compare with `.local/eval-before.txt`. **No differences.**
- [ ] `npm run smoke`: `All checks passed` (if the stack was running at baseline).
- [ ] `npm run app`: the review screen loads, sign-in works, and a seeded run opens with its exceptions and reconciliation panel.
- [ ] Nothing in `packages/core` imports from `packages/month-end`. Check with Grep.
- [ ] Nothing imports `@happy/engine` or `packages/engine` anywhere. Check with Grep, which skips `node_modules`.
- [ ] `git diff --stat main` shows no `.sql` files and no test assertion changes.
- [ ] One commit on `refactor/split-core`: "Split engine into core and month-end packages (no behaviour change)". Don't merge or push.

## Report back with

- Baseline and after numbers: tests, eval TOTAL line, smoke.
- The eval comparison result ("no differences", or the exact lines that differ).
- Files moved, and files edited beyond import lines (there should be none except the docs, `package.json` files and `_shared/`).
- Anything you couldn't do exactly as written, and why.
- Any bugs noticed but not fixed.
