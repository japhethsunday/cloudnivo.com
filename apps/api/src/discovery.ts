import type { IncomingMessage, ServerResponse } from 'node:http';
import { ERROR_REMEDIATION, ok } from '@cloudnivo/api-core';
import { capabilityManifest } from '@cloudnivo/agents';
import type { AppConfig } from '@cloudnivo/config';
import type { ApiContext } from './v1.js';
import { sendJson } from './projects.js';

/**
 * Discovery plane — how a coding agent learns what CloudNivo is before it
 * has any project context.
 *
 * `GET /api/v1/discovery` is deliberately unauthenticated: an agent that has
 * only been handed a URL must be able to find out which auth schemes exist,
 * which environment variables to ask its operator for, and which scopes
 * back which operations. It exposes no tenant data — only the shape of the
 * product, which is already public in the docs.
 */

export function isDiscoveryRoute(pathname: string, method: string): boolean {
  if (method !== 'GET') return false;
  return (
    pathname === '/api/v1/discovery' ||
    pathname === '/api/v1/discovery/scopes' ||
    pathname === '/.well-known/cloudnivo.json'
  );
}

export async function handleDiscoveryRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ApiContext,
  baseHeaders: Record<string, string>,
  requestId: string,
): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const manifest = capabilityManifest({
    apiUrl: ctx.config.PUBLIC_API_URL,
    errorRemediation: ERROR_REMEDIATION,
  });

  if (url.pathname === '/api/v1/discovery/scopes') {
    sendJson(res, 200, ok({ scopes: manifest.scopes, expiryPresets: manifest.expiryPresets }, requestId), baseHeaders);
    return true;
  }

  // `/.well-known/cloudnivo.json` is the version an agent guesses at from the
  // bare origin; it answers with the pointer rather than the whole manifest.
  if (url.pathname === '/.well-known/cloudnivo.json') {
    sendJson(
      res,
      200,
      ok(
        {
          product: 'cloudnivo',
          apiVersion: manifest.apiVersion,
          apiUrl: ctx.config.PUBLIC_API_URL,
          discovery: `${ctx.config.PUBLIC_API_URL}/api/v1/discovery`,
          docs: 'https://github.com/japhethsunday/cloudnivo.com/blob/main/docs/agent-access.md',
        },
        requestId,
      ),
      baseHeaders,
    );
    return true;
  }

  sendJson(res, 200, ok(manifest, requestId), baseHeaders);
  return true;
}

/**
 * Environment-variable template for one project.
 *
 * Values that are secret are NEVER filled in — the template carries the
 * placeholder and says where the real value comes from. This is what the
 * Connect page copies and what `cloudnivo env --template` prints, so it is
 * the one place that decides what an agent's `.env` looks like.
 */
export function envTemplateFor(input: {
  config: AppConfig;
  projectId: string;
  environment: string;
  publicKeyPrefix: string | null;
}): { lines: string[]; variables: { name: string; value: string; secret: boolean; note: string }[] } {
  const variables = [
    {
      name: 'CLOUDNIVO_URL',
      value: input.config.PUBLIC_API_URL,
      secret: false,
      note: 'API origin.',
    },
    {
      name: 'CLOUDNIVO_PROJECT_ID',
      value: input.projectId,
      secret: false,
      note: 'This project.',
    },
    {
      name: 'CLOUDNIVO_ENVIRONMENT',
      value: input.environment,
      secret: false,
      note: 'Environment the agent is modifying. Production needs approvals.',
    },
    {
      name: 'CLOUDNIVO_AGENT_TOKEN',
      value: 'cn_agent_…',
      secret: true,
      note: 'Shown once when the token is created. Store it in your secret manager, never in git.',
    },
    {
      name: 'CLOUDNIVO_PUBLIC_KEY',
      value: input.publicKeyPrefix ? `${input.publicKeyPrefix}…` : 'cn_…',
      secret: false,
      note: 'Browser-safe project key for the data plane.',
    },
    {
      name: 'CLOUDNIVO_SECRET_KEY',
      value: 'cn_…',
      secret: true,
      note: 'Service-role key for server-side code. Shown once at creation.',
    },
  ];
  return {
    lines: variables.map(v => `${v.name}=${v.value}`),
    variables,
  };
}

