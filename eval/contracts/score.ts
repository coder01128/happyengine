// Scores agreement records against a sample's expected.json and boxes.json. Used by eval/contracts/run.ts
// and the contracts unit tests.

import type { IsoDate } from '../../packages/core/src/index.ts';
import { chipText, type Box, type ParsedDocument } from '../../packages/documents/src/index.ts';
import { dateStatus, feeLinesOf, sameValue, type AgreementRecord, type CandidateValue, type ContractsPreset, type FieldKey } from '../../packages/contracts/src/index.ts';

interface ExpectedSource { value: CandidateValue; source: string[]; also?: string[] }
export interface ExpectedField extends Partial<ExpectedSource> {
  values?: ExpectedSource[];
  supersedes?: ExpectedSource;
  derived?: string;
}
export interface ExpectedAgreement {
  fields: Partial<Record<FieldKey, ExpectedField>>;
  flags: { kind: string; field: string; about: string }[];
  dates: { key: string; label: string; value: string; derivation: string; status: string | null }[];
}
export interface Expected {
  asAt: IsoDate;
  agreements: Record<string, ExpectedAgreement>;
}
export type Boxes = Record<string, Record<string, (Box & { page: number })[]>>;

export interface Score {
  fields: { correct: number; total: number; misses: string[]; byField: Record<string, { correct: number; total: number }> };
  grounding: { grounded: number; total: number; exact: number; fuzzy: number; ambiguous: number; elsewhere: number; valueFailed: number };
  /** Only sources cited at a place the answer key lists for the field are scored. ok: the box overlaps the expected box (IoU ≥ 0.5) or lies inside it. iouOk: overlap alone, the older rule. unlisted: sources cited somewhere the key doesn't list (not scored). */
  highlights: { ok: number; iouOk: number; total: number; unlisted: number; misses: string[] };
  flags: { found: number; expected: number; missed: string[]; unexpected: string[] };
  dates: { correct: number; total: number; misses: string[]; unexpected: string[] };
}

export const emptyScore = (): Score => ({
  fields: { correct: 0, total: 0, misses: [], byField: {} },
  grounding: { grounded: 0, total: 0, exact: 0, fuzzy: 0, ambiguous: 0, elsewhere: 0, valueFailed: 0 },
  highlights: { ok: 0, iouOk: 0, total: 0, unlisted: 0, misses: [] },
  flags: { found: 0, expected: 0, missed: [], unexpected: [] },
  dates: { correct: 0, total: 0, misses: [], unexpected: [] },
});

export function addScore(a: Score, b: Score): Score {
  return {
    fields: {
      correct: a.fields.correct + b.fields.correct,
      total: a.fields.total + b.fields.total,
      misses: [...a.fields.misses, ...b.fields.misses],
      byField: Object.fromEntries(
        [...new Set([...Object.keys(a.fields.byField), ...Object.keys(b.fields.byField)])].map((k) => [
          k,
          { correct: (a.fields.byField[k]?.correct ?? 0) + (b.fields.byField[k]?.correct ?? 0), total: (a.fields.byField[k]?.total ?? 0) + (b.fields.byField[k]?.total ?? 0) },
        ]),
      ),
    },
    grounding: {
      grounded: a.grounding.grounded + b.grounding.grounded,
      total: a.grounding.total + b.grounding.total,
      exact: a.grounding.exact + b.grounding.exact,
      fuzzy: a.grounding.fuzzy + b.grounding.fuzzy,
      ambiguous: a.grounding.ambiguous + b.grounding.ambiguous,
      elsewhere: a.grounding.elsewhere + b.grounding.elsewhere,
      valueFailed: a.grounding.valueFailed + b.grounding.valueFailed,
    },
    highlights: {
      ok: a.highlights.ok + b.highlights.ok,
      iouOk: a.highlights.iouOk + b.highlights.iouOk,
      total: a.highlights.total + b.highlights.total,
      unlisted: a.highlights.unlisted + b.highlights.unlisted,
      misses: [...a.highlights.misses, ...b.highlights.misses],
    },
    flags: {
      found: a.flags.found + b.flags.found,
      expected: a.flags.expected + b.flags.expected,
      missed: [...a.flags.missed, ...b.flags.missed],
      unexpected: [...a.flags.unexpected, ...b.flags.unexpected],
    },
    dates: {
      correct: a.dates.correct + b.dates.correct,
      total: a.dates.total + b.dates.total,
      misses: [...a.dates.misses, ...b.dates.misses],
      unexpected: [...a.dates.unexpected, ...b.dates.unexpected],
    },
  };
}

