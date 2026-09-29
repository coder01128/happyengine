// Scores agreement records against a sample's expected.json and boxes.json. Used by eval/contracts/run.ts
// and the contracts unit tests.

import type { IsoDate } from '../../packages/core/src/index.ts';
import type { Box, ParsedDocument } from '../../packages/documents/src/index.ts';
import { dateStatus, sameValue, type AgreementRecord, type CandidateValue, type ContractsPreset, type FieldKey } from '../../packages/contracts/src/index.ts';

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
  fields: { correct: number; total: number; misses: string[] };
  grounding: { grounded: number; total: number; exact: number; fuzzy: number; ambiguous: number; elsewhere: number; valueFailed: number };
  highlights: { ok: number; total: number; misses: string[] };
  flags: { found: number; expected: number; missed: string[]; unexpected: string[] };
  dates: { correct: number; total: number; misses: string[]; unexpected: string[] };
}

export const emptyScore = (): Score => ({
  fields: { correct: 0, total: 0, misses: [] },
  grounding: { grounded: 0, total: 0, exact: 0, fuzzy: 0, ambiguous: 0, elsewhere: 0, valueFailed: 0 },
  highlights: { ok: 0, total: 0, misses: [] },
  flags: { found: 0, expected: 0, missed: [], unexpected: [] },
  dates: { correct: 0, total: 0, misses: [], unexpected: [] },
});

export function addScore(a: Score, b: Score): Score {
  return {
    fields: { correct: a.fields.correct + b.fields.correct, total: a.fields.total + b.fields.total, misses: [...a.fields.misses, ...b.fields.misses] },
    grounding: {
      grounded: a.grounding.grounded + b.grounding.grounded,
      total: a.grounding.total + b.grounding.total,
      exact: a.grounding.exact + b.grounding.exact,
      fuzzy: a.grounding.fuzzy + b.grounding.fuzzy,
      ambiguous: a.grounding.ambiguous + b.grounding.ambiguous,
      elsewhere: a.grounding.elsewhere + b.grounding.elsewhere,
      valueFailed: a.grounding.valueFailed + b.grounding.valueFailed,
    },
    highlights: { ok: a.highlights.ok + b.highlights.ok, total: a.highlights.total + b.highlights.total, misses: [...a.highlights.misses, ...b.highlights.misses] },
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

function unionBox(list: Box[]): Box {
  const x = Math.min(...list.map((b) => b.x));
  const y = Math.min(...list.map((b) => b.y));
  return { x, y, w: Math.max(...list.map((b) => b.x + b.w)) - x, h: Math.max(...list.map((b) => b.y + b.h)) - y };
}

const show = (v: unknown) => (v === undefined ? 'nothing' : JSON.stringify(v));

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
      ok = f?.status === 'recorded' && e.value !== undefined && sameValue(f.value!, e.value);
    }
    if (ok && e.supersedes) {
      ok = !!f?.candidates.some((c) => c.superseded && sameValue(c.value, e.supersedes!.value));
      if (!ok) got = `${show(got)} without the superseded ${show(e.supersedes.value)}`;
    }
    if (ok) s.fields.correct++;
    else s.fields.misses.push(`${ref} ${key}: expected ${show(e.values?.map((v) => v.value) ?? e.value)}, got ${show(got)}`);
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
        s.highlights.total++;
        const page = parsed[c.file]?.pages.find((p) => p.page === c.page);
        const expectedBoxes = ids.flatMap((i) => (boxes[c.file]?.[i] ?? []).filter((b) => b.page === c.page));
        let best = 0;
        if (page && c.grounding.boxes.length) {
          const kx = A4.w / page.width;
          const ky = A4.h / page.height;
          const u = unionBox(c.grounding.boxes);
          const got = { x: u.x * kx, y: u.y * ky, w: u.w * kx, h: u.h * ky };
          best = Math.max(0, ...expectedBoxes.map((b) => iou(got, b)));
        }
        if (best >= 0.5) s.highlights.ok++;
        else s.highlights.misses.push(`${ref} ${key} (${c.file} p.${c.page}${c.clause ? ` ${c.clause}` : ''}): IoU ${best.toFixed(2)}`);
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