/**
 * `GET /api/v1/projects/:id/connect` — everything needed to point an agent,
 * an SDK, or a CLI at this project, in one response.
 *
 * Secret material follows the rule the rest of the platform already keeps:
 * an agent token never gets credentials back, and a human only gets them
 * with `?reveal=true`, which is audited by the caller. Raw API keys are not
 * here at all — they exist exactly once, at creation.
 */
export interface ConnectBundle {
  project: { id: string; slug: string; name: string; organizationId: string; region: string };
  urls: { api: string; project: string; data: string; realtime: string; openapi: string; discovery: string };
  keys: {
    publicKeyPrefix: string | null;
    secretKeyPrefix: string | null;
    note: string;
    issue: string;
  };
  database: { host: string; port: number; database: string; user: string; password: string; connectionString: string };
  agentToken: { issue: string; verify: string; scopesEndpoint: string; note: string };
  environments: { slug: string; name: string; isPreview: boolean }[];
  install: { cli: string; sdk: string; login: string; link: string };
  env: { lines: string[]; variables: { name: string; value: string; secret: boolean; note: string }[] };
}

export function buildConnectBundle(input: {
  config: AppConfig;
  project: { id: string; slug: string; name: string; organizationId: string; region: string };
  keys: { prefix: string; role: string; revokedAt: string | null }[];
  database: { host: string; port: number; database: string; user: string; password: string } | null;
  revealed: boolean;
  environments: { slug: string; name: string; isPreview: boolean }[];
  environment: string;
}): ConnectBundle {
  const api = input.config.PUBLIC_API_URL;
  const base = `${api}/api/v1/projects/${input.project.id}`;
  const live = input.keys.filter(k => !k.revokedAt);
  const publicKeyPrefix = live.find(k => k.role === 'public')?.prefix ?? null;
  const secretKeyPrefix = live.find(k => k.role === 'service' || k.role === 'admin')?.prefix ?? null;
  const password = input.database
    ? input.revealed
      ? input.database.password
      : '••••••••'
    : '';
  const connectionString = input.database
    ? `postgres://${encodeURIComponent(input.database.user)}:${
        input.revealed ? encodeURIComponent(input.database.password) : '••••••••'
      }@${input.database.host}:${input.database.port}/${encodeURIComponent(input.database.database)}`
    : '';
  return {
    project: input.project,
    urls: {
      api,
      project: base,
      data: `${base}/tables`,
      realtime: `${api.replace(/^http/, 'ws')}/api/v1/projects/${input.project.id}/realtime`,
      openapi: `${base}/openapi.json`,
      discovery: `${api}/api/v1/discovery`,
    },
    keys: {
      publicKeyPrefix,
      secretKeyPrefix,
      note: 'Raw key values are returned once at creation and never again. Rotate by issuing a new key and revoking the old one.',
      issue: `POST ${base}/keys`,
    },
    database: input.database
      ? { ...input.database, password, connectionString }
      : { host: '', port: 0, database: '', user: '', password: '', connectionString: '' },
    agentToken: {
      issue: `POST ${api}/api/v1/organizations/${input.project.organizationId}/agent-tokens`,
      verify: `GET ${api}/api/v1/agent/whoami`,
      scopesEndpoint: `${api}/api/v1/discovery/scopes`,
      note: 'The raw cn_agent_… value is shown once. Rotate it rather than sharing it.',
    },
    environments: input.environments,
    install: {
      cli: 'npm install -g @cloudnivo/cli',
      sdk: 'npm install @cloudnivo/sdk',
      login: 'cloudnivo login --agent-token cn_agent_…',
      link: `cloudnivo link --project ${input.project.id}`,
    },
    env: envTemplateFor({
      config: input.config,
      projectId: input.project.id,
      environment: input.environment,
      publicKeyPrefix,
    }),
  };
}
