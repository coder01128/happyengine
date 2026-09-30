// Developer test page for the source viewer (development builds only, no sign-in): #/dev/source-viewer
// Real sample data from eval/: the demo contracts and their scanned copies, run through the real engine
// (grounding, rules) in the browser, so every chip is what the app will show. Nothing here is customer data.

import { useMemo, useState } from 'react';
import { buildRecord, fieldViewerSources, validateContractsPreset, type AgreementRecord, type Extraction, type FieldKey } from '@happy/contracts';
import { FLAG_BADGE, toFraction, type ParsedDocument, type ViewerSource } from '@happy/documents';
import presetJson from '../../../presets/contracts.default.json';
import coordsUrl from '../../../eval/fixtures/coords.pdf?url';
import coordsExpected from '../../../eval/fixtures/coords.expected.json';
import { Badge } from '../components/ui.tsx';
import { SourceChip, SourceViewer, type ViewerDocument } from '../components/SourceViewer.tsx';

const preset = validateContractsPreset(presetJson);

const json = <T,>(g: Record<string, unknown>) => g as Record<string, T>;
const parsedFiles = json<ParsedDocument>(import.meta.glob('../../../eval/contracts/*/parsed/*/*.json', { eager: true, import: 'default' }));
const recorded = json<Record<string, Extraction>>(import.meta.glob('../../../eval/contracts/*/recorded/*.json', { eager: true, import: 'default' }));
const samples = json<{ agreements: { id: string; files: string[] }[] }>(import.meta.glob('../../../eval/contracts/*/sample.json', { eager: true, import: 'default' }));
const pdfUrls = json<string>(import.meta.glob('../../../eval/contracts/*/*.pdf', { eager: true, query: '?url', import: 'default' }));

const at = (folder: string, rest: string) => `../../../eval/contracts/${folder}/${rest}`;

interface Dataset {
  key: string;
  title: string;
  blurb: string;
  scanned: boolean;
  agreements: { id: string; ref: string; record: AgreementRecord }[];
  documents: Record<string, ViewerDocument>;
  extra?: { title: string; source: ViewerSource }[];
}

function documentsFor(folder: string, parseDir: string, files: string[]): { docs: Record<string, ViewerDocument>; parsed: Record<string, ParsedDocument> } {
  const docs: Record<string, ViewerDocument> = {};
  const parsed: Record<string, ParsedDocument> = {};
  for (const file of files) {
    const p = parsedFiles[at(folder, `parsed/${parseDir}/${file.replace(/\.pdf$/i, '.json')}`)];
    if (!p) continue;
    parsed[file] = p;
    const url = pdfUrls[at(folder, file)]!;
    docs[file] = { name: file, load: () => Promise.resolve(url), pages: p.pages.map((pg) => ({ width: pg.width, height: pg.height })) };
  }
  return { docs, parsed };
}

function fromRecorded(folder: string, parseDir: string, recording: string, scanned: boolean, key: string, title: string, blurb: string): Dataset {
  const sample = samples[at(folder, 'sample.json')]!;
  const extraction = recorded[at(folder, `recorded/${recording}.json`)]!;
  const { docs, parsed } = documentsFor(folder, parseDir, sample.agreements.flatMap((a) => a.files));
  return {
    key, title, blurb, scanned, documents: docs,
    agreements: sample.agreements.map((a) => ({
      id: a.id,
      ref: a.id.toUpperCase(),
      record: buildRecord({ id: a.id, ref: a.id.toUpperCase(), files: a.files, parsed: Object.fromEntries(a.files.map((f) => [f, parsed[f]!])), extraction: extraction[a.id] ?? { fields: {}, amendments: [] }, preset }),
    })),
  };
}

const words = (s: string) => s.split(/\s+/).filter(Boolean);

