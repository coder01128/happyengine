import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';

export function Badge({ text, cls }: { text: string; cls: string }) {
  return <span className={`badge ${cls}`}>{text}</span>;
}

// ---------- toast ----------
const ToastContext = createContext<(message: string) => void>(() => {});
export const useToast = () => useContext(ToastContext);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [message, setMessage] = useState<{ text: string; key: number } | null>(null);
  const show = useCallback((text: string) => setMessage({ text, key: Date.now() }), []);
  useEffect(() => {
    if (!message) return;
    const t = setTimeout(() => setMessage(null), 3600);
    return () => clearTimeout(t);
  }, [message]);
  return (
    <ToastContext.Provider value={show}>
      {children}
      <div aria-live="polite" className="sr-live">
        {message && (
          <div className="toast" key={message.key} role="status">
            {message.text}
          </div>
        )}
      </div>
    </ToastContext.Provider>
  );
}

// ---------- theme ----------
const THEME_KEY = 'happyai:theme';
const systemDark = () => window.matchMedia('(prefers-color-scheme: dark)').matches;

export function ThemeButton() {
  const [dark, setDark] = useState(() => {
    const t = document.documentElement.getAttribute('data-theme');
    return t ? t === 'dark' : systemDark();
  });
  const toggle = () => {
    const next = dark ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      /* storage unavailable: the choice lasts for this page only */
    }
    setDark(!dark);
  };
  return (
    <button type="button" className="theme-btn" onClick={toggle} aria-label={dark ? 'Switch to light theme' : 'Switch to dark theme'}>
      {dark ? (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
        </svg>
      ) : (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          <circle cx="12" cy="12" r="4.5" />
          <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
        </svg>
      )}
    </button>
  );
}
