import { createHash, randomUUID } from 'node:crypto';
import {
  exposeFunction,
  exposeVersion,
  FunctionError,
  type DeployJob,
  type ExposedEnvVar,
  type ExposedFunction,
  type ExposedVersion,
  type FunctionAuthContext,
  type FunctionHttpRequest,
  type FunctionLimits,
  type FunctionLogEntry,
  type FunctionMetrics,
  type FunctionRecord,
  type FunctionRuntimeName,
  type FunctionStatus,
  type FunctionVersion,
  type InvocationOutcome,
} from './types.js';
import {
  assertDescription,
  assertEntrypoint,
  assertEnvKey,
  assertEnvValue,
  assertEnvWritable,
  assertFunctionName,
  assertFunctionSlug,
  assertRuntime,
  assertSource,
} from './validation.js';
import type { FunctionRuntime } from './runtime.js';
import type { SdkHooks } from './sdk.js';

/**
 * Serverless Functions orchestrator: records + versions + env + async
 * deployments + invocation + logs + metrics. Storage is in-memory in v1
 * (Drizzle tables mirror these shapes 1:1 as the durable target — same
 * pattern as the storage metadata store). Every method re-checks project
 * binding; cross-project access fails closed with no existence oracle
 * (unknown and foreign functions both read as 404, writes as 403/404).
 */

export interface FunctionServiceOptions {
  limits: FunctionLimits;
  /** Max env value bytes (platform-wide; secrets included). */
  maxEnvValueBytes: number;
}

interface StoredEnv {
  value: string;
  secret: boolean;
  updatedAt: string;
}

const MASK = '••••••••';

export function maskEnvValue(value: string, secret: boolean): string {
  if (!secret) return value;
  if (value.length <= 8) return MASK;
  return `${value.slice(0, 2)}${MASK}${value.slice(-2)}`;
}

/** Redact known secret values from a log line (bounded scan, bounded output). */
export function redactSecrets(line: string, secrets: string[]): string {
  let out = line.slice(0, 4000);
  for (const secret of secrets.slice(0, 64)) {
    if (secret.length >= 4 && out.includes(secret)) {
      out = out.split(secret).join('[redacted]');
    }
  }
  return out;
}

export class FunctionService {
  private readonly functions = new Map<string, FunctionRecord>();
  private readonly versions = new Map<string, FunctionVersion[]>();
  private readonly sources = new Map<string, string>();
  private readonly env = new Map<string, Map<string, StoredEnv>>();
  private readonly jobs = new Map<string, DeployJob>();
  private readonly logs: FunctionLogEntry[] = [];
  private readonly metrics = new Map<string, FunctionMetrics>();
  private readonly inFlight = new Map<string, number>();
  private readonly warmed = new Set<string>();
  private jobCounter = 0;
  private logCounter = 0;

  constructor(
    private readonly runtime: FunctionRuntime,
    private readonly opts: FunctionServiceOptions,
  ) {}

  // ── Records ──────────────────────────────────────────────────────────

  private requireFunction(projectId: string, idOrSlug: string): FunctionRecord {
    const fn =
      this.functions.get(idOrSlug) ??
      [...this.functions.values()].find(f => f.projectId === projectId && f.slug === idOrSlug);
    if (!fn || fn.projectId !== projectId) {
      throw new FunctionError('NOT_FOUND', 'Function not found', 404);
    }
    return fn;
  }

  private metricsFor(functionId: string): FunctionMetrics {
    let m = this.metrics.get(functionId);
    if (!m) {
      m = {
        invocations: 0,
        successes: 0,
        failures: 0,
        timeouts: 0,
        rateLimited: 0,
        totalExecutionMs: 0,
        coldStarts: 0,
        maxExecutionMs: 0,
        deployFailures: 0,
        activeVersions: 0,
      };
      this.metrics.set(functionId, m);
    }
    return m;
  }

