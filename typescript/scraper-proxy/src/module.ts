import cors from '@fastify/cors';
import Fastify, { type FastifyInstance } from 'fastify';

import { metricsRegistry } from './metrics.js';
import type { ScraperDbDatabase } from './scraperdb/database.js';
import {
  MAX_REQUEST_BYTES,
  registerGraphqlRoute,
  type ScraperProxyAppOptions,
} from './scraperdb/graphql.js';

export type { ScraperProxyAppOptions } from './scraperdb/graphql.js';

export async function createScraperProxyApp(
  db: ScraperDbDatabase,
  options: ScraperProxyAppOptions = {},
): Promise<FastifyInstance> {
  const app = Fastify({
    bodyLimit: MAX_REQUEST_BYTES,
    logger: false,
    requestTimeout: 10_000,
    routerOptions: { caseSensitive: false, ignoreTrailingSlash: true },
  });
  await app.register(cors, { credentials: false, origin: true });
  registerMetricsRoute(app);
  // Scope admission and cache hooks to GraphQL; metrics stay independent.
  await app.register(async (graphql) =>
    registerGraphqlRoute(graphql, db, options),
  );
  return app;
}

export function registerMetricsRoute(app: FastifyInstance): void {
  app.get('/metrics', async (_request, reply) => {
    reply.type(metricsRegistry.contentType);
    return metricsRegistry.metrics();
  });
}
