'use client';

/** Persisted workspace selection (sidebar switchers + creation defaults). */

const ORG_KEY = 'cn_org';
const PROJECT_KEY = 'cn_project';

function read(key: string): string | null {
  if (typeof window === 'undefined') return null;
  const v = window.localStorage.getItem(key);
  return v && v.length > 0 ? v : null;
}

export function getSelectedOrg(): string | null {
  return read(ORG_KEY);
}

export function setSelectedOrg(id: string | null): void {
  if (typeof window === 'undefined') return;
  if (id) window.localStorage.setItem(ORG_KEY, id);
  else window.localStorage.removeItem(ORG_KEY);
}

export function getSelectedProject(): string | null {
  return read(PROJECT_KEY);
}

export function setSelectedProject(id: string | null): void {
  if (typeof window === 'undefined') return;
  if (id) window.localStorage.setItem(PROJECT_KEY, id);
  else window.localStorage.removeItem(PROJECT_KEY);
}
