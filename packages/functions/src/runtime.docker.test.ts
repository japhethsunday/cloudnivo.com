import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { DockerFunctionRuntime } from './runtime.js';

const execFileAsync = promisify(execFile);

async function dockerPresent(): Promise<boolean> {
  try {
    await execFileAsync('docker', ['version', '--format', '{{.Server.Version}}'], {
      timeout: 10_000,
    });
    return true;
  } catch {
    return false;
  }
}

// Real container build + execution. Runs only with DOCKER_TESTS=1 on a
// machine with Docker (image pull of node:22-alpine required once).
const runDocker = process.env.DOCKER_TESTS === '1';
describe.skipIf(!runDocker)('docker function runtime (integration)', () => {
  it('builds a version image and executes the handler isolated', async () => {
    if (!(await dockerPresent())) {
      console.warn('Docker not present; skipping live assertions');
      return;
    }
    const rt = new DockerFunctionRuntime({ memoryMb: 128, timeoutMs: 30_000 });
    expect(await rt.available()).toBe(true);
    const tag = `cn-fn-test-${Date.now() % 1000000}`.toLowerCase();
    try {
      await rt.buildImage(
        tag,
        `module.exports.handler = async (req) => ({ status: 200, body: { v: 9, user: req.auth.userId, need: typeof require } });`,
        'handler',
      );
      const out = await rt.execute({
        source: '',
        entrypoint: 'handler',
        request: { method: 'POST', path: '/', headers: {}, query: {}, body: null },
        auth: {
          userId: 'u-docker',
          email: null,
          role: 'member',
          projectId: 'p1',
          callerKind: 'session',
        },
        env: {},
        timeoutMs: 30_000,
        memoryMb: 128,
        maxResponseBytes: 1_048_576,
        imageTag: tag,
      });
      expect(out.status).toBe(200);
      expect(out.body).toMatchObject({ v: 9, user: 'u-docker', need: 'undefined' });
    } finally {
      await execFileAsync('docker', ['rmi', '-f', tag], { timeout: 60_000 }).catch(() => undefined);
      await rt.close();
    }
  }, 300_000);
});
