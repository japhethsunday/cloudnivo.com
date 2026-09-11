export function EmptyState({
  title,
  hint,
  action,
  secondary,
  icon = '◇',
}: {
  title: string;
  hint: string;
  action?: React.ReactNode;
  secondary?: React.ReactNode;
  icon?: string;
}): React.JSX.Element {
  return (
    <div className="empty" role="status">
      <div aria-hidden style={{ fontSize: 26, color: 'var(--text-faint)', marginBottom: 6 }}>
        {icon}
      </div>
      <h3 style={{ margin: '0 0 8px' }}>{title}</h3>
      <p className="muted" style={{ margin: '0 auto 14px', maxWidth: 52 * 10 }}>
        {hint}
      </p>
      {action || secondary ? (
        <div style={{ display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap' }}>
          {action}
          {secondary}
        </div>
      ) : null}
    </div>
  );
}

export function ErrorState({
  message,
  retry,
  details,
}: {
  message: string;
  retry?: () => void;
  details?: string;
}): React.JSX.Element {
  return (
    <div className="error-box" role="alert" style={{ marginBottom: 12 }}>
      <strong>Something went wrong</strong>
      <p className="muted" style={{ margin: '6px 0 0' }}>
        {message}
      </p>
      {details ? (
        <details style={{ marginTop: 8 }}>
          <summary style={{ cursor: 'pointer', fontSize: 13 }}>Technical details</summary>
          <pre
            style={{
              overflow: 'auto',
              fontSize: 12,
              background: 'var(--bg-inset)',
              padding: 8,
              borderRadius: 6,
              marginTop: 6,
            }}
          >
            {details}
          </pre>
        </details>
      ) : null}
      {retry ? (
        <div style={{ marginTop: 10 }}>
          <button type="button" className="btn btn-sm" onClick={retry}>
            Try again
          </button>
        </div>
      ) : null}
    </div>
  );
}

export function LoadingSkeleton({ label, rows = 3 }: { label: string; rows?: number }): React.JSX.Element {
  return (
    <div className="skeleton" role="status" aria-live="polite" aria-label={label}>
      {Array.from({ length: rows }, (_, i) => (
        <div
          key={i}
          className="skeleton-row"
          style={i === rows - 1 ? { maxWidth: 280 } : undefined}
        />
      ))}
    </div>
  );
}

export function LoadingCards({ label }: { label: string }): React.JSX.Element {
  return (
    <div className="proj-grid" role="status" aria-live="polite" aria-label={label}>
      {[0, 1, 2].map(i => (
        <div key={i} className="card" aria-hidden>
          <div className="skeleton-row" style={{ maxWidth: '60%', margin: '0 0 10px' }} />
          <div className="skeleton-row" style={{ margin: '0 0 10px' }} />
          <div className="skeleton-row" style={{ maxWidth: '40%', margin: 0 }} />
        </div>
      ))}
    </div>
  );
}
