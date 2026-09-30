// The source viewer: a chip that opens a centred dialog showing the original PDF (or image) page with the quoted
// wording highlighted. Boxes arrive as 0–1 page fractions and are only ever set as CSS percentages.
// Engine code, not Contracts code: it knows ViewerSource, not agreements.

import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { chipLabel, chipText, FLAG_BADGE, firstRegion, highlightRegions, type Region, type ViewerSource } from '@happy/documents';
import { Modal } from './Modal.tsx';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

const ZOOMS = [1, 1.5, 2, 3];

/** A file the viewer can show. `load` returns a fresh URL each time (a signed URL that expires in minutes). */
export interface ViewerDocument {
  name: string;
  load: () => Promise<string>;
  /** Page sizes in points, from the parser: the aspect ratio is set from these before anything is drawn, so scroll positions stay put. */
  pages: { width: number; height: number }[];
  isImage?: boolean;
}

const DocIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
    <path d="M14 3v5h5M9 13h6M9 17h6" />
  </svg>
);

/** The chip after a value. Found: a page and clause. Otherwise the words say what to do, not only the colour. */
export function SourceChip({ source, onOpen }: { source: ViewerSource; onOpen: (s: ViewerSource) => void }) {
  const label = chipLabel(source);
  return (
    <>
      <button
        type="button"
        className={`src${source.state !== 'found' ? ' src-review' : source.flag ? ' src-flag' : ''}`}
        onClick={() => onOpen(source)}
        aria-label={`${label}, source for ${source.label}`}
      >
        <DocIcon />
        {label}
      </button>
      {source.supersededBy && <span className="src-note">Superseded by {source.supersededBy}</span>}
    </>
  );
}

// ---------------------------------------------------------------------------

function usePdf(doc: ViewerDocument | undefined) {
  const [state, setState] = useState<{ pdf?: pdfjs.PDFDocumentProxy; url?: string; error?: string }>({});
  useEffect(() => {
    setState({});
    if (!doc) return;
    let cancelled = false;
    let task: pdfjs.PDFDocumentLoadingTask | undefined;
    (async () => {
      try {
        const url = await doc.load();
        if (cancelled) return;
        if (doc.isImage) return setState({ url });
        task = pdfjs.getDocument({ url });
        const pdf = await task.promise;
        if (!cancelled) setState({ pdf, url });
      } catch {
        if (!cancelled) setState({ error: 'The document could not be opened. Try again, or open the original agreement.' });
      }
    })();
    return () => {
      cancelled = true;
      void task?.destroy();
    };
  }, [doc]);
  return state;
}

