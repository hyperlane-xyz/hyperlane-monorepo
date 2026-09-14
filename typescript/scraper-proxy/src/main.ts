import 'zod/compile';
import { rootLogger } from '@hyperlane-xyz/utils';
import { formatError } from '@hyperlane-xyz/utils/errors';

import { config } from './config.js';
import { DbService } from './db/db.service.js';
import { EventWebSocketServer } from './live/event-websocket.js';
import {
  setDatabaseMetricsProvider,
  setWebSocketMetricsProvider,
} from './metrics.js';
import { createScraperProxyApp } from './module.js';

const logger = rootLogger.child({ module: 'Shutdown' });

async function bootstrap(): Promise<void> {
  const db = new DbService();
  let app: Awaited<ReturnType<typeof createScraperProxyApp>> | undefined;
  let eventWebSocketServer: EventWebSocketServer | undefined;
  try {
    await db.onModuleInit();
    app = await createScraperProxyApp(db);
    const createdEventWebSocketServer = new EventWebSocketServer(db);
    eventWebSocketServer = createdEventWebSocketServer;
    setDatabaseMetricsProvider(() => db.metricsSnapshot());
    setWebSocketMetricsProvider(() =>
      createdEventWebSocketServer.metricsSnapshot(),
    );
    await createdEventWebSocketServer.start(app.server);
    await app.listen({ host: '0.0.0.0', port: config.PORT });
  } catch (error) {
    await cleanupAfterStartupFailure('websocket', () =>
      eventWebSocketServer?.stop(),
    );
    await cleanupAfterStartupFailure('http', () => app?.close());
    await cleanupAfterStartupFailure('database', () => db.onModuleDestroy());
    throw error;
  }
  let stopping = false;
  const stop = async (): Promise<void> => {
    try {
      await eventWebSocketServer.stop();
    } finally {
      try {
        await app.close();
      } finally {
        await db.onModuleDestroy();
      }
    }
  };
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      if (stopping) return;
      stopping = true;
      void stop().catch((error: unknown) => {
        logger.error(`shutdown failed: ${formatError(error)}`);
        process.exitCode = 1;
      });
    });
  }
}

async function cleanupAfterStartupFailure(
  component: string,
  cleanup: () => Promise<unknown> | undefined,
): Promise<void> {
  try {
    await cleanup();
  } catch (error) {
    logger.error(
      `startup cleanup failed component=${component}: ${formatError(error)}`,
    );
  }
}

await bootstrap();
