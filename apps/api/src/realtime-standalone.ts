import { createServer } from 'node:http';
import { loadConfig, loadDotEnv } from '@cloudnivo/config';
import { createLogger } from '@cloudnivo/logging';
import { createContext, initControlPlane } from './v1.js';
import { realtimeFor } from './realtime.js';

/**
 * Standalone realtime entrypoint — same gateway/bus/presence/auth code as the
 * in-process upgrade path, on its own port for independent Railway scaling.
 * Run with REALTIME_STANDALONE=true (or directly in deploys that want a
 * dedicated realtime service). Control-plane data still resolves through the
 * shared registry/stores; durable stores (Phase 7) make this multi-replica.
 */
export async function startRealtime(
  port?: number,
): Promise<{ close: () => Promise<void>; port: number }> {
  await loadDotEnv();
  const config = loadConfig();
  const logger = createLogger({ service: 'realtime' });
  const ctx = createContext(config);
  await initControlPlane(ctx);
  const state = realtimeFor(ctx);
  const server = createServer((_req, res) => {
    if (_req.url === '/api/v1/health' && _req.method === 'GET') {
      const payload = JSON.stringify({ data: { status: 'ok', service: 'realtime' } });
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      });
      res.end(payload);
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Use the WebSocket endpoint' } }),
    );
  });
  state.server.attach(server);
  const listenPort = port ?? config.REALTIME_PORT;
  await new Promise<void>(resolve => server.listen(listenPort, resolve));
  const addr = server.address();
  const actual = typeof addr === 'object' && addr ? addr.port : listenPort;
  logger.info('realtime listening', { port: actual, driver: config.REALTIME_DRIVER });

  const shutdown = async (): Promise<void> => {
    await state.server.shutdown();
    await new Promise<void>(resolve => server.close(() => resolve()));
  };
  process.on('SIGTERM', () => {
    void shutdown().then(() => process.exit(0));
  });
  process.on('SIGINT', () => {
    void shutdown().then(() => process.exit(0));
  });
  return { close: shutdown, port: actual };
}

const isMain =
  process.argv[1]?.endsWith('realtime-standalone.ts') ||
  process.argv[1]?.endsWith('realtime-standalone.js');
if (isMain) {
  startRealtime().catch(err => {
    const logger = createLogger({ service: 'realtime' });
    logger.error('failed to start', { error: err instanceof Error ? err.message : String(err) });
    process.exit(1);
  });
}
