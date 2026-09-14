'use client';

import { useEffect, useState, useSyncExternalStore } from 'react';
import { getSectionTab, setSectionTab, subscribeSectionTab, syncSectionTabFromUrl } from '../lib/sectiontab';

export interface SectionTab {
  id: string;
  label: string;
}

/**
 * Accessible in-page tab bar sharing the .tabs visual language.
 * With `param="tab"`, the active tab is driven by `?tab=<id>` (source of
 * truth shared with the sidebar), so nested links, deep-links and
 * back/forward all land on the right tab. Without `param` it is local state.
 */
export function SectionTabs({
  tabs,
  initial = null,
  label,
  render,
  param = null,
}: {
  tabs: SectionTab[];
  initial?: string | null;
  label: string;
  render: (active: string) => React.JSX.Element;
  param?: string | null;
}): React.JSX.Element {
  const fallback = initial ?? tabs[0]?.id ?? '';
  const [manual, setManual] = useState(fallback);
  const storeTab = useSyncExternalStore(subscribeSectionTab, getSectionTab, () => null);

  useEffect(() => {
    if (param != null) syncSectionTabFromUrl();
  }, [param]);

  const active =
    param != null
      ? (storeTab && tabs.some(t => t.id === storeTab) ? storeTab : fallback)
      : manual;

  function select(id: string): void {
    if (param != null) setSectionTab(id);
    else setManual(id);
  }

  return (
    <div>
      <div className="subtabs" role="tablist" aria-label={label}>
        {tabs.map(t => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={active === t.id}
            onClick={() => select(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div role="tabpanel">{render(active)}</div>
    </div>
  );
}
