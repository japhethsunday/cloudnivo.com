/**
 * Serverless Functions domain types.
 *
 * A function belongs to exactly one project. Source deploys become immutable
 * versions; exactly one version is active. Deployments run asynchronously
 * through job records (PENDING → BUILDING → DEPLOYING → READY | FAILED).
 * Invocation runs the active version's handler in an isolated runtime —
 * never in the control-plane process.
 */

export const FUNCTION_STATUSES = [
  'creating',
  'building',
  'deploying',
  'ready',
  'running',
  'failed',
  'stopped',
  'deleting',
] as const;
export type FunctionStatus = (typeof FUNCTION_STATUSES)[number];

export const FUNCTION_RUNTIMES = ['node22'] as const;
export type FunctionRuntimeName = (typeof FUNCTION_RUNTIMES)[number];

export interface FunctionRecord {
  id: string;
  projectId: string;
  organizationId: string;
  name: string;
  slug: string;
  description: string;
  runtime: FunctionRuntimeName;
  /** Export selector, e.g. `handler` or `api.handler`. */
  entrypoint: string;
  status: FunctionStatus;
  /** Currently active immutable version number (0 = never deployed). */
  activeVersion: number;
  lastError: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  deployedAt: string | null;
}

/** Public shape: source bytes and secret env values never leave the server. */
export interface ExposedFunction {
  id: string;
  projectId: string;
  name: string;
  slug: string;
  description: string;
  runtime: FunctionRuntimeName;
  entrypoint: string;
  status: FunctionStatus;
  activeVersion: number;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  deployedAt: string | null;
}

export interface FunctionVersion {
  functionId: string;
  projectId: string;
  version: number;
  /** Content hash (sha256 hex) — identical source redeploys are no-ops. */
  sourceHash: string;
  sourceBytes: number;
  runtime: FunctionRuntimeName;
  entrypoint: string;
  active: boolean;
  createdBy: string;
  createdAt: string;
}

export interface ExposedVersion {
  version: number;
  sourceHash: string;
  sourceBytes: number;
  runtime: FunctionRuntimeName;
  entrypoint: string;
  active: boolean;
  createdAt: string;
}

export const DEPLOY_JOB_STATUSES = ['pending', 'building', 'deploying', 'ready', 'failed'] as const;
export type DeployJobStatus = (typeof DEPLOY_JOB_STATUSES)[number];

export interface DeployJob {
  id: string;
  functionId: string;
  projectId: string;
  organizationId: string;
  version: number;
  status: DeployJobStatus;
  idempotencyKey: string | null;
  attempts: number;
  lastError: string | null;
  logs: string[];
  createdAt: string;
  updatedAt: string;
}

export interface FunctionEnvVar {
  functionId: string;
  projectId: string;
  key: string;
  secret: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ExposedEnvVar {
  key: string;
  /** Secret values are always masked in API responses. */
  value: string;
  secret: boolean;
  updatedAt: string;
}

/** What the handler receives — identity only, never credentials. */
export interface FunctionAuthContext {
  userId: string | null;
  email: string | null;
  role: string;
  projectId: string;
  callerKind: 'session' | 'key' | 'customer' | 'public';
}

export interface FunctionHttpRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  query: Record<string, string>;
  /** Parsed JSON body (or null). Size-capped before the runtime sees it. */
  body: unknown;
}

export interface FunctionResult {
  /** HTTP status the runtime produced (default 200). */
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

export interface InvocationOutcome {
  result: FunctionResult;
  executionTimeMs: number;
  coldStart: boolean;
  memoryUsedBytes: number | null;
  version: number;
  requestId: string;
}

export interface FunctionLogEntry {
  id: string;
  functionId: string;
  projectId: string;
  version: number;
  requestId: string;
  timestamp: string;
  level: 'log' | 'warn' | 'error';
  message: string;
  executionTimeMs: number | null;
  status: 'ok' | 'error' | 'timeout';
}

export interface FunctionLimits {
  executionTimeoutMs: number;
  memoryMb: number;
  maxRequestBodyBytes: number;
  maxResponseBytes: number;
  maxConcurrency: number;
  maxDeploymentBytes: number;
  maxFunctionsPerProject: number;
  maxLogEntries: number;
  logRetentionDays: number;
}

export interface FunctionMetrics {
  invocations: number;
  successes: number;
  failures: number;
  timeouts: number;
  rateLimited: number;
  totalExecutionMs: number;
  coldStarts: number;
  maxExecutionMs: number;
  deployFailures: number;
  activeVersions: number;
}

export class FunctionError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = 'FunctionError';
    this.code = code;
    this.status = status;
  }
}

/** Strip everything a function record must never reveal. */
export function exposeFunction(fn: FunctionRecord): ExposedFunction {
  return {
    id: fn.id,
    projectId: fn.projectId,
    name: fn.name,
    slug: fn.slug,
    description: fn.description,
    runtime: fn.runtime,
    entrypoint: fn.entrypoint,
    status: fn.status,
    activeVersion: fn.activeVersion,
    lastError: fn.lastError,
    createdAt: fn.createdAt,
    updatedAt: fn.updatedAt,
    deployedAt: fn.deployedAt,
  };
}

export function exposeVersion(v: FunctionVersion): ExposedVersion {
  return {
    version: v.version,
    sourceHash: v.sourceHash,
    sourceBytes: v.sourceBytes,
    runtime: v.runtime,
    entrypoint: v.entrypoint,
    active: v.active,
    createdAt: v.createdAt,
  };
}
