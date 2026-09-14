'use client';

/**
 * Shared section-tab signal between SectionTabs and the sidebar.
 * Sidebar nested links (`?tab=users`) and in-page tab clicks stay in sync
 * through this store; the URL is the source of truth for deep-linking and
 * back/forward navigation. No routes change — only the `tab` query key.
 */

type Listener = () => void;

function readUrl(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return new URLSearchParams(window.location.search).get('tab');
  } catch {
    return null;
  }
}

// Deliberately NOT read from the URL at import: server and client snapshots
// must match on first render (null). SectionTabs syncs from the URL on mount.
let current: string | null = null;
const listeners = new Set<Listener>();

function notify(): void {
  listeners.forEach(l => {
    try {
      l();
    } catch {
      // A stale subscriber must never break navigation.
    }
  });
}

export function getSectionTab(): string | null {
  return current;
}

export function setSectionTab(tab: string | null): void {
  current = tab;
  if (typeof window !== 'undefined') {
    try {
      const u = new URL(window.location.href);
      if (tab) u.searchParams.set('tab', tab);
      else u.searchParams.delete('tab');
      window.history.replaceState(null, '', u);
    } catch {
      // Non-URL contexts (tests): keep the in-memory value.
    }
  }
  notify();
}

/** Re-read the URL (e.g. after client-side navigation) and notify. */
export function syncSectionTabFromUrl(): void {
  current = readUrl();
  notify();
}

export function subscribeSectionTab(l: Listener): () => void {
  listeners.add(l);
  const onPop = (): void => {
    current = readUrl();
    notify();
  };
  if (typeof window !== 'undefined') window.addEventListener('popstate', onPop);
  return () => {
    listeners.delete(l);
    if (typeof window !== 'undefined') window.removeEventListener('popstate', onPop);
  };
}
