import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';

import { AppModule } from './module.js';
import { config } from './config.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  app.enableCors({
    allowedHeaders: ['content-type', 'x-apollo-operation-name'],
    credentials: false,
    origin: true,
  });
  await app.listen(config.PORT);
}

await bootstrap();