/** expected.json says "needs_attention"; the engine says "attention". */
const STATUS: Record<string, string> = { needs_attention: 'attention' };

/** boxes.json was measured on an A4 page of 595.28 × 841.89 points. */
const A4 = { w: 595.28, h: 841.89 };

function iou(a: Box, b: Box): number {
  const x = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const y = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const inter = x * y;
  const union = a.w * a.h + b.w * b.h - inter;
  return union > 0 ? inter / union : 0;
}

/** How much of box a lies inside box b, 0–1. */
function inside(a: Box, b: Box): number {
  const x = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const y = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  return a.w * a.h > 0 ? (x * y) / (a.w * a.h) : 0;
}

/** Why a field is not what was expected, in a phrase: what the rules did with the candidates the extractor gave. */
function whyField(record: AgreementRecord, key: FieldKey): string {
  const f = record.fields[key];
  if (!f) return 'the extractor gave no candidate for this field';
  const item = record.reviewItems.find((i) => i.fieldKey === key);
  const cited = f.candidates.map((c) => `${chipText(c)}`).join(', ');
  if (f.status === 'not_verified') return `flagged: ${item?.summary.replace(/^[^:]+: /, '') ?? 'source not verified'} (cited ${cited})`;
  if (f.status === 'conflict') return `flagged as a conflict between ${cited}`;
  if (f.status === 'not_stated') return `extractor said not stated${cited ? ` (cited ${cited})` : ''}`;
  if (f.status === 'blank') return `recorded as a blank line (cited ${cited})`;
  return `recorded from ${f.candidates[f.current ?? 0] ? chipText(f.candidates[f.current ?? 0]!) : 'a cited clause'}`;
}

function unionBox(list: Box[]): Box {
  const x = Math.min(...list.map((b) => b.x));
  const y = Math.min(...list.map((b) => b.y));
  return { x, y, w: Math.max(...list.map((b) => b.x + b.w)) - x, h: Math.max(...list.map((b) => b.y + b.h)) - y };
}

const show = (v: unknown) => (v === undefined ? 'nothing' : JSON.stringify(v));

const wordsOf = (t: string) => t.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
const isText = (v: unknown): v is { text: string } => !!v && typeof v === 'object' && typeof (v as { text?: unknown }).text === 'string' && Object.keys(v).every((k) => k === 'text' || k === 'what');

/**
 * Whether a recorded value is the expected one. Free-text values ({ text }) are worded differently on every run,
 * so they match when every word of the expected text is in the recorded text. Everything else must be equal.
 */
export function sameAnswer(got: CandidateValue, expected: CandidateValue): boolean {
  if (isText(got) && isText(expected)) {
    const have = new Set(wordsOf(got.text));
    return wordsOf(expected.text).every((w) => have.has(w));
  }
  return sameValue(got, expected);
}

const unitOf = (p: string) => (/month/i.test(p) ? 'month' : /year|annum/i.test(p) ? 'year' : p.trim().toLowerCase());
/** "kg" and "kg over 5 kg" are the same unit: one contains the other. */
const sameUnit = (a: string, b: string) => { const x = unitOf(a); const y = unitOf(b); return x === y || x.includes(y) || y.includes(x); };

/**
 * A fee is right when it has the same amount lines (in any order): the amount, VAT status (excluding, including or not
 * stated; a line with none is wrong), start date and unit. What a charge is called is free text and is not compared, and
 * charges in words are left out. A free-text answer key is compared loosely.
 */
