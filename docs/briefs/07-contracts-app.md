# Brief 07: Contracts screens, including the PDF source viewer

**Repo:** `happyengine` · **Branch:** `contracts/app` · **Requires:** briefs 01–06 merged

Read `CLAUDE.md` first. The spec for the look and behaviour is `happyai/demo-contracts.html` (open it in a browser and click through all 4 steps) and `happyai/docs/happy-contracts-demo-brief.md` §2–§3. Reuse the app's existing components (`Modal`, `ui.tsx`, `styles.css`, `DraftPanel` pattern) before writing new ones.

## Goal

The demo's register, key dates, review and reminders, working on real stored data, with highlights drawn over the actual PDF page.

## Out of scope

- No backend changes. If a screen needs data the backend doesn't give, stop and list it in the report.
- No Month-End screen changes, except the shared header.
- No free-form "ask a question" chat. Preset searches only, labelled "Preset searches", as in the demo.

## Part 1: service switch and routes

- After sign-in, read the organisation's active presets.
  - If it has both Contracts and Month-End, the header shows a switch (two buttons, alphabetical: Contracts, Month-End).
  - If it has one, show that service with no switch.
- Hash routes:
  - `#/contracts`: register
  - `#/contracts/new`: upload
  - `#/contracts/a/<id>`: one agreement
  - `#/contracts/review`
  - `#/contracts/reminders`
- The existing Month-End routes are unchanged.
- The crumb reads `Contracts · <organisation>`.

## Part 2: upload (`#/contracts/new`)

- **Fields.** Title, and the main agreement PDF (required). Addenda are optional, several allowed, and can be reordered by drag or up/down buttons.
- **Scanned copy.** A "Scanned copy" checkbox, with help text: "Tick this if the signed copy is a scan or photo. It uses the slower, more thorough reading tier."
- **Files.** Maximum file size is the bucket's 20 MB. PDF only in v1; other types are refused with a clear message.
- **Submitting:**
  1. Insert the agreement and files.
  2. Upload to `documents/<org_id>/<agreement_id>/`.
  3. Call `contracts-process`, then poll every 3 seconds while `parsing` or `extracting`.
- **Progress** shows the status in words, e.g. "Reading page positions…" and "Recording terms…". No fake counters or fake typing effects.
- **Errors.**
  - `failed`: show the stored error and a "Try again" button (calls with `retry: true`).
  - `OffshoreNotApproved`: show the function's message as-is.

## Part 3: register (`#/contracts`)

Match the demo's step 3:

- **Top row:**
  - a search box (counterparty, type and any recorded value, case-insensitive)
  - filter chips with live counts (All · Dates need attention · Up for review)
  - 4 "Preset searches" buttons from the preset, using `presetSearch` from `@happy/contracts`
- **Register table** at 640px and wider; stacked row cards below 640px.
  - Columns: counterparty, type, start, end or term, renewal, notice, fee, next key date, status badge.
  - Expanding a row shows every recorded field with its source chips.
  - Superseded values show struck through, with their own chip and the label "Superseded by Add. 1 cl. 2".
- **Key dates panel** beside the table (stacked on mobile).
  - Chronological list, derivation under each date, badges Passed / Needs attention / Upcoming / Later, pending dates last.
  - The window label reads "Alert windows: 30 / 90 days (set per organisation)".
- **Fixed lines:**
  - under the register: **"Dates are calculated from the recorded wording. The signed agreement is the source of truth."**
  - above it: "Register as at <today>"
- **Empty states.**
  - No agreements: an "Add an agreement" button.
  - No search results: "No agreements match" and a "Clear search" button.

## Part 4: source chips and the PDF source viewer

**Chip text.** Every value has a chip like `p.2 · cl. 4.1`, or `p.2` when `clauseChecked` is false. Candidates marked `not_verified` show a chip reading "Not verified — review", in the attention colour with the text label.