/** Pages of one document, drawn lazily. Highlights are absolutely positioned percentages over each page. */
function PageStack({ doc, source, regions, zoom, onPage }: { doc: ViewerDocument; source: ViewerSource; regions: Region[]; zoom: number; onPage: (n: number) => void }) {
  const { pdf, url, error } = usePdf(doc);
  const scroller = useRef<HTMLDivElement>(null);
  const canvases = useRef(new Map<number, HTMLCanvasElement>());
  const drawn = useRef(new Map<number, number>()); // page → width it was drawn at
  const firstHl = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const target = useMemo(() => firstRegion(regions)?.page ?? source.claimedPage ?? source.page, [regions, source]);
  const [visible, setVisible] = useState<Set<number>>(() => new Set([target - 1, target, target + 1, ...regions.map((r) => r.page)]));

  // The width the pages are drawn at follows the dialog.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(Math.max(0, Math.min(820, el.clientWidth - 24) * zoom)));
    ro.observe(el);
    return () => ro.disconnect();
  }, [zoom]);

  // Pages near the viewport are drawn; the target page always is.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        setVisible((prev) => {
          const next = new Set(prev);
          for (const e of entries) if (e.isIntersecting) next.add(Number((e.target as HTMLElement).dataset.page));
          return next.size === prev.size ? prev : next;
        });
      },
      { root: el, rootMargin: '700px 0px' },
    );
    el.querySelectorAll('[data-page]').forEach((p) => io.observe(p));
    return () => io.disconnect();
  }, [doc]);

  // Draw a page: canvas size = layout width × device pixel ratio, so text is sharp.
  useEffect(() => {
    if (!pdf || !width) return;
    let cancelled = false;
    const tasks: pdfjs.RenderTask[] = [];
    (async () => {
      const order = [...visible].filter((n) => n >= 1 && n <= pdf.numPages).sort((a, b) => Math.abs(a - target) - Math.abs(b - target));
      for (const n of order) {
        const canvas = canvases.current.get(n);
        if (!canvas || drawn.current.get(n) === width || cancelled) continue;
        const page = await pdf.getPage(n);
        const base = page.getViewport({ scale: 1 });
        const viewport = page.getViewport({ scale: (width / base.width) * (window.devicePixelRatio || 1) });
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        const task = page.render({ canvas, viewport });
        tasks.push(task);
        try {
          await task.promise;
          drawn.current.set(n, width);
        } catch {
          /* cancelled by a resize or by closing */
        }
      }
    })();
    return () => {
      cancelled = true;
      tasks.forEach((t) => t.cancel());
    };
  }, [pdf, width, visible, target]);

  // Bring the highlight into view and move focus to it, so a screen reader announces what was found.
  useEffect(() => {
    const el = scroller.current;
    if (!el || !width) return;
    const first = firstRegion(regions);
    const pageEl = el.querySelector<HTMLElement>(`[data-page="${target}"]`);
    if (!pageEl) return;
    const top = pageEl.offsetTop + (first ? first.box.y * pageEl.clientHeight : 0);
    el.scrollTop = Math.max(0, top - 90);
    el.scrollLeft = Math.max(0, pageEl.offsetLeft + (first ? first.box.x * pageEl.clientWidth : 0) - 40);
    firstHl.current?.focus({ preventScroll: true });
  }, [source.id, width, target, regions]);

  // The page number shown follows the scroll.
  const onScroll = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    let current = 1;
    el.querySelectorAll<HTMLElement>('[data-page]').forEach((p) => {
      if (p.offsetTop - el.scrollTop <= el.clientHeight * 0.4) current = Number(p.dataset.page);
    });
    onPage(current);
  }, [onPage]);

  return (
    <div className="vw-scroll" ref={scroller} onScroll={onScroll} tabIndex={0} role="region" aria-label={`Pages of ${doc.name}`}>
      {error && <p className="err-box">{error}</p>}
      {!error && !pdf && !url && <p className="muted small vw-loading">Opening the document…</p>}
      {doc.pages.map((p, i) => {
        const n = i + 1;
        const mine = regions.filter((r) => r.page === n);
        return (
          <div key={n} className="vw-page" data-page={n} style={{ aspectRatio: `${p.width} / ${p.height}`, width: `${zoom * 100}%`, maxWidth: 820 * zoom }} aria-label={`Page ${n}`}>
            {doc.isImage ? (
              n === 1 && url && <img src={url} alt={`Scan of ${doc.name}`} />
            ) : (
              <canvas ref={(c) => void (c ? canvases.current.set(n, c) : canvases.current.delete(n))} aria-hidden="true" />
            )}
            {mine.map((r, k) => {
              const isFirst = r.page === regions[0]?.page && k === 0;
              return (
                <div
                  key={k}
                  ref={isFirst ? firstHl : undefined}
                  className="vw-hl"
                  role={isFirst ? 'region' : undefined}
                  aria-label={isFirst ? `Highlighted source: ${source.label}, page ${source.page}${source.clause && source.clauseChecked ? `, ${source.clause}` : ''}` : undefined}
                  tabIndex={isFirst ? -1 : undefined}
                  style={{
                    left: `${r.box.x * 100}%`,
                    top: `${r.box.y * 100}%`,
                    width: `${r.box.w * 100}%`,
                    height: `${r.box.h * 100}%`,
                    ...(r.box.r ? { transform: `rotate(${r.box.r}deg)` } : {}),
                  }}
                />

              );
            })}
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------

/**
 * `sources`: the places one value was found (several for a conflict: shown as tabs). `documents`: the files by name.
 * Opens on `initialId`. A source that wasn't found opens on the page that was claimed, with no highlight and a notice.
 */
export function SourceViewer({ sources, documents, initialId, onClose }: { sources: ViewerSource[]; documents: Record<string, ViewerDocument>; initialId: string; onClose: () => void }) {
  const [activeId, setActiveId] = useState(initialId);
  const source = sources.find((s) => s.id === activeId) ?? sources[0]!;
  const doc = documents[source.file];
  const regions = useMemo(
    () => (source.state === 'not_found' || source.state === 'ambiguous' ? [] : highlightRegions({ page: source.page, fractions: source.fractions, more: source.more }, { approximate: source.approximate })),
    [source],
  );
  const [current, setCurrent] = useState(source.state === 'found' || source.state === 'value_mismatch' ? source.page : source.claimedPage ?? source.page);
  const total = doc?.pages.length ?? 0;
  const [zoom, setZoom] = useState(1);

  useEffect(() => setCurrent(firstRegion(regions)?.page ?? source.claimedPage ?? source.page), [source, regions]);

  // On a phone the notes above the page fill the dialog, so bring the caption and the page into view (the text above stays a scroll away).
  useEffect(() => {
    if (window.matchMedia('(max-width: 600px)').matches) document.querySelector('.vw-caption')?.scrollIntoView({ block: 'start' });
  }, [source.id]);

  const goTo = (n: number) => {
    const clamped = Math.min(Math.max(n, 1), total);
    setCurrent(clamped);
    document.querySelector<HTMLElement>(`.vw-scroll [data-page="${clamped}"]`)?.scrollIntoView({ block: 'start', behavior: 'auto' });
  };

  const located = source.state === 'found' || source.state === 'value_mismatch';
  const caption = `Showing ${chipText(source)} · ${source.label}${located ? (source.approximate ? ' · position approximate' : '') : ' · no highlight'}`;
  const others = source.flag ? sources.filter((s) => s.id !== source.id && s.flag === source.flag) : [];
  const status =
    source.state === 'found' && source.flag ? (
      <span className="badge b-inc">{FLAG_BADGE[source.flag]}</span>
    ) : source.state === 'found' ? (
      <span className="badge b-ok">Source found</span>
    ) : source.state === 'value_mismatch' ? (
      <span className="badge b-inc">Flagged for review</span>
    ) : source.state === 'ambiguous' ? (
      <span className="badge b-mis">Source unclear — review</span>
    ) : (
      <span className="badge b-mis">Source not found — review</span>
    );

  return (
    <Modal title={`${source.label}: source`} onClose={onClose} wide>
      {sources.length > 1 && (
        <div className="vw-tabs" role="tablist" aria-label="Sources for this value">
          {sources.map((s) => (
            <button
              key={s.id}
              type="button"
              role="tab"
              aria-selected={s.id === source.id}
              className={`vw-tab${s.id === source.id ? ' on' : ''}${s.flag ? ' flag' : ''}`}
              onClick={() => setActiveId(s.id)}
              onKeyDown={(e) => {
                const i = sources.indexOf(s);
                const next = e.key === 'ArrowRight' ? sources[i + 1] : e.key === 'ArrowLeft' ? sources[i - 1] : undefined;
                if (next) {
                  e.preventDefault();
                  setActiveId(next.id);
                  (e.currentTarget.parentElement?.querySelectorAll('[role="tab"]')[sources.indexOf(next)] as HTMLElement | undefined)?.focus();
                }
              }}
            >
              {chipLabel(s)}
              {s.supersededBy ? ' · superseded' : ''}
            </button>
          ))}
        </div>
      )}

      <div className="doc-ctx vw-ctx">
        <p className="vw-meta">
          <span className="vw-file">{source.file}</span>
          <span aria-hidden="true"> · </span>
          <span>{total ? `page ${current} of ${total}` : `page ${current}`}</span>
          {source.clause && source.clauseChecked && (
            <>
              <span aria-hidden="true"> · </span>
              <span>{source.clause}</span>
            </>
          )}
          <span className="vw-status">{status}</span>
        </p>
        <blockquote className="vw-quote">{source.quote}</blockquote>
        {source.flag === 'conflict' && (
          <p className="vw-notice vw-flag" role="status">
            Conflict: the agreement says different things in different places
            {others.length ? ` (this one and ${others.map((o) => chipText(o)).join(', ')})` : ''}. It has been flagged for review; a reviewer has to choose which applies. Use the tabs to compare.
          </p>
        )}
        {source.flag === 'blank' && <p className="vw-notice vw-flag">This part of the signed copy is left blank. It has been flagged for review.</p>}
        {source.flag === 'unclear' && <p className="vw-notice vw-flag">This wording could not be resolved on its own. It has been flagged for review.</p>}
        {source.supersededBy && <p className="vw-notice">Superseded by {source.supersededBy}. This wording no longer applies.</p>}
        {source.claimedPage !== undefined && located && <p className="vw-notice">The wording was found on page {source.page}, not page {source.claimedPage} as first cited.</p>}
        {!located && (
          <p className="vw-notice vw-warn" role="status">
            {source.reason ?? 'The quoted wording wasn’t found on this page.'} Check the page before relying on this value.
          </p>
        )}
        {source.state === 'value_mismatch' && <p className="vw-notice vw-warn">{source.reason} The wording is highlighted so you can check it.</p>}
        {source.approximate && located && <p className="vw-notice">Scanned copy: the highlight’s position is approximate.</p>}
        <p className="vw-truth muted">The signed agreement is the source of truth.</p>
      </div>

      <div className="vw-nav">
        <button type="button" className="btn btn-sm btn-quiet" onClick={() => goTo(current - 1)} disabled={current <= 1}>
          Previous page
        </button>
        <button type="button" className="btn btn-sm btn-quiet" onClick={() => goTo(current + 1)} disabled={!total || current >= total}>
          Next page
        </button>
        <button type="button" className="btn btn-sm btn-quiet" onClick={() => setZoom((z) => ZOOMS[Math.max(0, ZOOMS.indexOf(z) - 1)]!)} disabled={zoom <= ZOOMS[0]!}>
          Zoom out
        </button>
        <button type="button" className="btn btn-sm btn-quiet" onClick={() => setZoom((z) => ZOOMS[Math.min(ZOOMS.length - 1, ZOOMS.indexOf(z) + 1)]!)} disabled={zoom >= ZOOMS[ZOOMS.length - 1]!}>
          Zoom in
        </button>
        <span className="vw-zoom" aria-live="polite">Zoom {Math.round(zoom * 100)}%</span>
      </div>

      {/* The one place the source's name is shown: not on the page, where it could cover the text. Announced when it changes. */}
      <p className="vw-caption" role="status" aria-live="polite" aria-atomic="true">
        <span className="sw" aria-hidden="true" />
        <span>{caption}</span>
      </p>

      {doc ? <PageStack key={source.id} doc={doc} source={source} regions={regions} zoom={zoom} onPage={setCurrent} /> : <p className="err-box">The file for this source isn’t available.</p>}
    </Modal>
  );
}