/** Made-up cases on one demo contract: a quote not on its page, on another page, repeated, across a page break, with the wrong value. */
function edgeCases(): Dataset {
  const folder = 'demo-marula';
  const file = 'c2-subscription.pdf';
  const { docs, parsed } = documentsFor(folder, 'pdfjs-local', [file]);
  const doc = parsed[file]!;
  const [p1, p2] = doc.pages;
  const across = `${words(p1!.text).slice(-7).join(' ')} ${words(p2!.text).slice(0, 7).join(' ')}`;
  const cand = (value: unknown, quote: string, clause: string, page: number) => ({ value, quote, file, page, clause }) as never;
  const extraction: Extraction = {
    amendments: [],
    fields: {
      startDate: [cand('2026-03-01', 'Subscription Start Date | 1 March 2026', 'Order form item 3', 3)], // cited on page 3; it is on page 1
      fee: [cand({ cents: 585000, per: 'month' }, 'Subscription Fee R4 850.00 per month, excluding VAT', 'Order form item 5', 1)], // wrong value for a real quote
      scope: [cand('Setup and training', 'The Supplier shall provide setup and training at no charge', 'cl. 9.9', 1)], // not in the document
      premises: [cand('n/a', 'Subscription Start Date', 'Order form item 3', 1)], // the phrase is on page 1 twice
      agreementType: [cand('Software subscription', across, 'p.1–2', 1)], // runs across a page break
    },
  };
  const record = buildRecord({ id: 'edge', ref: 'EDGE', files: [file], parsed: { [file]: doc }, extraction, preset });

  // A box tilted 8 degrees, on the test PDF, to see rotated boxes drawn about their own centre.
  const page1 = coordsExpected.pages[0]!;
  const alpha = page1.words[0]!;
  const tilted: ViewerSource = {
    id: 'rot', file: 'coords.pdf', page: 1, label: 'Rotation test (made-up box, tilted 8°)', clauseChecked: false, quote: alpha.t, state: 'found',
    fractions: [{ ...toFraction(alpha.box, page1), r: 8 }],
  };
  docs['coords.pdf'] = { name: 'coords.pdf', load: () => Promise.resolve(coordsUrl), pages: coordsExpected.pages.map((p) => ({ width: p.width, height: p.height })) };

  return {
    key: 'edge', title: 'Made-up edge cases', scanned: false, documents: docs,
    blurb: 'One demo contract with deliberately awkward citations: a quote cited on the wrong page, a wrong value, a quote that is not in the document, a repeated quote, and a quote that runs across a page break.',
    agreements: [{ id: 'edge', ref: 'EDGE', record }],
    extra: [{ title: 'A box tilted 8° (page rotation test)', source: tilted }],
  };
}

const showValue = (v: unknown): string => {
  if (v === undefined) return '—';
  if (typeof v === 'string') return v === 'not_stated' ? 'Not stated' : v === 'blank' ? 'Blank in the signed copy' : v;
  if (typeof v === 'number') return String(v);
  return Object.entries(v as Record<string, unknown>).map(([k, x]) => `${k}: ${Array.isArray(x) ? x.join(', ') : String(x)}`).join(' · ');
};

/** The flag a field's sources carry, if any (they all carry the same one). */
const flagOfField = (sources: ViewerSource[]) => sources.find((s) => s.flag)?.flag;

/** Fields with something for a person to look at, and why in a word or two. */
function flaggedFields(record: AgreementRecord): { label: string; why: string }[] {
  return preset.fields.flatMap((f) => {
    const field = record.fields[f.key as FieldKey];
    if (!field) return [];
    const sources = fieldViewerSources(record, f.key as FieldKey);
    const flag = flagOfField(sources);
    if (flag) return [{ label: f.label, why: flag === 'blank' ? 'blank line' : flag }];
    if (field.status === 'not_verified') return [{ label: f.label, why: 'source not verified' }];
    return [];
  });
}

const STATUS: Record<AgreementRecord['status'], { text: string; cls: string }> = {
  ready: { text: 'Ready', cls: 'b-ok' },
  flagged: { text: 'Flagged for review', cls: 'b-inc' },
  reviewed: { text: 'Reviewed', cls: 'b-rev' },
  with_legal: { text: 'With legal', cls: 'b-rev' },
};

