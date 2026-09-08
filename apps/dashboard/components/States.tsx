export function EmptyState({
  title,
  hint,
  action,
}: {
  title: string;
  hint: string;
  action?: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="empty" role="status">
      <h3 style={{ margin: '0 0 8px' }}>{title}</h3>
      <p className="muted" style={{ margin: '0 0 12px' }}>
        {hint}
      </p>
      {action}
    </div>
  );
}

export function ErrorState({ message }: { message: string }): React.JSX.Element {
  return (
    <div className="error-box" role="alert">
      <strong>Something went wrong</strong>
      <p className="muted">{message}</p>
    </div>
  );
}

export function LoadingSkeleton({ label }: { label: string }): React.JSX.Element {
  return (
    <div className="skeleton" role="status" aria-live="polite" aria-label={label}>
      <div className="skeleton-row" />
      <div className="skeleton-row" />
      <div className="skeleton-row" style={{ maxWidth: 280 }} />
    </div>
  );
}
