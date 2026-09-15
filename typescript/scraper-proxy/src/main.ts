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
  const app = await createScraperProxyApp(db);
  const eventWebSocketServer = new EventWebSocketServer(db, {}, {
    agents: config.WORKLOAD_ROLE !== 'public',
    messages: config.WORKLOAD_ROLE !== 'agents',
  });
  setDatabaseMetricsProvider(() => db.metricsSnapshot());
  setWebSocketMetricsProvider(() => eventWebSocketServer.metricsSnapshot());
  app.addHook('onReady', () => db.start());
  app.addHook('onReady', () => eventWebSocketServer.start(app.server));
  app.addHook('preClose', () => eventWebSocketServer.stop());
  app.addHook('onClose', () => db.close());
  try {
    await app.listen({ host: '0.0.0.0', port: config.PORT });
  } catch (error) {
    await cleanupAfterStartupFailure('application', () => app.close());
    throw error;
  }
  let stopping = false;
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      if (stopping) return;
      stopping = true;
      void app.close().catch((error: unknown) => {
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