  async createFunction(input: {
    projectId: string;
    organizationId: string;
    userId: string;
    name: string;
    slug: string;
    description?: unknown;
    runtime?: unknown;
    entrypoint?: unknown;
  }): Promise<ExposedFunction> {
    const slug = assertFunctionSlug(input.slug);
    const existing = [...this.functions.values()].filter(f => f.projectId === input.projectId);
    if (existing.length >= this.opts.limits.maxFunctionsPerProject) {
      throw new FunctionError('LIMIT_EXCEEDED', 'Function limit reached for this project', 403);
    }
    if (existing.some(f => f.slug === slug)) {
      throw new FunctionError('CONFLICT', 'Function slug taken in this project', 409);
    }
    const now = new Date().toISOString();
    const fn: FunctionRecord = {
      id: randomUUID(),
      projectId: input.projectId,
      organizationId: input.organizationId,
      name: assertFunctionName(input.name),
      slug,
      description: assertDescription(input.description),
      runtime: input.runtime === undefined ? 'node22' : assertRuntime(input.runtime),
      entrypoint: assertEntrypoint(input.entrypoint),
      status: 'creating',
      activeVersion: 0,
      lastError: null,
      createdBy: input.userId,
      createdAt: now,
      updatedAt: now,
      deployedAt: null,
    };
    this.functions.set(fn.id, fn);
    this.versions.set(fn.id, []);
    this.env.set(fn.id, new Map());
    this.metricsFor(fn.id);
    return exposeFunction(fn);
  }

  async updateFunction(
    projectId: string,
    idOrSlug: string,
    patch: { name?: unknown; description?: unknown; runtime?: unknown; entrypoint?: unknown },
  ): Promise<ExposedFunction> {
    const fn = this.requireFunction(projectId, idOrSlug);
    if (fn.status === 'deleting')
      throw new FunctionError('CONFLICT', 'Function is being deleted', 409);
    if (patch.name !== undefined) fn.name = assertFunctionName(patch.name as string);
    if (patch.description !== undefined) fn.description = assertDescription(patch.description);
    let runtime: FunctionRuntimeName = fn.runtime;
    if (patch.runtime !== undefined) runtime = assertRuntime(patch.runtime);
    let entrypoint = fn.entrypoint;
    if (patch.entrypoint !== undefined) entrypoint = assertEntrypoint(patch.entrypoint);
    fn.runtime = runtime;
    fn.entrypoint = entrypoint;
    fn.updatedAt = new Date().toISOString();
    return exposeFunction(fn);
  }

  async deleteFunction(projectId: string, idOrSlug: string): Promise<void> {
    const fn = this.requireFunction(projectId, idOrSlug);
    fn.status = 'deleting';
    fn.updatedAt = new Date().toISOString();
    // Drain: refuse new invocations immediately, then drop records.
    this.functions.delete(fn.id);
    this.versions.delete(fn.id);
    this.sources.delete(fn.id);
    this.env.delete(fn.id);
    this.inFlight.delete(fn.id);
    for (const [jobId, job] of this.jobs) {
      if (job.functionId === fn.id) this.jobs.delete(jobId);
    }
  }

  async getFunction(projectId: string, idOrSlug: string): Promise<ExposedFunction> {
    return exposeFunction(this.requireFunction(projectId, idOrSlug));
  }

  async listFunctions(projectId: string): Promise<ExposedFunction[]> {
    return [...this.functions.values()]
      .filter(f => f.projectId === projectId)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .map(exposeFunction);
  }

  /** Reported status: READY with in-flight work surfaces as RUNNING (honest). */
  async getFunctionStatus(
    projectId: string,
    idOrSlug: string,
  ): Promise<{ status: FunctionStatus; activeInvocations: number; activeVersion: number }> {
    const fn = this.requireFunction(projectId, idOrSlug);
    const active = this.inFlight.get(fn.id) ?? 0;
    const status: FunctionStatus = fn.status === 'ready' && active > 0 ? 'running' : fn.status;
    return { status, activeInvocations: active, activeVersion: fn.activeVersion };
  }

