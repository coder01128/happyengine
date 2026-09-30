import { useEffect, useId, useRef, type ReactNode } from 'react';

/** Centred modal: traps focus, closes on Esc and scrim click, returns focus to the trigger. */
export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();

  useEffect(() => {
    const trigger = document.activeElement as HTMLElement | null;
    const sheet = ref.current!;
    const focusables = () =>
      [...sheet.querySelectorAll<HTMLElement>('button,[href],input,select,textarea,[tabindex]:not([tabindex="-1"])')].filter(
        (el) => !el.hasAttribute('disabled') && el.offsetParent !== null,
      );
    focusables()[0]?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      } else if (e.key === 'Tab') {
        const items = focusables();
        if (!items.length) return;
        const first = items[0]!;
        const last = items[items.length - 1]!;
        const active = document.activeElement as HTMLElement | null;
        if (active && items.includes(active)) {
          if (e.shiftKey && active === first) {
            e.preventDefault();
            last.focus();
          } else if (!e.shiftKey && active === last) {
            e.preventDefault();
            first.focus();
          }
          return;
        }
        // Focus is on something the trap doesn't list (an element focused by script, tabindex -1, or outside):
        // move to the next listed control after it in the page order, wrapping at the ends.
        e.preventDefault();
        const after = (el: HTMLElement) => !!active && active.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING;
        const before = (el: HTMLElement) => !!active && active.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_PRECEDING;
        const inside = !!active && sheet.contains(active);
        const next = e.shiftKey ? [...items].reverse().find(before) : items.find(after);
        (inside && next ? next : e.shiftKey ? last : first).focus();
      }
    };
    // If focus lands outside the dialog by any other route, bring it back.
    const onFocusIn = (e: FocusEvent) => {
      if (!sheet.contains(e.target as Node)) focusables()[0]?.focus();
    };
    document.addEventListener('focusin', onFocusIn);
    document.addEventListener('keydown', onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('focusin', onFocusIn);
      document.body.style.overflow = overflow;
      trigger?.focus();
    };
  }, [onClose]);

  return (
    <>
      <div className="scrim" onClick={onClose} aria-hidden="true" />
      <div className={`sheet${wide ? ' sheet-wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby={titleId} ref={ref}>
        <div className="sheet-top">
          <h2 id={titleId}>{title}</h2>
          <button type="button" className="x" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        {children}
      </div>
    </>
  );
}
