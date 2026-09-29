# LlamaParse: what live runs showed (and the docs don't say)

Observed 29–30 Sep 2026 on the EU region, with made-up documents only. Anything here that the docs also say is marked. Re-check after a LlamaParse release: pin a dated version first (see "Versions").

## Coordinates

- **Origin and units:** top-left origin, PDF points. `page_width` × `page_height` equal the PDF's own point size (595.28 × 841.89 for A4), and for a `/Rotate 90` page they are already the rotated (landscape) size with upright words and no `r`. The docs say only "page units" and "unrotated rectangle"; this is measured.
- **Digital pages** (portrait, landscape, `/Rotate 90`, agentic tier): every known word within 0.63% of the page. Boxes are glyph-tight (about 10 pt high for a 14 pt font) and sit about 1 pt lower than an em box.
- **Picture-only pages (OCR): x is compressed.** Across 1,667 words on the five scanned sample contracts, x positions are scaled by 0.9895 against the same words on the digital PDFs (up to about 6 pt off at the right margin, roughly one word). y is exact (0.9998). On the synthetic picture page in `eval/fixtures/coords.pdf` the factor is 0.979 and boxes are also about 15% too wide. Cause unknown; ask LlamaIndex. Until then, do not promise a 1% highlight tolerance on scans.

## The sidecar (`result_content_metadata.grounded_items`)

- **Span offsets are UTF-8 byte offsets**, not characters. `·` is span `[2,4]`. Any non-ASCII character (`·`, `—`, curly quotes) shifts every later word if read as characters. Converted in `byteToIndex`.
- **Table cell spans count from the start of the cell's own text**, not from the table's markdown. The table item also carries `rows` (the cell texts). Cells are placed in the markdown by `tableCells`.
- **Words can be listed twice.** On a `/Rotate 90` page some words came back as two separate items at the same place. An item whose words are all covered by another item's is dropped.
- The presigned URL works without an auth header and is temporary; the raw JSONL is stored at once.

## Job response (`GET /api/v2/parse/{id}?expand=items,metadata,usage`)

- `expand=items,metadata,usage` is accepted.
- **Credits:** `job.usage.credits` (15 for a 5-page contract at `cost_effective`, 3 per page). Granular word boxes add nothing. Without the `usage` expand the field is absent.
- **Version:** the response reports no parser version (`metadata` holds `pages` and an empty `document`; `job_metadata` is null). The docs' "inspect `metadata.version`" does not hold.
- `metadata.pages[]` has `confidence`, `original_orientation_angle`, `cost_optimized`, `triggered_auto_mode` per page.

## Versions

A request with an invalid `version` is rejected with the list of valid dates for that tier. For `cost_effective` on 29 Sep 2026: 2026-03-25, 03-27, 03-31, 04-09, 05-28, 06-05, 06-08, 06-11, 06-17, 06-18, 06-26, 07-23, 08-08, 08-11, 08-19, 09-28. We send `latest`, which cannot be read back. To make eval runs repeatable, pin a dated version.

## Cost seen

| Run | Pages | Tier | Credits |
| --- | --- | --- | --- |
| c2-subscription.pdf (end to end) | 5 | cost_effective | 15 |
| Digital sample set | 25 | cost_effective | 75 |
| Scanned sample set | 25 | agentic | 250 |
| coords.pdf | 4 | agentic | 40 |