  // ── Deployments (async job pipeline) ─────────────────────────────────

  async deployFunction(input: {
    projectId: string;
    organizationId: string;
    userId: string;
    idOrSlug: string;
    source: unknown;
    runtime?: unknown;
    entrypoint?: unknown;
    idempotencyKey?: string | null;
  }): Promise<{ job: DeployJob; fn: ExposedFunction }> {
    const fn = this.requireFunction(input.projectId, input.idOrSlug);
    const source = assertSource(input.source, this.opts.limits.maxDeploymentBytes);
    const runtime = input.runtime === undefined ? fn.runtime : assertRuntime(input.runtime);
    const entrypoint =
      input.entrypoint === undefined ? fn.entrypoint : assertEntrypoint(input.entrypoint);
    if (input.idempotencyKey) {
      const dup = [...this.jobs.values()].find(
        j =>
          j.functionId === fn.id &&
          j.idempotencyKey === input.idempotencyKey &&
          j.status !== 'failed',
      );
      if (dup) return { job: dup, fn: exposeFunction(fn) };
    }
    const sourceHash = createHash('sha256').update(source, 'utf8').digest('hex');
    const prior = (this.versions.get(fn.id) ?? []).find(
      v => v.sourceHash === sourceHash && v.runtime === runtime && v.entrypoint === entrypoint,
    );
    const versionNumber = prior ? prior.version : (this.versions.get(fn.id) ?? []).length + 1;
    this.jobCounter += 1;
    const now = new Date().toISOString();
    const job: DeployJob = {
      id: `fnjob_${this.jobCounter}`,
      functionId: fn.id,
      projectId: fn.projectId,
      organizationId: fn.organizationId,
      version: versionNumber,
      status: 'pending',
      idempotencyKey: input.idempotencyKey ?? null,
      attempts: 0,
      lastError: null,
      logs: [],
      createdAt: now,
      updatedAt: now,
    };
    this.jobs.set(job.id, job);
    fn.status = 'building';
    fn.lastError = null;
    fn.updatedAt = now;
    // Async pipeline — HTTP returns the job immediately, never blocks on builds.
    void this.runDeployPipeline(fn.id, job.id, {
      source,
      sourceHash,
      runtime,
      entrypoint,
      userId: input.userId,
    });
    return { job, fn: exposeFunction(fn) };
  }

  async redeployFunction(input: {
    projectId: string;
    organizationId: string;
    userId: string;
    idOrSlug: string;
    idempotencyKey?: string | null;
  }): Promise<{ job: DeployJob; fn: ExposedFunction }> {
    const fn = this.requireFunction(input.projectId, input.idOrSlug);
    const list = this.versions.get(fn.id) ?? [];
    const latest = list[list.length - 1];
    if (!latest) throw new FunctionError('NOT_DEPLOYED', 'Nothing to redeploy yet', 409);
    const source = this.sources.get(`${fn.id}:v${latest.version}`);
    if (!source) throw new FunctionError('NOT_DEPLOYED', 'Version source unavailable', 409);
    return this.deployFunction({
      ...input,
      source,
      runtime: latest.runtime,
      entrypoint: latest.entrypoint,
    });
  }

  private jobLog(job: DeployJob, line: string): void {
    job.logs.push(`[${new Date().toISOString()}] ${line.slice(0, 500)}`);
    job.updatedAt = new Date().toISOString();
  }