**Clicking a chip** opens a centred `Modal` (focus trap, Esc closes, focus returns to the chip):
- **Rendering.** The PDF page is rendered with `pdfjs-dist` from a signed Storage URL, which expires after 5 minutes. Refresh it on reopen.
- **Highlights.** Draw the stored boxes as semi-transparent rectangles over the page. Scale each box by `box.x / page.width × renderedWidth`, and the same for `y`, `w` and `h` against height. Use the `width` and `height` stored in `parsed_pages`.
- **Scroll.** Scroll the first box into view.
- **Header:** file name · page n of N · clause · the quoted wording. The quote sits in the header as text, so it's readable without the highlight.
- **Navigation.** Previous and next page buttons. Several sources for one value (C3's conflict) show as tabs, one per source.
- **Fallback.** If boxes are empty (not verified), render the page with no highlight and a notice: "The quoted wording wasn't found on this page. Check the page before relying on this value."

Test highlight position visually against the demo PDFs. Screenshot C1 cl. 4.1 and C3 Sch. 1 item 4 with boxes drawn at 100% zoom and at 360px width, and attach both to the report.

## Part 5: review (`#/contracts/review`)

Match the demo's step 4 left card, over all flagged agreements:

- Each item shows the quoted wording with source chips.
- A `<select>` of the preset's review options, alphabetical.
- An optional note field.
- **Conflicts:** radio buttons to choose which clause's value to record. The select stays disabled until a clause is chosen, and "Confirm recorded value" isn't offered for conflicts.
- **Saving:** "Save" per item calls `contracts-decide` with the current `review_version`. After saving, badges update to Reviewed or With legal. A version mismatch shows "This agreement changed since you opened it. Reload to see the latest." with a reload button.
- Only `reviewer` and `admin` see the controls. `uploader` sees a read-only list.

## Part 6: reminders (`#/contracts/reminders`)

- "Prepare reminders" calls `contracts-reminders` `draft`.
- **Draft.** An editable textarea addressed to the preset's `to`. Label it **"Date reminders prepared (internal, not sent)"**.
- **Buttons:**
  - "Approve reminders" shows the toast "Recorded as approved. Nothing was sent."
  - "Hold" records the hold.
- Past drafts are listed with their status, who decided, and when.

## Part 7: agreement page and timeline

- `#/contracts/a/<id>` shows the files, all fields with chips, the key dates with derivations, its review items, and its timeline.
- Timeline events use plain wording, e.g. "Pages read: 7 pages, cost-effective tier" and "Terms recorded: 11 fields, 1 flagged for review".
- Deleting is available only while the status is `uploaded` or `failed`, and needs a confirmation modal.

## Rules (from `CLAUDE.md`, all checked)

- Contrast at least 4.5:1 and text at least 13px, both themes, chips and badges included.
- Status shown by colour plus a text label.
- Modals centred; dropdowns alphabetical.
- Works at 360px with no horizontal scroll.
- Keyboard-only: the whole flow can be completed.
- `prefers-reduced-motion` respected.
- Wording: "flagged for review", "recorded". Never "verified", "compliant" or "approved" as something the system decided.

## Acceptance checks

- [ ] Seed with `npm run seed -- --reset`. Upload C1–C5 through the UI using fixture adapters. The register matches the demo's step 3 content: rows, flags, key dates and derivations.
- [ ] Every chip opens the right PDF page, with the box over the right wording. Attach both screenshots.
- [ ] Each preset search returns the agreements the demo brief §3 lists.
- [ ] Search for "coastal", "renew" and "R32 000" returns sensible matches.
- [ ] C3 needs a clause choice before saving. After saving, its notice date un-pends.
- [ ] The reminder draft contains C1 31 Oct, C4 31 Oct and C2 31 Dec when today is set to 14 Oct 2026 (dev-only `?asAt=2026-10-14` override, local builds only), and excludes Later and Passed dates.
- [ ] Every rule in the Rules section passes: 360px, keyboard only, both themes, reduced motion.
- [ ] Month-End screens work as before. `npm test`, `npm run typecheck`, both evals and `npm run smoke` all pass.
- [ ] One commit: "Add Contracts screens and PDF source viewer".

## Report back with

Screenshots of the register, the source viewer (two), the review card and the reminders card. List anything the demo does that this build doesn't, and why.
