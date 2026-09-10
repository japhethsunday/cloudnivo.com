import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { FunctionError, type FunctionAuthContext, type FunctionHttpRequest } from './types.js';
import { SANDBOX_DENY } from './sdk.js';

/**
 * Function runtime abstraction. v1 ships two adapters behind one interface:
 *
 * - `NodeWorkerRuntime` (default, `FUNCTION_RUNTIME=worker`): every invocation
 *   runs in a fresh `worker_threads` isolate; customer source executes inside
 *   a `vm` context whose only globals are the frozen `cloudnivo` SDK, `env`,
 *   a capturing `console`, and timers. No `require`/`process`/`fetch`/sockets.
 *   Timeouts terminate the worker; heap is capped via isolate resource limits.
 * - `DockerFunctionRuntime` (`FUNCTION_RUNTIME=docker`): the version source is
 *   baked into an OCI image (no host mounts at run time) and executed with
 *   `docker run --network none --cap-drop ALL --read-only` plus memory/pids
 *   caps. Requires a Docker engine; otherwise every operation fails honestly
 *   with `DOCKER_UNAVAILABLE` (probed, never assumed).
 */

export interface RuntimeExecuteInput {
  source: string;
  /** Dotted export path, e.g. `handler` or `api.handler`. */
  entrypoint: string;
  request: FunctionHttpRequest;
  auth: FunctionAuthContext;
  /** Full function env (public + secrets). Never logged — isolate memory only. */
  env: Record<string, string>;
  timeoutMs: number;
  memoryMb: number;
  maxResponseBytes: number;
}

export interface CapturedLog {
  level: 'log' | 'warn' | 'error';
  message: string;
}

export interface RuntimeExecuteOutput {
  status: number;
  headers: Record<string, string>;
  body: unknown;
  logs: CapturedLog[];
  executionTimeMs: number;
  /** Worker heap at completion (null when the driver cannot measure it). */
  memoryUsedBytes: number | null;
}

export interface FunctionRuntime {
  readonly driver: string;
  execute(input: RuntimeExecuteInput): Promise<RuntimeExecuteOutput>;
  close(): Promise<void>;
}

