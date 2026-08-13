import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';

import { AppModule } from './module.js';
import { config } from './config.js';
import { DbService } from './db/db.service.js';
import { MessageWebSocketServer } from './live/message-websocket.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  app.enableCors({
    allowedHeaders: ['content-type', 'x-apollo-operation-name'],
    credentials: false,
    origin: true,
  });
  const server = await app.listen(config.PORT);
  const messageWebSocketServer = new MessageWebSocketServer(app.get(DbService));
  await messageWebSocketServer.start(server);
}

await bootstrap();
