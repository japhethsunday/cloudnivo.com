'use client';

import Link from 'next/link';
import { CAPABILITIES, resolveCapabilityHref, type CapabilityCategory } from '../lib/capabilities';

/** Minimal footer link — the real workflows live above, not in a capability grid. */
export function SectionCapabilities({
  category,
  projectId = null,
  compact = false,
}: {
  category: CapabilityCategory;
  projectId?: string | null;
  compact?: boolean;
}): React.JSX.Element {
  void compact;
  const items = CAPABILITIES.filter(c => c.category === category);
  if (items.length === 0) return <></>;
  const sample = items[0];
  return (
    <p className="muted" style={{ marginTop: 12, fontSize: 12 }}>
      {items.length} {category.toLowerCase()} workflows live in this section ·{' '}
      <Link href={sample ? resolveCapabilityHref(sample, projectId) : '/dashboard'}>
        open section
      </Link>{' '}
      · <Link href="/capabilities">internal registry</Link>
    </p>
  );
}
