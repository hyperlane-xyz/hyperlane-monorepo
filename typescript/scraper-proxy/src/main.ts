import 'reflect-metadata';

import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { AppModule } from './module.js';
import { config } from './config.js';
import { DbService } from './db/db.service.js';
import { EventWebSocketServer } from './live/event-websocket.js';
import {
  setDatabaseMetricsProvider,
  setWebSocketMetricsProvider,
} from './metrics.js';

const logger = new Logger('Shutdown');

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  app.enableCors({
    allowedHeaders: ['content-type', 'x-apollo-operation-name'],
    credentials: false,
    origin: true,
  });
  const db = app.get(DbService);
  const eventWebSocketServer = new EventWebSocketServer(db);
  setDatabaseMetricsProvider(() => db.metricsSnapshot());
  setWebSocketMetricsProvider(() => eventWebSocketServer.metricsSnapshot());
  const server = await app.listen(config.PORT);
  await eventWebSocketServer.start(server);
  let stopping = false;
  const stop = async (): Promise<void> => {
    try {
      await eventWebSocketServer.stop();
    } finally {
      await app.close();
    }
  };
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      if (stopping) return;
      stopping = true;
      void stop().catch((error: unknown) => {
        logger.error(
          `shutdown failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        process.exitCode = 1;
      });
    });
  }
}

await bootstrap();