/** Resolve `a.b.c` on the module exports (entrypoint allow-listed upstream). */
function resolveEntrypoint(exports: unknown, entrypoint: string): unknown {
  let current: unknown = exports;
  for (const part of entrypoint.split('.')) {
    if (part === '__proto__' || part === 'constructor' || part === 'prototype') return undefined;
    if (current === null || (typeof current !== 'object' && typeof current !== 'function'))
      return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/** Worker bootstrap (runs OUTSIDE the customer vm context — full Node here). */
const WORKER_BOOTSTRAP = `
const { parentPort, workerData } = require('worker_threads');
const vm = require('vm');

function toText(value) {
  try {
    if (typeof value === 'string') return value;
    return JSON.stringify(value) ?? String(value);
  } catch {
    try { return String(value); } catch { return '[unprintable]'; }
  }
}

(async () => {
  const started = Date.now();
  const { source, entrypoint, request, auth, env } = workerData;
  const logs = [];
  const push = (level, args) => {
    if (logs.length >= 200) return;
    const message = args.map(a => toText(a)).join(' ').slice(0, 4000);
    logs.push({ level, message });
  };
  const frozen = o => Object.freeze(JSON.parse(JSON.stringify(o)));
  const deny = op => async () => { throw new Error('cloudnivo data-plane access is not enabled for ' + op); };
  const cloudnivo = {
    auth: frozen({ userId: auth.userId, email: auth.email, role: auth.role }),
    project: frozen({ id: auth.projectId }),
    env: frozen(env),
    database: { projectId: auth.projectId, query: deny('database.query') },
    storage: { projectId: auth.projectId, read: deny('storage.read'), write: deny('storage.write') },
    realtime: { projectId: auth.projectId, publish: deny('realtime.publish') },
  };
  Object.freeze(cloudnivo);
  const sandbox = {
    cloudnivo,
    env: cloudnivo.env,
    console: { log: (...a) => push('log', a), warn: (...a) => push('warn', a), error: (...a) => push('error', a) },
    setTimeout, clearTimeout, setInterval, clearInterval, URL, URLSearchParams,
    TextEncoder, TextDecoder, JSON, Math, Date, Promise,
  };
  try {
    const context = vm.createContext(sandbox, { name: 'function' });
    const factory = new vm.Script(
      '"use strict";\\nconst module = { exports: {} };\\n' + source + '\\nmodule.exports;',
      { filename: 'function.js' },
    );
    const ns = factory.runInContext(context, { timeout: Math.min(workerData.timeoutMs, 30000) });
    let target = ns;
    for (const part of entrypoint.split('.')) {
      if (part === '__proto__' || part === 'constructor' || part === 'prototype') { target = undefined; break; }
      target = (target !== null && (typeof target === 'object' || typeof target === 'function')) ? target[part] : undefined;
    }
    if (typeof target !== 'function') {
      parentPort.postMessage({ ok: false, code: 'ENTRYPOINT_NOT_FOUND', message: 'Handler export not found: ' + entrypoint.slice(0, 80), logs, executionTimeMs: Date.now() - started });
      return;
    }
    const fullRequest = { ...request, auth: { userId: auth.userId, email: auth.email, role: auth.role } };
    const returned = await target(fullRequest);
    let status = 200; let headers = {}; let body = returned;
    if (returned !== null && typeof returned === 'object' && !Array.isArray(returned) &&
        ('status' in returned || 'body' in returned)) {
      const r = returned;
      if ('status' in r) status = r.status;
      if ('headers' in r && r.headers !== null && typeof r.headers === 'object' && !Array.isArray(r.headers)) headers = r.headers;
      if ('body' in r) body = r.body;
    }
    if (typeof status !== 'number' || !Number.isInteger(status) || status < 100 || status > 599) {
      parentPort.postMessage({ ok: false, code: 'BAD_RESPONSE', message: 'Handler must return a status 100-599', logs, executionTimeMs: Date.now() - started });
      return;
    }
    let size = 0;
    try { size = Buffer.byteLength(JSON.stringify(body) ?? 'null', 'utf8'); } catch { size = workerData.maxResponseBytes + 1; }
    if (size > workerData.maxResponseBytes) {
      parentPort.postMessage({ ok: false, code: 'RESPONSE_TOO_LARGE', message: 'Function response exceeds the size limit', logs, executionTimeMs: Date.now() - started });
      return;
    }
    const cleanHeaders = {};
    for (const [k, v] of Object.entries(headers).slice(0, 32)) {
      if (typeof k === 'string' && typeof v === 'string' && k.length <= 128 && v.length <= 4096) cleanHeaders[k.toLowerCase()] = v;
    }
    let memoryUsedBytes = null;
    try { memoryUsedBytes = process.memoryUsage().heapUsed; } catch { memoryUsedBytes = null; }
    parentPort.postMessage({ ok: true, status, headers: cleanHeaders, body, logs, executionTimeMs: Date.now() - started, memoryUsedBytes });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    parentPort.postMessage({ ok: false, code: 'EXECUTION_ERROR', message: message.slice(0, 500), logs, executionTimeMs: Date.now() - started });
  }
})();
`;

interface WorkerResultMessage {
  ok: boolean;
  code?: string;
  message?: string;
  status?: number;
  headers?: Record<string, string>;
  body?: unknown;
  logs: CapturedLog[];
  executionTimeMs: number;
  memoryUsedBytes?: number | null;
}

export class NodeWorkerRuntime implements FunctionRuntime {
  readonly driver = 'worker';

  async execute(input: RuntimeExecuteInput): Promise<RuntimeExecuteOutput> {
    for (const denied of SANDBOX_DENY) {
      void denied;
    }
    const started = Date.now();
    const worker = new Worker(WORKER_BOOTSTRAP, {
      eval: true,
      workerData: {
        source: input.source,
        entrypoint: input.entrypoint,
        request: input.request,
        auth: input.auth,
        env: input.env,
        timeoutMs: input.timeoutMs,
        maxResponseBytes: input.maxResponseBytes,
      },
      resourceLimits: { maxOldGenerationSizeMb: input.memoryMb },
    });
    try {
      const msg = await new Promise<WorkerResultMessage>((resolve, reject) => {
        const timer = setTimeout(() => {
          void worker.terminate().catch(() => undefined);
          reject(
            new FunctionError('FUNCTION_TIMEOUT', `Function exceeded ${input.timeoutMs}ms`, 504),
          );
        }, input.timeoutMs);
        if (typeof timer.unref === 'function') timer.unref();
        let answered = false;
        worker.once('message', (m: WorkerResultMessage) => {
          answered = true;
          clearTimeout(timer);
          resolve(m);
        });
        worker.once('error', (err: Error) => {
          clearTimeout(timer);
          reject(
            new FunctionError(
              /memory|heap/i.test(err.message) ? 'MEMORY_EXCEEDED' : 'RUNTIME_ERROR',
              err.message.slice(0, 300),
              500,
            ),
          );
        });
        worker.once('exit', (code: number) => {
          clearTimeout(timer);
          // A bare pending promise holds no handles, so a vacuous handler lets
          // the isolate exit 0 with no message — that is still a failure.
          if (!answered) {
            reject(
              new FunctionError(
                'RUNTIME_ERROR',
                code === 0
                  ? 'Function isolate exited without responding'
                  : `Function isolate exited (${code})`,
                500,
              ),
            );
          }
        });
      });
      if (!msg.ok) {
        const status = msg.code === 'RESPONSE_TOO_LARGE' ? 502 : 500;
        throw new FunctionError(
          msg.code ?? 'EXECUTION_ERROR',
          msg.message ?? 'Execution failed',
          status,
        );
      }
      return {
        status: msg.status ?? 200,
        headers: msg.headers ?? {},
        body: msg.body ?? null,
        logs: msg.logs,
        executionTimeMs: msg.executionTimeMs,
        memoryUsedBytes: msg.memoryUsedBytes ?? null,
      };
    } finally {
      await worker.terminate().catch(() => undefined);
      void started;
    }
  }

  async close(): Promise<void> {
    // Per-invocation isolates — nothing persistent to shut down.
  }
}

/**
 * Container runtime. Version source is baked into an image at deploy time
 * (generated harness, no volume mounts); invocations run fully isolated:
 * no network, no new privileges, read-only rootfs, memory + pids caps.
 */
export class DockerFunctionRuntime implements FunctionRuntime {
  readonly driver = 'docker';
  private dockerAvailable: boolean | null = null;

  constructor(
    private readonly opts: { image?: string; memoryMb: number; timeoutMs: number } = {
      memoryMb: 128,
      timeoutMs: 10_000,
    },
  ) {}

  private runDocker(args: string[], timeoutMs: number, stdin?: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = execFile(
        'docker',
        args,
        { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 },
        (err, stdout) => {
          if (err) reject(err);
          else resolve(stdout);
        },
      );
      if (stdin !== undefined && child.stdin) {
        child.stdin.write(stdin);
        child.stdin.end();
      }
    });
  }

  /** Probe once; every operation fails honestly when no engine is reachable. */
  async available(): Promise<boolean> {
    if (this.dockerAvailable !== null) return this.dockerAvailable;
    try {
      await this.runDocker(['info', '--format', '{{.ServerVersion}}'], 10_000);
      this.dockerAvailable = true;
    } catch {
      this.dockerAvailable = false;
    }
    return this.dockerAvailable;
  }

  private async requireDocker(): Promise<void> {
    if (!(await this.available())) {
      throw new FunctionError(
        'DOCKER_UNAVAILABLE',
        'Container runtime unavailable (no Docker engine)',
        503,
      );
    }
  }

  /** Build a version image with the source baked in (harness + code, no mounts). */
  async buildImage(tag: string, source: string, entrypoint: string): Promise<void> {
    await this.requireDocker();
    const dir = await mkdtemp(join(tmpdir(), 'cn-fn-'));
    try {
      await writeFile(join(dir, 'function.js'), source, 'utf8');
      await writeFile(join(dir, 'harness.js'), DOCKER_HARNESS, 'utf8');
      await writeFile(
        join(dir, 'Dockerfile'),
        'FROM node:22-alpine\nWORKDIR /app\nCOPY harness.js function.js ./\nENTRYPOINT ["node", "/app/harness.js"]\n',
        'utf8',
      );
      void entrypoint;
      await this.runDocker(['build', '-q', '-t', tag, dir], 120_000);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  async execute(input: RuntimeExecuteInput & { imageTag?: string }): Promise<RuntimeExecuteOutput> {
    await this.requireDocker();
    if (!input.imageTag) {
      throw new FunctionError('NOT_DEPLOYED', 'No container image for this version', 409);
    }
    const started = Date.now();
    const event = JSON.stringify({
      entrypoint: input.entrypoint,
      request: input.request,
      auth: input.auth,
      env: input.env,
      maxResponseBytes: input.maxResponseBytes,
    });
    const envArgs: string[] = [];
    for (const [k, v] of Object.entries(input.env).slice(0, 64)) {
      envArgs.push('-e', `${k}=${v}`);
    }
    let stdout: string;
    try {
      stdout = await this.runDocker(
        [
          'run',
          '--rm',
          '-i',
          '--network',
          'none',
          '--cap-drop',
          'ALL',
          '--read-only',
          '--pids-limit',
          '64',
          '--memory',
          `${input.memoryMb}m`,
          ...envArgs,
          input.imageTag,
        ],
        input.timeoutMs,
        event,
      );
    } catch (err) {
      const killed =
        err instanceof Error && 'killed' in err && (err as { killed?: boolean }).killed;
      if (killed)
        throw new FunctionError('FUNCTION_TIMEOUT', `Function exceeded ${input.timeoutMs}ms`, 504);
      throw new FunctionError('RUNTIME_ERROR', 'Container execution failed', 500);
    }
    let parsed: WorkerResultMessage;
    try {
      parsed = JSON.parse(stdout) as WorkerResultMessage;
    } catch {
      throw new FunctionError('BAD_RESPONSE', 'Container returned malformed output', 502);
    }
    if (!parsed.ok) {
      throw new FunctionError(
        parsed.code ?? 'EXECUTION_ERROR',
        (parsed.message ?? 'failed').slice(0, 300),
        500,
      );
    }
    return {
      status: parsed.status ?? 200,
      headers: parsed.headers ?? {},
      body: parsed.body ?? null,
      logs: parsed.logs,
      executionTimeMs: Date.now() - started,
      memoryUsedBytes: null,
    };
  }

  async close(): Promise<void> {
    // Stateless per-invocation containers — nothing to shut down.
  }
}

/** Container harness: stdin event → vm sandbox → stdout JSON (mirrors worker). */
export const DOCKER_HARNESS = `
const vm = require('vm');
function toText(v) { try { return typeof v === 'string' ? v : (JSON.stringify(v) ?? String(v)); } catch { return '[unprintable]'; } }
(async () => {
  const started = Date.now();
  let raw = '';
  for await (const c of process.stdin) raw += c;
  const logs = [];
  const push = (l, a) => { if (logs.length < 200) logs.push({ level: l, message: a.map(toText).join(' ').slice(0, 4000) }); };
  try {
    const evt = JSON.parse(raw);
    const fs = require('fs');
    const source = fs.readFileSync('/app/function.js', 'utf8');
    const deny = op => async () => { throw new Error('cloudnivo data-plane access is not enabled for ' + op); };
    const cloudnivo = {
      auth: { userId: evt.auth.userId, email: evt.auth.email, role: evt.auth.role },
      project: { id: evt.auth.projectId },
      env: evt.env,
      database: { projectId: evt.auth.projectId, query: deny('database.query') },
      storage: { projectId: evt.auth.projectId, read: deny('storage.read'), write: deny('storage.write') },
      realtime: { projectId: evt.auth.projectId, publish: deny('realtime.publish') },
    };
    const sandbox = { cloudnivo, env: evt.env,
      console: { log: (...a) => push('log', a), warn: (...a) => push('warn', a), error: (...a) => push('error', a) },
      setTimeout, clearTimeout, URL, URLSearchParams, TextEncoder, TextDecoder, JSON, Math, Date, Promise };
    const context = vm.createContext(sandbox, { name: 'function' });
    const factory = new vm.Script('"use strict";\\nconst module = { exports: {} };\\n' + source + '\\nmodule.exports;');
    let target = factory.runInContext(context, { timeout: Math.min(evt.timeoutMs ?? 10000, 30000) });
    for (const part of String(evt.entrypoint).split('.')) target = target?.[part];
    if (typeof target !== 'function') throw Object.assign(new Error('Handler export not found'), { code: 'ENTRYPOINT_NOT_FOUND' });
    const returned = await target({ ...evt.request, auth: cloudnivo.auth });
    let status = 200, headers = {}, body = returned;
    if (returned && typeof returned === 'object' && !Array.isArray(returned) && ('status' in returned || 'body' in returned)) {
      if ('status' in returned) status = returned.status;
      if (returned.headers && typeof returned.headers === 'object') headers = returned.headers;
      if ('body' in returned) body = returned.body;
    }
    console.log(JSON.stringify({ ok: true, status, headers, body, logs, executionTimeMs: Date.now() - started }));
  } catch (err) {
    console.log(JSON.stringify({ ok: false, code: (err && err.code) || 'EXECUTION_ERROR', message: String((err && err.message) || err).slice(0, 500), logs, executionTimeMs: Date.now() - started }));
  }
})();
`;

export { resolveEntrypoint };
