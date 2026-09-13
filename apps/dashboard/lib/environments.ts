'use client';

import { apiFetch } from './api';

/**
 * Project environments (Phase 15 backend: `database/environments`).
 * Environments pin a branch database (or main when unpinned) and flag
 * previews. There is no implicit "production" row — `slug === 'production'`
 * is the workspace convention for the live environment.
 */

export interface DbEnvironment {
  id: string;
  projectId: string;
  name: string;
  slug: string;
  branchId: string | null;
  isPreview: boolean;
  status: string;
  createdAt: string;
}

export interface DbBranchLite {
  id: string;
  name: string;
  status: string;
}

const ENV_KEY_PREFIX = 'cn_env:';

function keyFor(projectId: string): string {
  return `${ENV_KEY_PREFIX}${projectId}`;
}

export type EnvKind = 'production' | 'preview' | 'standard';

/** Workspace convention: slug `production` is live; previews are branch-isolated. */
export function envKind(env: Pick<DbEnvironment, 'slug' | 'isPreview'>): EnvKind {
  if (env.slug === 'production') return 'production';
  if (env.isPreview) return 'preview';
  return 'standard';
}

export function envKindLabel(kind: EnvKind): string {
  if (kind === 'production') return 'Production';
  if (kind === 'preview') return 'Preview';
  return 'Standard';
}

function readActive(projectId: string): string | null {
  if (typeof window === 'undefined') return null;
  const v = window.localStorage.getItem(keyFor(projectId));
  return v && v.length > 0 ? v : null;
}

export function getActiveEnvironmentId(projectId: string): string | null {
  return readActive(projectId);
}

export function setActiveEnvironmentId(projectId: string, id: string | null): void {
  if (typeof window === 'undefined') return;
  if (id) window.localStorage.setItem(keyFor(projectId), id);
  else window.localStorage.removeItem(keyFor(projectId));
}

/** Persisted choice wins; otherwise production, otherwise first. Never invents a row. */
export function resolveActive(envs: DbEnvironment[], projectId: string): DbEnvironment | null {
  if (envs.length === 0) return null;
  const saved = readActive(projectId);
  const byId = saved ? envs.find(e => e.id === saved) : undefined;
  if (byId) return byId;
  return envs.find(e => e.slug === 'production') ?? envs[0] ?? null;
}

export async function listEnvironments(
  projectId: string,
): Promise<{ ok: boolean; status: number; envs: DbEnvironment[] | null; error: string | null }> {
  const r = await apiFetch<{ environments: DbEnvironment[] }>(
    `/api/v1/projects/${projectId}/database/environments`,
  );
  if (!r.ok) return { ok: false, status: r.status, envs: null, error: r.error };
  return { ok: true, status: r.status, envs: r.data?.environments ?? [], error: null };
}

export async function createEnvironment(
  projectId: string,
  input: { name: string; slug: string; preview: boolean },
): Promise<{ ok: boolean; env: DbEnvironment | null; error: string | null }> {
  const r = await apiFetch<{ environment: DbEnvironment }>(
    `/api/v1/projects/${projectId}/database/environments`,
    { method: 'POST', body: { name: input.name, slug: input.slug, preview: input.preview } },
  );
  if (!r.ok) return { ok: false, env: null, error: r.error };
  return { ok: true, env: r.data?.environment ?? null, error: null };
}

export async function pinEnvironmentBranch(
  projectId: string,
  envId: string,
  branchId: string | null,
): Promise<{ ok: boolean; env: DbEnvironment | null; error: string | null }> {
  const r = await apiFetch<{ environment: DbEnvironment }>(
    `/api/v1/projects/${projectId}/database/environments/${envId}`,
    { method: 'PATCH', body: { branchId } },
  );
  if (!r.ok) return { ok: false, env: null, error: r.error };
  return { ok: true, env: r.data?.environment ?? null, error: null };
}

export async function deleteEnvironment(
  projectId: string,
  envId: string,
): Promise<{ ok: boolean; error: string | null }> {
  const r = await apiFetch(`/api/v1/projects/${projectId}/database/environments/${envId}`, {
    method: 'DELETE',
  });
  if (!r.ok) return { ok: false, error: r.error };
  return { ok: true, error: null };
}

export async function listBranches(
  projectId: string,
): Promise<{ ok: boolean; branches: DbBranchLite[]; error: string | null }> {
  const r = await apiFetch<{ branches: DbBranchLite[] }>(
    `/api/v1/projects/${projectId}/database/branches`,
  );
  if (!r.ok) return { ok: false, branches: [], error: r.error };
  return { ok: true, branches: r.data?.branches ?? [], error: null };
}

export const ENV_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$/;
