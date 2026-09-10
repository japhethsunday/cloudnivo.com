import { createServer, type Server } from 'node:http';
import { loadConfig, loadDotEnv } from '@cloudnivo/config';
import { createLogger } from '@cloudnivo/logging';
import { createContext, handleRequest, initControlPlane } from './v1.js';
import { realtimeFor } from './realtime.js';

export async function start(port?: number): Promise<{ server: Server; port: number }> {
  await loadDotEnv();
  const config = loadConfig();
  const logger = createLogger({ service: 'api' });
  const ctx = createContext(config);
  await initControlPlane(ctx);
  const server = createServer((req, res) => {
    handleRequest(req, res, ctx).catch(err => {
      logger.error('unhandled request error', { error: String(err) });
      try {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'INTERNAL', message: 'Internal server error' } }));
      } catch {
        // socket already closed
      }
    });
  });
  // Realtime upgrades share the API port (same auth, same envelope semantics).
  realtimeFor(ctx).server.attach(server);
  const listenPort = port ?? config.API_PORT;
  await new Promise<void>(resolve => server.listen(listenPort, resolve));
  const addr = server.address();
  const actual = typeof addr === 'object' && addr ? addr.port : listenPort;
  logger.info(`api listening`, { port: actual });
  return { server, port: actual };
}

// Entrypoint only when run directly (`node dist/index.js` / `tsx src/index.ts`).
const isMain = process.argv[1]?.endsWith('index.ts') || process.argv[1]?.endsWith('index.js');
if (isMain) {
  start().catch(err => {
    const logger = createLogger({ service: 'api' });
    logger.error('failed to start', { error: err instanceof Error ? err.message : String(err) });
    process.exit(1);
  });
}
