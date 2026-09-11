'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

// ── Badge + status dot ────────────────────────────────────

export function Badge({
  tone = 'muted',
  children,
}: {
  tone?: 'muted' | 'ok' | 'warn' | 'bad' | 'info';
  children: React.ReactNode;
}): React.JSX.Element {
  return <span className={`badge${tone === 'muted' ? '' : ` ${tone}`}`}>{children}</span>;
}

export function StatusDot({ tone = 'muted', pulse = false }: { tone?: string; pulse?: boolean }): React.JSX.Element {
  const known = ['ok', 'warn', 'bad'].includes(tone) ? tone : 'muted';
  return <span className={`dot ${known}${pulse ? ' pulse' : ''}`} aria-hidden />;
}

export function statusTone(status: string): 'ok' | 'warn' | 'bad' | 'muted' {
  const s = status.toLowerCase();
  if (['running', 'ready', 'healthy', 'active', 'completed', 'paid', 'applied', 'approved', 'connected'].includes(s))
    return 'ok';
  if (['failed', 'error', 'expired', 'canceled', 'unhealthy', 'unavailable', 'rejected', 'void'].includes(s))
    return 'bad';
  if (
    ['pending', 'provisioning', 'retrying', 'building', 'deploying', 'starting', 'trialing', 'past_due', 'open'].includes(
      s,
    )
  )
    return 'warn';
  return 'muted';
}

// ── Dropdown menu (outside-click + Escape handled) ─────────

export function Menu({
  label,
  button,
  children,
  align = 'left',
  up = false,
}: {
  label: string;
  button: React.ReactNode;
  children: React.ReactNode;
  align?: 'left' | 'right';
  up?: boolean;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open ]);

  return (
    <div className="switcher" ref={ref}>
      <button
        type="button"
        className="switcher-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        onClick={() => setOpen(o => !o)}
      >
        {button}
      </button>
      {open ? (
        <div
          className={`menu${up ? ' up' : ''}`}
          role="menu"
          style={align === 'right' ? { right: 0 } : undefined}
          onClickCapture={e => {
            if ((e.target as HTMLElement).closest('button,a')) setOpen(false);
          }}
        >
          {children}
        </div>
      ) : null}
    </div>
  );
}

// ── Modal ─────────────────────────────────────────────────

export function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}): React.JSX.Element {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="modal-backdrop"
      onMouseDown={e => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal" role="dialog" aria-modal="true" aria-label={title}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
          <h2 style={{ margin: 0, flex: 1 }}>{title}</h2>
          <button type="button" className="icon-btn" aria-label="Close dialog" onClick={onClose}>
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

// ── Toasts ────────────────────────────────────────────────

interface Toast {
  id: number;
  message: string;
  kind: 'ok' | 'bad' | 'info';
}

const ToastContext = createContext<(message: string, kind?: Toast['kind']) => void>(() => undefined);

export function ToastProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const idRef = useRef(1);

  const push = useCallback((message: string, kind: Toast['kind'] = 'info') => {
    const id = idRef.current++;
    setToasts(t => [...t.slice(-3), { id, message, kind }]);
    window.setTimeout(() => {
      setToasts(t => t.filter(x => x.id !== id));
    }, 5000);
  }, []);

  const value = useMemo(() => push, [push]);
  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toasts" aria-live="polite">
        {toasts.map(t => (
          <div key={t.id} className={`toast ${t.kind}`} role="status">
            {t.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): (message: string, kind?: Toast['kind']) => void {
  return useContext(ToastContext);
}
