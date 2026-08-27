import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ApolloServerPluginLandingPageDisabled } from '@apollo/server/plugin/disabled';
import { ApolloServerPluginCacheControl } from '@apollo/server/plugin/cacheControl';
import { ApolloDriver, type ApolloDriverConfig } from '@nestjs/apollo';
import {
  Logger,
  type MiddlewareConsumer,
  Module,
  type NestModule,
} from '@nestjs/common';
import { GraphQLModule } from '@nestjs/graphql';
import type { GraphQLFormattedError } from 'graphql';

import { config } from './config.js';
import { DbModule } from './db/db.module.js';
import { DbService } from './db/db.service.js';
import {
  graphqlActiveRequestLimit,
  graphqlActiveRequests,
  graphqlErrors,
  graphqlRequestDuration,
  graphqlRequests,
  MetricsController,
} from './metrics.js';
import { scraperDbCachePlugin } from './scraperdb/cache-plugin.js';
import { normalizeGraphqlRequestBody } from './scraperdb/request-compatibility.js';
import { buildResolvers } from './scraperdb/resolver-map.js';
import { sanitizeScraperDbSchema } from './scraperdb/schema.js';
import { ScraperDbService } from './scraperdb/scraperdb.service.js';
import { scraperProxyValidationRule } from './scraperdb/validation.js';

type Request = {
  body?: unknown;
  method?: string;
  originalUrl?: string;
  url?: string;
};
type Response = {
  end(body?: string): void;
  on(event: 'close' | 'finish', listener: () => void): void;
  setHeader(name: string, value: string): void;
  statusCode?: number;
};
type Stats = {
  errors: number;
  maxMs: number;
  rejected: number;
  requests: number;
  status4xx: number;
  status5xx: number;
  totalMs: number;
};

const logger = new Logger('GraphQL');
const plugins = [
  ApolloServerPluginLandingPageDisabled(),
  ApolloServerPluginCacheControl({ calculateHttpHeaders: false }),
  scraperDbCachePlugin(),
];
const schemaPath = [
  join(import.meta.dirname, 'graphql/scraperdb-schema.graphql'),
  join(import.meta.dirname, '../src/graphql/scraperdb-schema.graphql'),
].find(existsSync);
if (!schemaPath) throw new Error('Missing scraper DB GraphQL schema');

let stats = newStats();
let activeRequests = 0;
graphqlActiveRequestLimit.set(config.GRAPHQL_MAX_ACTIVE_REQUESTS);
setInterval(() => {
  const current = stats;
  stats = newStats();
  logger.log(
    `graphql stats requests=${current.requests} rejected=${current.rejected} errors=${current.errors} status4xx=${current.status4xx} status5xx=${current.status5xx} avgMs=${current.requests ? Math.round(current.totalMs / current.requests) : 0} maxMs=${current.maxMs}`,
  );
}, 60_000).unref();

@Module({
  controllers: [MetricsController],
  imports: [
    GraphQLModule.forRootAsync<ApolloDriverConfig>({
      driver: ApolloDriver,
      imports: [DbModule],
      inject: [DbService],
      useFactory: (db: DbService) => ({
        formatError,
        playground: false,
        // CAST: Nest and Apollo expose the same plugin API through distinct
        // CJS/ESM declarations, which TypeScript treats as nominally different.
        plugins: plugins as ApolloDriverConfig['plugins'],
        resolvers: buildResolvers(new ScraperDbService(db)),
        typeDefs: sanitizeScraperDbSchema(readFileSync(schemaPath, 'utf8')),
        validationRules: [scraperProxyValidationRule],
      }),
    }),
    DbModule,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(graphqlMiddleware).forRoutes('graphql');
  }
}

function graphqlMiddleware(
  req: Request,
  res: Response,
  next: () => void,
): void {
  const started = Date.now();
  if (activeRequests >= config.GRAPHQL_MAX_ACTIVE_REQUESTS) {
    res.statusCode = 503;
    res.setHeader('retry-after', '1');
    res.end('GraphQL request capacity exceeded');
    graphqlRequests.inc({ outcome: 'capacity_rejected' });
    graphqlRequestDuration.observe((Date.now() - started) / 1_000);
    recordRequest(started, 503, true);
    return;
  }
  activeRequests++;
  graphqlActiveRequests.inc();
  let completed = false;
  const complete = (): void => {
    if (completed) return;
    completed = true;
    activeRequests--;
    graphqlActiveRequests.dec();
    recordRequest(
      started,
      res.statusCode ?? 0,
      false,
      `${req.method ?? 'REQUEST'} ${req.originalUrl ?? req.url ?? '/graphql'}`,
    );
  };
  res.on('finish', complete);
  res.on('close', complete);
  normalizeGraphqlRequestBody(req.body);
  next();
}

function recordRequest(
  started: number,
  status: number,
  rejected: boolean,
  request = 'REQUEST /graphql',
): void {
  const duration = Date.now() - started;
  if (!rejected) {
    graphqlRequests.inc({ outcome: requestOutcome(status) });
    graphqlRequestDuration.observe(duration / 1_000);
  }
  stats.requests++;
  stats.totalMs += duration;
  stats.maxMs = Math.max(stats.maxMs, duration);
  if (rejected) stats.rejected++;
  if (status >= 400 && status < 500) stats.status4xx++;
  if (status >= 500) stats.status5xx++;
  logger.debug(`${request} ${status} ${duration}ms`);
}

function formatError(error: GraphQLFormattedError): GraphQLFormattedError {
  const code =
    typeof error.extensions?.code === 'string'
      ? ` code=${error.extensions.code}`
      : '';
  stats.errors++;
  graphqlErrors.inc();
  logger.warn(`error${code}: ${error.message}`);
  return error;
}

function requestOutcome(status: number): string {
  if (status >= 500) return 'server_error';
  if (status >= 400) return 'client_error';
  return 'success';
}

function newStats(): Stats {
  return {
    errors: 0,
    maxMs: 0,
    rejected: 0,
    requests: 0,
    status4xx: 0,
    status5xx: 0,
    totalMs: 0,
  };
}