export default function DevSourceViewer() {
  const datasets = useMemo(
    () => [
      fromRecorded('demo-marula', 'pdfjs-local', 'extract-perfect', false, 'digital', 'Digital contracts', 'Five demo contracts as digital PDFs, with the answers a perfect extractor gives. Includes a clause replaced by an addendum (C1) and a conflict with two sources (C3).'),
      fromRecorded('scan-marula', 'llamaparse-agentic', 'extract-claude-sonnet-5-5', true, 'scanned', 'Scanned copies', 'The same contracts as photographed pages, read by LlamaParse and answered by Claude. Highlights are labelled approximate and padded sideways.'),
      fromRecorded('layout-lakeside', 'llamaparse-cost_effective', 'extract-claude-sonnet-5-5', false, 'layout', 'Two-column contract with a stamp', 'A two-column sub-lease with a red RECEIVED stamp over clause 4.1, read by LlamaParse and answered by Claude. LlamaParse gave no word positions for the second-column part of clause 3 (those chips say “no highlight”), and the stamp confused the position of a word in clause 4.3 (that highlight is marked approximate).'),
      edgeCases(),
    ],
    [],
  );
  const [dataset, setDataset] = useState(datasets[0]!.key);
  const [open, setOpen] = useState<{ sources: ViewerSource[]; id: string; documents: Record<string, ViewerDocument> } | null>(null);
  const ds = datasets.find((d) => d.key === dataset)!;

  const openField = (record: AgreementRecord, key: FieldKey, clicked: ViewerSource) => {
    const sources = fieldViewerSources(record, key, { scanned: () => ds.scanned });
    setOpen({ sources, id: clicked.id, documents: ds.documents });
  };

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">Developer test page · not part of the app</div>
          <h1>Source viewer</h1>
          <p>Click a source chip to open the original page with the wording highlighted. Real sample documents run through the real engine.</p>
        </div>
      </div>

      <div className="chips" role="group" aria-label="Sample data">
        {datasets.map((d) => (
          <button key={d.key} type="button" className="chip" aria-pressed={d.key === dataset} onClick={() => setDataset(d.key)}>
            {d.title}
          </button>
        ))}
      </div>
      <p className="muted small sec-gap" style={{ marginBottom: 16 }}>
        {ds.blurb}
      </p>

      {ds.extra?.map((x) => (
        <section className="card sec-gap" key={x.source.id}>
          <h3>{x.title}</h3>
          <p className="small sec-gap">
            Chip: <SourceChip source={x.source} onOpen={(s) => setOpen({ sources: [s], id: s.id, documents: ds.documents })} />
          </p>
        </section>
      ))}

      {ds.agreements.map(({ id, ref, record }) => (
        <section className="card sec-gap" key={id}>
          <div className="card-head">
            <h3>
              {ref} · {record.files.join(' + ')}
            </h3>
            <Badge text={STATUS[record.status].text} cls={STATUS[record.status].cls} />
          </div>
          {flaggedFields(record).length > 0 && (
            <p className="small sec-gap" style={{ marginTop: 0, marginBottom: 12 }}>
              <strong>Flagged for review:</strong> {flaggedFields(record).map((x) => `${x.label} (${x.why})`).join(', ')}
            </p>
          )}
          <dl style={{ margin: 0 }}>
            {preset.fields.map((f) => {
              const field = record.fields[f.key as FieldKey];
              if (!field) return null;
              const sources = fieldViewerSources(record, f.key as FieldKey, { scanned: () => ds.scanned });
              return (
                <div className="dev-field" key={f.key}>
                  <dt>
                    {f.label}
                    {flagOfField(sources) && (
                      <div>
                        <Badge text={FLAG_BADGE[flagOfField(sources)!]} cls="b-inc" />
                      </div>
                    )}
                  </dt>
                  <dd>
                    {field.candidates.map((c, i) => (
                      <span className="dev-cand" key={i}>
                        <span style={c.superseded ? { textDecoration: 'line-through' } : undefined}>{showValue(c.value)}</span>
                        <SourceChip source={sources[i]!} onOpen={(s) => openField(record, f.key as FieldKey, s)} />
                      </span>
                    ))}
                  </dd>
                </div>
              );
            })}
          </dl>
        </section>
      ))}

      <section className="card sec-gap">
        <h3>What each chip should do</h3>
        <ul className="dev-legend sec-gap">
          <li>“p.2 · cl. 4.1” opens page 2 with that wording highlighted and its label above the box.</li>
          <li>Green chips: source found, nothing to review. Amber chips that end “· conflict”, “· blank line” or “· unclear”: an open review item points at that wording, and the field row shows a badge such as “Conflict — review”.</li>
          <li>“Source not found — review”, “Source unclear — review”: opens the cited page with no highlight and a notice in words.</li>
          <li>“value not in wording — review”: the wording is highlighted, with a warning that the value isn’t in it.</li>
          <li>“Superseded by …” sits after an old clause’s chip; its viewer says the wording no longer applies.</li>
          <li>A value with several sources (a conflict, or a clause and its replacement) opens with one tab per source.</li>
        </ul>
      </section>

      {open && <SourceViewer sources={open.sources} documents={open.documents} initialId={open.id} onClose={() => setOpen(null)} />}
    </>
  );
}