export function sameFee(got: CandidateValue, expected: CandidateValue): boolean {
  const g = feeLinesOf(got);
  const e = feeLinesOf(expected);
  if (!g.length && !e.length) return sameAnswer(got, expected);
  if (g.length !== e.length) return false;
  const used = new Set<number>();
  return e.every((x) => {
    const at = g.findIndex((y, i) => !used.has(i) && y.cents === x.cents && (y.vat ?? '') === (x.vat ?? '') && (y.from ?? '') === (x.from ?? '') && sameUnit(y.per, x.per));
    if (at < 0) return false;
    used.add(at);
    return true;
  });
}

export function scoreAgreement(
  id: string,
  record: AgreementRecord,
  exp: ExpectedAgreement,
  asAt: IsoDate,
  preset: ContractsPreset,
  parsed: Record<string, ParsedDocument>,
  boxes?: Boxes,
): Score {
  const s = emptyScore();
  const ref = id.toUpperCase();

  // Fields: typed comparison.
  for (const [key, e] of Object.entries(exp.fields) as [FieldKey, ExpectedField][]) {
    s.fields.total++;
    const bf = (s.fields.byField[key] ??= { correct: 0, total: 0 });
    bf.total++;
    const f = record.fields[key];
    let ok: boolean;
    let got: unknown = f ? (f.status === 'recorded' ? f.value : f.status) : undefined;
    if (e.values) {
      const vals = f?.status === 'conflict' ? f.candidates.filter((c) => !c.superseded && c.grounding.status === 'grounded').map((c) => c.value) : [];
      got = f?.status === 'conflict' ? vals : got;
      ok = f?.status === 'conflict' && vals.length === e.values.length && e.values.every((x) => vals.some((v) => sameValue(v, x.value)));
    } else if (e.value === 'not_stated' || e.value === 'blank') {
      ok = f?.status === e.value;
    } else {
      ok = f?.status === 'recorded' && e.value !== undefined && (key === 'fee' ? sameFee : sameAnswer)(f.value!, e.value);
    }
    if (ok && e.supersedes) {
      ok = !!f?.candidates.some((c) => c.superseded && sameValue(c.value, e.supersedes!.value));
      if (!ok) got = `${show(got)} without the superseded ${show(e.supersedes.value)}`;
    }
    if (ok) {
      s.fields.correct++;
      bf.correct++;
    } else s.fields.misses.push(`${ref} ${key}: expected ${show(e.values?.map((v) => v.value) ?? e.value)}, got ${show(got)} — ${whyField(record, key)}`);
  }

  // Grounding: every quote the extractor gave, amendments included.
  const candidates = Object.values(record.fields).flatMap((f) => f?.candidates ?? []);
  const gs = [...candidates.map((c) => c.grounding), ...record.amendments.map((a) => a.grounding)];
  s.grounding.total = gs.length;
  s.grounding.grounded = gs.filter((g) => g.status === 'grounded').length;
  s.grounding.exact = gs.filter((g) => g.status === 'grounded' && g.match === 'exact').length;
  s.grounding.fuzzy = gs.filter((g) => g.status === 'grounded' && g.match === 'fuzzy').length;
  s.grounding.ambiguous = gs.filter((g) => g.status === 'ambiguous').length;
  s.grounding.elsewhere = gs.filter((g) => g.status === 'grounded' && g.claimedPage !== undefined).length;
  s.grounding.valueFailed = candidates.filter((c) => c.valueCheck === 'failed').length;

  // Highlights: each source of an expected field overlaps one of its expected data-field boxes.
  if (boxes) {
    for (const [key, e] of Object.entries(exp.fields) as [FieldKey, ExpectedField][]) {
      const ids = [...(e.source ?? []), ...(e.also ?? []), ...(e.supersedes?.source ?? []), ...(e.values ?? []).flatMap((v) => v.source)];
      for (const c of record.fields[key]?.candidates ?? []) {
        const page = parsed[c.file]?.pages.find((p) => p.page === c.page);
        const expectedBoxes = ids.flatMap((i) => (boxes[c.file]?.[i] ?? []).filter((b) => b.page === c.page));
        // A clause the answer key doesn't list for this field can't be judged either way: counted apart, not as a miss.
        if (!expectedBoxes.length) {
          s.highlights.unlisted++;
          continue;
        }
        s.highlights.total++;
        let best = 0;
        let within = 0;
        if (page && c.grounding.boxes.length) {
          const kx = A4.w / page.width;
          const ky = A4.h / page.height;
          const u = unionBox(c.grounding.boxes);
          const got = { x: u.x * kx, y: u.y * ky, w: u.w * kx, h: u.h * ky };
          best = Math.max(0, ...expectedBoxes.map((b) => iou(got, b)));
          within = Math.max(0, ...expectedBoxes.map((b) => inside(got, b)));
        }
        // A hit: the box overlaps the expected box, or lies inside it. (The reference boxes are padded round the
        // clause, so a tight box round the right words can score low on overlap alone.)
        if (best >= 0.5) s.highlights.iouOk++;
        if (best >= 0.5 || within >= 0.9) s.highlights.ok++;
        else {
          const where = `${ref} ${key} (${c.file} p.${c.page}${c.clause ? ` ${c.clause}` : ''})`;
          const why = !c.grounding.boxes.length
            ? `no highlight: ${c.grounding.status === 'ambiguous' ? 'quote appears in more than one place' : c.grounding.unpositioned ? 'the quote is on the page but the parser gave no positions for it' : c.grounding.note ?? 'quote not found on its page'}`
            : `box is elsewhere: overlap ${best.toFixed(2)}, inside expected ${Math.round(within * 100)}%${c.grounding.trimmed ? ` (${c.grounding.trimmed} mis-placed word${c.grounding.trimmed > 1 ? 's' : ''} left out)` : ''}`;
          s.highlights.misses.push(`${where}: ${why}`);
        }
      }
    }
  }

  // Flags: kind + field.
  const items = record.reviewItems.map((i) => ({ kind: i.kind, field: i.fieldKey, summary: i.summary }));
  s.flags.expected = exp.flags.length;
  for (const f of exp.flags) {
    const hit = items.findIndex((i) => i.kind === f.kind && i.field === f.field);
    if (hit >= 0) {
      s.flags.found++;
      items.splice(hit, 1);
    } else s.flags.missed.push(`${ref} ${f.kind} on ${f.field} (${f.about})`);
  }
  s.flags.unexpected = items.map((i) => `${ref} ${i.kind} on ${i.field}: ${i.summary}`);

  // Key dates: value and status as at asAt.
  const dates = [...record.keyDates];
  for (const e of exp.dates) {
    s.dates.total++;
    const at = dates.findIndex((d) => d.key === e.key);
    const d = at >= 0 ? dates.splice(at, 1)[0] : undefined;
    const value = d ? d.date ?? 'pending_review' : undefined;
    const status = d?.date ? dateStatus(d.date, asAt, preset.alertWindows) : null;
    const want = e.status === null ? null : STATUS[e.status] ?? e.status;
    if (d && value === e.value && status === want) s.dates.correct++;
    else s.dates.misses.push(`${ref} ${e.label}: expected ${e.value} (${e.status ?? 'pending'}), got ${d ? `${value} (${status ?? d.pendingReason})` : 'no date'}`);
  }
  s.dates.unexpected = dates.map((d) => `${ref} ${d.label} ${d.date ?? d.pendingReason}`);
  return s;
}

export const pct = (n: number, d: number) => (d ? `${Math.round((n / d) * 1000) / 10}%` : '–');

/** True when nothing is wrong: every field, flag and date right, and no unexpected flags or dates. */
export const perfect = (s: Score) =>
  s.fields.correct === s.fields.total &&
  s.flags.found === s.flags.expected &&
  !s.flags.unexpected.length &&
  s.dates.correct === s.dates.total &&
  !s.dates.unexpected.length;
