import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';

import { AppModule } from './module.js';
import { config } from './config.js';
import { DbService } from './db/db.service.js';
import { EventWebSocketServer } from './live/event-websocket.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  app.enableCors({
    allowedHeaders: ['content-type', 'x-apollo-operation-name'],
    credentials: false,
    origin: true,
  });
  const server = await app.listen(config.PORT);
  const eventWebSocketServer = new EventWebSocketServer(app.get(DbService));
  await eventWebSocketServer.start(server);
}

await bootstrap();