  private async runDeployPipeline(
    functionId: string,
    jobId: string,
    build: {
      source: string;
      sourceHash: string;
      runtime: FunctionRuntimeName;
      entrypoint: string;
      userId: string;
    },
  ): Promise<void> {
    const job = this.jobs.get(jobId);
    const fn = this.functions.get(functionId);
    if (!job || !fn) return;
    const fail = (message: string): void => {
      job.status = 'failed';
      job.lastError = message.slice(0, 300);
      this.jobLog(job, `FAILED: ${message.slice(0, 200)}`);
      fn.status = 'failed';
      fn.lastError = message.slice(0, 300);
      fn.updatedAt = new Date().toISOString();
      this.metricsFor(fn.id).deployFailures += 1;
    };
    try {
      job.status = 'building';
      this.jobLog(
        job,
        `Building version (runtime ${build.runtime}, entrypoint ${build.entrypoint})`,
      );
      // Build = syntax check + entrypoint resolution in a throwaway isolate.
      // Anything that cannot load or export the entrypoint fails the build —
      // READY is only ever reported after a verified artifact exists.
      await this.verifyBuildable(build.source, build.entrypoint);
      const list = this.versions.get(fn.id) ?? [];
      let version = list.find(
        v =>
          v.sourceHash === build.sourceHash &&
          v.runtime === build.runtime &&
          v.entrypoint === build.entrypoint,
      );
      if (!version) {
        const now = new Date().toISOString();
        version = {
          functionId: fn.id,
          projectId: fn.projectId,
          version: list.length + 1,
          sourceHash: build.sourceHash,
          sourceBytes: Buffer.byteLength(build.source, 'utf8'),
          runtime: build.runtime,
          entrypoint: build.entrypoint,
          active: false,
          createdBy: build.userId,
          createdAt: now,
        };
        list.push(version);
        this.sources.set(`${fn.id}:v${version.version}`, build.source);
      }
      job.version = version.version;
      job.status = 'deploying';
      fn.status = 'deploying';
      fn.updatedAt = new Date().toISOString();
      this.jobLog(job, `Deploying v${version.version} (${version.sourceBytes} bytes)`);
      await this.runtimeActivate(fn, version.version, build.source);
      for (const v of list) v.active = v.version === version.version;
      fn.activeVersion = version.version;
      fn.runtime = version.runtime;
      fn.entrypoint = version.entrypoint;
      fn.status = 'ready';
      fn.lastError = null;
      const now = new Date().toISOString();
      fn.updatedAt = now;
      fn.deployedAt = now;
      job.status = 'ready';
      this.jobLog(job, `READY — v${version.version} active`);
      this.metricsFor(fn.id).activeVersions = 1;
    } catch (err) {
      fail(err instanceof FunctionError ? err.message : 'Deployment failed');
    }
  }

  /**
   * Build verification: load the real source in a throwaway isolate and prove
   * the entrypoint export exists — without invoking the handler (no
   * customer side effects at deploy time). Syntax errors, load-time throws,
   * hangs, and missing exports all fail the build, so READY always means a
   * verified artifact exists.
   */
  private async verifyBuildable(source: string, entrypoint: string): Promise<void> {
    const entry = entrypoint.split('.');
    if (entry.some(p => !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(p))) {
      throw new FunctionError('BUILD_FAILED', 'Invalid entrypoint path', 400);
    }
    const probe =
      `${source}\n;module.exports.__cn_verify_result = async () => ({ status: 200, body: (() => { ` +
      `try { let t = module.exports; for (const p of ${JSON.stringify(entrypoint)}.split('.')) t = t?.[p]; ` +
      `return typeof t; } catch { return 'missing'; } })() });`;
    let outcome: InvocationOutcome | null = null;
    try {
      outcome = await this.invokeProbe(probe);
    } catch (err) {
      throw new FunctionError(
        'BUILD_FAILED',
        `Source failed to load: ${err instanceof FunctionError ? err.message.slice(0, 160) : 'load error'}`,
        400,
      );
    }
    if (!outcome || outcome.result.body !== 'function') {
      throw new FunctionError(
        'BUILD_FAILED',
        `Entrypoint export not found: ${entrypoint.slice(0, 80)}`,
        400,
      );
    }
  }

