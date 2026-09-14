'use client';

import { useState } from 'react';

export interface SectionTab {
  id: string;
  label: string;
}

/** Accessible in-page tab bar sharing the .tabs visual language. */
export function SectionTabs({
  tabs,
  initial = null,
  label,
  render,
}: {
  tabs: SectionTab[];
  initial?: string | null;
  label: string;
  render: (active: string) => React.JSX.Element;
}): React.JSX.Element {
  const [active, setActive] = useState(initial ?? tabs[0]?.id ?? '');
  return (
    <div>
      <div className="subtabs" role="tablist" aria-label={label}>
        {tabs.map(t => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={active === t.id}
            onClick={() => setActive(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div role="tabpanel">{render(active)}</div>
    </div>
  );
}
