import { createServer, type Server } from 'node:http';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { loadConfig, loadDotEnv } from '@cloudnivo/config';
import { runControlMigrations } from '@cloudnivo/database';
import { createLogger } from '@cloudnivo/logging';
import { createContext, handleRequest, initControlPlane, type ApiContext } from './v1.js';
import { resolveListenPort } from './platform-port.js';
import { realtimeFor } from './realtime.js';

export async function start(
  port?: number,
): Promise<{ server: Server; port: number; ctx: ApiContext }> {
  await loadDotEnv();
  const config = loadConfig();
  const logger = createLogger({ service: 'api' });
  if (config.MIGRATE_ON_BOOT) {
    const folder = path.join(process.cwd(), 'packages', 'database', 'drizzle');
    if (!existsSync(folder)) {
      throw new Error(`MIGRATE_ON_BOOT requested but no drizzle folder at ${folder}`);
    }
    logger.info('migrate on boot', { folder });
    await runControlMigrations(config.DATABASE_URL, folder);
    logger.info('migrate on boot complete');
  }
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
  const listenPort = resolveListenPort(port, config.API_PORT);
  await new Promise<void>(resolve => server.listen(listenPort, resolve));
  const addr = server.address();
  const actual = typeof addr === 'object' && addr ? addr.port : listenPort;
  logger.info(`api listening`, { port: actual });
  return { server, port: actual, ctx };
}

// Entrypoint only when run directly (`node dist/index.js` / `tsx src/index.ts`).
const isMain = process.argv[1]?.endsWith('index.ts') || process.argv[1]?.endsWith('index.js');
if (isMain) {
  start()
    .then(({ server, ctx }) => {
      let shuttingDown = false;
      const shutdown = async (): Promise<void> => {
        if (shuttingDown) return;
        shuttingDown = true;
        const logger = createLogger({ service: 'api' });
        logger.info('shutting down');
        await new Promise<void>(resolve => server.close(() => resolve()));
        if (ctx.controlDb) await ctx.controlDb.close().catch(() => undefined);
        logger.info('stopped');
        process.exit(0);
      };
      process.on('SIGTERM', () => void shutdown());
      process.on('SIGINT', () => void shutdown());
    })
    .catch(err => {
      const logger = createLogger({ service: 'api' });
      logger.error('failed to start', { error: err instanceof Error ? err.message : String(err) });
      process.exit(1);
    });
}
