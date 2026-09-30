// The record's sources, in the shape a source viewer draws. Pure: no React, no PDF.

import type { ViewerSource } from '../../documents/src/index.ts';
import type { AgreementRecord, FieldKey, RecordCandidate, Source } from './types.ts';

function stateOf(s: Source): ViewerSource['state'] {
  if (s.grounding.status === 'ambiguous') return 'ambiguous';
  if (s.grounding.status === 'not_found') return 'not_found';
  return s.valueCheck === 'failed' ? 'value_mismatch' : 'found';
}

function reasonOf(s: Source): string | undefined {
  const g = s.grounding;
  if (g.status === 'ambiguous') return 'The quoted wording appears in more than one place.';
  if (g.status === 'not_found') return g.note === 'page could not be read for positions' ? 'The page could not be read for positions.' : 'The quoted wording was not found on this page.';
  if (s.valueCheck === 'failed') return 'The value is not in the quoted wording.';
  return undefined;
}

/** One source as the viewer draws it. `scanned`: the file is a scan, so its highlights are approximate. */
export function viewerSource(s: Source, label: string, opts: { id: string; scanned?: boolean; supersededBy?: string }): ViewerSource {
  const g = s.grounding;
  const located = g.status === 'grounded';
  return {
    id: opts.id,
    file: s.file,
    page: s.page,
    ...(s.claimedPage !== undefined ? { claimedPage: s.claimedPage } : {}),
    ...(s.clause ? { clause: s.clause } : {}),
    clauseChecked: s.clauseChecked,
    label,
    quote: s.quote,
    state: stateOf(s),
    ...(reasonOf(s) ? { reason: reasonOf(s)! } : {}),
    fractions: located ? g.fractions ?? [] : [],
    ...(located && g.more?.length ? { more: g.more.map((m) => ({ page: m.page, fractions: m.fractions })) } : {}),
    ...(opts.scanned ? { approximate: true } : {}),
    ...(opts.supersededBy ? { supersededBy: opts.supersededBy } : {}),
  };
}

/** Every candidate source of one field, in the record's order (current one first is left to the caller). */
export function fieldViewerSources(record: AgreementRecord, key: FieldKey, opts: { scanned?: (file: string) => boolean } = {}): ViewerSource[] {
  const field = record.fields[key];
  if (!field) return [];
  return field.candidates.map((c: RecordCandidate, i) =>
    viewerSource(c, field.label, {
      id: `${record.id}:${key}:${i}`,
      scanned: opts.scanned?.(c.file),
      supersededBy: c.superseded ? c.superseded.clause ?? `${c.superseded.file} p.${c.superseded.page}` : undefined,
    }),
  );
}
