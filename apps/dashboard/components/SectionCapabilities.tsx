'use client';

import Link from 'next/link';
import { CAPABILITIES, resolveCapabilityHref, type CapabilityCategory } from '../lib/capabilities';

/** Compact strip listing the capabilities that live in a given section. */
export function SectionCapabilities({
  category,
  projectId = null,
  compact = false,
}: {
  category: CapabilityCategory;
  projectId?: string | null;
  compact?: boolean;
}): React.JSX.Element {
  const items = CAPABILITIES.filter(c => c.category === category);
  if (items.length === 0) return <></>;
  return (
    <div className="card" style={{ marginTop: 12 }} aria-label={`${category} capabilities`}>
      <div className="section-head split">
        <div>
          <p className="eyebrow">{category}</p>
          <h2 style={{ fontSize: 15 }}>
            {category} capabilities · {items.length}
          </h2>
          {!compact ? (
            <p className="muted" style={{ margin: '4px 0 0', fontSize: 13 }}>
              Every item below is live in this workspace — open it where it runs.
            </p>
          ) : null}
        </div>
        <Link href="/capabilities">All 100 →</Link>
      </div>
      <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 8 }}>
        {items.map(c => (
          <li key={c.id} className="health-row" style={{ alignItems: 'flex-start' }}>
            <span className="dot ok" aria-hidden style={{ marginTop: 6 }} />
            <span className="grow">
              <span className="name">{c.title}</span>
              {!compact ? <div className="detail">{c.body}</div> : null}
            </span>
            <Link className="value" href={resolveCapabilityHref(c, projectId)}>
              Open →
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