  /** Dry-run probe: loads source + returns the entrypoint typeof, never the handler. */
  private async invokeProbe(probeSource: string): Promise<InvocationOutcome> {
    const out = await this.runtime.execute({
      source: probeSource,
      entrypoint: '__cn_verify_result',
      request: { method: 'GET', path: '/', headers: {}, query: {}, body: null },
      auth: { userId: null, email: null, role: 'system', projectId: '', callerKind: 'public' },
      env: {},
      timeoutMs: 5000,
      memoryMb: 64,
      maxResponseBytes: 1024,
    });
    return {
      result: { status: out.status, headers: out.headers, body: out.body },
      executionTimeMs: out.executionTimeMs,
      coldStart: true,
      memoryUsedBytes: out.memoryUsedBytes,
      version: 0,
      requestId: 'build-probe',
    };
  }

  /** Runtime-specific activation (docker bakes the image; worker needs none). */
  private async runtimeActivate(
    fn: FunctionRecord,
    version: number,
    source: string,
  ): Promise<void> {
    const rt = this.runtime as unknown as {
      driver?: string;
      buildImage?: (tag: string, src: string, entry: string) => Promise<void>;
    };
    if (rt.driver === 'docker' && typeof rt.buildImage === 'function') {
      await rt
        .buildImage(`cn-fn-${fn.id}-v${version}`.toLowerCase(), source, fn.entrypoint)
        .catch(err => {
          throw new FunctionError(
            'BUILD_FAILED',
            err instanceof FunctionError ? err.message : 'Container build failed',
            500,
          );
        });
    }
  }

  async listDeployments(projectId: string, idOrSlug: string): Promise<DeployJob[]> {
    const fn = this.requireFunction(projectId, idOrSlug);
    return [...this.jobs.values()]
      .filter(j => j.functionId === fn.id)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  async getDeployment(projectId: string, idOrSlug: string, jobId: string): Promise<DeployJob> {
    const fn = this.requireFunction(projectId, idOrSlug);
    const job = this.jobs.get(jobId);
    if (!job || job.functionId !== fn.id)
      throw new FunctionError('NOT_FOUND', 'Deployment not found', 404);
    return job;
  }

  // ── Versions ─────────────────────────────────────────────────────────

  async listVersions(projectId: string, idOrSlug: string): Promise<ExposedVersion[]> {
    const fn = this.requireFunction(projectId, idOrSlug);
    return [...(this.versions.get(fn.id) ?? [])].reverse().map(v => ({
      version: v.version,
      sourceHash: v.sourceHash,
      sourceBytes: v.sourceBytes,
      runtime: v.runtime,
      entrypoint: v.entrypoint,
      active: v.active,
      createdAt: v.createdAt,
    }));
  }

  /** Rollback: reactivate a previous immutable version (deploys nothing new). */
  async activateVersion(
    projectId: string,
    idOrSlug: string,
    version: number,
  ): Promise<ExposedFunction> {
    const fn = this.requireFunction(projectId, idOrSlug);
    const list = this.versions.get(fn.id) ?? [];
    const target = list.find(v => v.version === version);
    if (!target) throw new FunctionError('NOT_FOUND', 'Version not found', 404);
    for (const v of list) v.active = v.version === version;
    fn.activeVersion = version;
    fn.runtime = target.runtime;
    fn.entrypoint = target.entrypoint;
    fn.status = 'ready';
    fn.lastError = null;
    fn.updatedAt = new Date().toISOString();
    fn.deployedAt = fn.updatedAt;
    return exposeFunction(fn);
  }

  // ── Environment variables ────────────────────────────────────────────

  async setEnvVar(input: {
    projectId: string;
    userId: string;
    idOrSlug: string;
    key: unknown;
    value: unknown;
    secret?: unknown;
  }): Promise<ExposedEnvVar> {
    const fn = this.requireFunction(input.projectId, input.idOrSlug);
    const key = assertEnvKey(input.key);
    assertEnvWritable(key);
    const value = assertEnvValue(input.value, this.opts.maxEnvValueBytes);
    const secret = input.secret === true;
    const store = this.env.get(fn.id);
    if (!store) throw new FunctionError('NOT_FOUND', 'Function not found', 404);
    if (!store.has(key) && store.size >= 100) {
      throw new FunctionError('LIMIT_EXCEEDED', 'Too many environment variables', 403);
    }
    const now = new Date().toISOString();
    const prev = store.get(key);
    store.set(key, { value, secret, updatedAt: now });
    void input.userId;
    void prev;
    return { key, value: maskEnvValue(value, secret), secret, updatedAt: now };
  }

  async listEnvVars(projectId: string, idOrSlug: string): Promise<ExposedEnvVar[]> {
    const fn = this.requireFunction(projectId, idOrSlug);
    const store = this.env.get(fn.id);
    if (!store) return [];
    return [...store.entries()]
      .map(([key, v]) => ({
        key,
        value: maskEnvValue(v.value, v.secret),
        secret: v.secret,
        updatedAt: v.updatedAt,
      }))
      .sort((a, b) => (a.key < b.key ? -1 : 1));
  }

  async deleteEnvVar(projectId: string, idOrSlug: string, key: string): Promise<void> {
    const fn = this.requireFunction(projectId, idOrSlug);
    this.env.get(fn.id)?.delete(assertEnvKey(key));
  }

  private fullEnv(fn: FunctionRecord): { publicEnv: Record<string, string>; secrets: string[] } {
    const store = this.env.get(fn.id);
    const publicEnv: Record<string, string> = {};
    const secrets: string[] = [];
    if (store) {
      for (const [k, v] of store) {
        publicEnv[k] = v.value;
        if (v.secret) secrets.push(v.value);
      }
    }
    return { publicEnv, secrets };
  }

  // ── Invocation ───────────────────────────────────────────────────────

  async invokeFunction(input: {
    projectId: string;
    idOrSlug: string;
    request: FunctionHttpRequest;
    auth: FunctionAuthContext;
    requestId: string;
    rateLimit?: { incr(key: string, ttlSeconds: number): Promise<number> } | null;
    rateMax?: number;
    /** Project-bound data-plane capabilities for cloudnivo.* (optional). */
    sdkHooks?: SdkHooks;
  }): Promise<InvocationOutcome> {
    const fn = this.requireFunction(input.projectId, input.idOrSlug);
    if (fn.status !== 'ready' && fn.status !== 'running') {
      const code = fn.status === 'failed' ? 'DEPLOY_FAILED' : 'NOT_READY';
      throw new FunctionError(code, `Function is ${fn.status}`, fn.status === 'failed' ? 500 : 409);
    }
    if (fn.activeVersion < 1)
      throw new FunctionError('NOT_DEPLOYED', 'Function has no active version', 409);
    const version = (this.versions.get(fn.id) ?? []).find(v => v.version === fn.activeVersion);
    const source = this.sources.get(`${fn.id}:v${fn.activeVersion}`);
    if (!version || !source)
      throw new FunctionError('NOT_DEPLOYED', 'Active version unavailable', 409);
    if (input.rateLimit) {
      const budget = input.rateMax ?? 60;
      try {
        const count = await input.rateLimit.incr(`fn:invoke:${fn.id}`, 60);
        if (count > budget) {
          this.metricsFor(fn.id).rateLimited += 1;
          throw new FunctionError('RATE_LIMITED', 'Function invocation rate exceeded', 429);
        }
      } catch (err) {
        if (err instanceof FunctionError) throw err;
        // Rate-store outage fails open (logged upstream); never block invokes.
      }
    }
    const flying = this.inFlight.get(fn.id) ?? 0;
    if (flying >= this.opts.limits.maxConcurrency) {
      this.metricsFor(fn.id).rateLimited += 1;
      throw new FunctionError('CONCURRENCY_EXCEEDED', 'Too many concurrent executions', 429);
    }
    this.inFlight.set(fn.id, flying + 1);
    const metrics = this.metricsFor(fn.id);
    metrics.invocations += 1;
    const coldStart = !this.warmed.has(`${fn.id}:v${version.version}`);
    const { publicEnv, secrets } = this.fullEnv(fn);
    try {
      const out = await this.runtime.execute({
        source,
        entrypoint: version.entrypoint,
        request: input.request,
        auth: input.auth,
        env: publicEnv,
        timeoutMs: this.opts.limits.executionTimeoutMs,
        memoryMb: this.opts.limits.memoryMb,
        maxResponseBytes: this.opts.limits.maxResponseBytes,
        sdk: input.sdkHooks,
      });
      this.warmed.add(`${fn.id}:v${version.version}`);
      if (coldStart) metrics.coldStarts += 1;
      metrics.successes += 1;
      metrics.totalExecutionMs += out.executionTimeMs;
      metrics.maxExecutionMs = Math.max(metrics.maxExecutionMs, out.executionTimeMs);
      this.appendLog(
        fn,
        version.version,
        input.requestId,
        out.logs,
        'ok',
        out.executionTimeMs,
        secrets,
      );
      return {
        result: { status: out.status, headers: out.headers, body: out.body },
        executionTimeMs: out.executionTimeMs,
        coldStart,
        memoryUsedBytes: out.memoryUsedBytes,
        version: version.version,
        requestId: input.requestId,
      };
    } catch (err) {
      const timeout = err instanceof FunctionError && err.code === 'FUNCTION_TIMEOUT';
      if (timeout) metrics.timeouts += 1;
      else metrics.failures += 1;
      const message = err instanceof FunctionError ? err.message : 'Invocation failed';
      this.appendLog(
        fn,
        version.version,
        input.requestId,
        [{ level: 'error', message: redactSecrets(message, secrets).slice(0, 2000) }],
        timeout ? 'timeout' : 'error',
        null,
        secrets,
      );
      throw err instanceof FunctionError
        ? err
        : new FunctionError('INVOCATION_FAILED', message, 500);
    } finally {
      this.inFlight.set(fn.id, (this.inFlight.get(fn.id) ?? 1) - 1);
    }
  }

  private appendLog(
    fn: FunctionRecord,
    version: number,
    requestId: string,
    entries: { level: 'log' | 'warn' | 'error'; message: string }[],
    status: 'ok' | 'error' | 'timeout',
    executionTimeMs: number | null,
    secrets: string[],
  ): void {
    const cap = this.opts.limits.maxLogEntries;
    for (const e of entries.slice(0, 50)) {
      this.logCounter += 1;
      this.logs.push({
        id: `fnlog_${this.logCounter}`,
        functionId: fn.id,
        projectId: fn.projectId,
        version,
        requestId,
        timestamp: new Date().toISOString(),
        level: e.level,
        message: redactSecrets(e.message, secrets),
        executionTimeMs,
        status,
      });
    }
    // Bounded retention: per-function cap + age cutoff.
    const cutoff = Date.now() - this.opts.limits.logRetentionDays * 86_400_000;
    const kept = this.logs.filter(l => Date.parse(l.timestamp) >= cutoff);
    const perFn = new Map<string, number>();
    this.logs.length = 0;
    for (let i = kept.length - 1; i >= 0; i -= 1) {
      const l = kept[i];
      if (!l) continue;
      const n = perFn.get(l.functionId) ?? 0;
      if (n < cap) {
        perFn.set(l.functionId, n + 1);
        this.logs.unshift(l);
      }
    }
  }

  async getFunctionLogs(
    projectId: string,
    idOrSlug: string,
    opts: { limit?: number; level?: string } = {},
  ): Promise<FunctionLogEntry[]> {
    const fn = this.requireFunction(projectId, idOrSlug);
    const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
    return this.logs
      .filter(l => l.functionId === fn.id && (!opts.level || l.level === opts.level))
      .slice(-limit)
      .reverse();
  }

  async getMetrics(projectId: string, idOrSlug: string): Promise<FunctionMetrics> {
    const fn = this.requireFunction(projectId, idOrSlug);
    return { ...this.metricsFor(fn.id) };
  }
}

export { exposeVersion };
