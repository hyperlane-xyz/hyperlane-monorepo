import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ApolloServerPluginLandingPageLocalDefault } from '@apollo/server/plugin/landingPage/default';
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

import { DbModule } from './db/db.module.js';
import { DbService } from './db/db.service.js';
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
  on(event: 'finish', listener: () => void): void;
  statusCode?: number;
};
type Stats = {
  errors: number;
  maxMs: number;
  requests: number;
  status4xx: number;
  status5xx: number;
  totalMs: number;
};

const logger = new Logger('GraphQL');
const schemaPath = [
  join(import.meta.dirname, 'graphql/scraperdb-schema.graphql'),
  join(import.meta.dirname, '../src/graphql/scraperdb-schema.graphql'),
].find(existsSync);
if (!schemaPath) throw new Error('Missing scraper DB GraphQL schema');

let stats = newStats();
setInterval(() => {
  const current = stats;
  stats = newStats();
  logger.log(
    `graphql stats requests=${current.requests} errors=${current.errors} status4xx=${current.status4xx} status5xx=${current.status5xx} avgMs=${current.requests ? Math.round(current.totalMs / current.requests) : 0} maxMs=${current.maxMs}`,
  );
}, 60_000).unref();

@Module({
  imports: [
    GraphQLModule.forRootAsync<ApolloDriverConfig>({
      driver: ApolloDriver,
      imports: [DbModule],
      inject: [DbService],
      useFactory: (db: DbService) => ({
        csrfPrevention: false,
        formatError,
        playground: false,
        plugins: [
          ApolloServerPluginLandingPageLocalDefault(),
          ApolloServerPluginCacheControl({ calculateHttpHeaders: false }),
          scraperDbCachePlugin(),
        ] as ApolloDriverConfig['plugins'],
        resolvers: buildResolvers(
          new ScraperDbService(db),
        ) as ApolloDriverConfig['resolvers'],
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
  normalizeGraphqlRequestBody(req.body);
  res.on('finish', () => {
    const duration = Date.now() - started;
    const status = res.statusCode ?? 0;
    stats.requests++;
    stats.totalMs += duration;
    stats.maxMs = Math.max(stats.maxMs, duration);
    if (status >= 400 && status < 500) stats.status4xx++;
    if (status >= 500) stats.status5xx++;
    logger.debug(
      `${req.method ?? 'REQUEST'} ${req.originalUrl ?? req.url ?? '/graphql'} ${status} ${duration}ms`,
    );
  });
  next();
}

function formatError(error: GraphQLFormattedError): GraphQLFormattedError {
  const code =
    typeof error.extensions?.code === 'string'
      ? ` code=${error.extensions.code}`
      : '';
  stats.errors++;
  logger.warn(`error${code}: ${error.message}`);
  return error;
}

function newStats(): Stats {
  return {
    errors: 0,
    maxMs: 0,
    requests: 0,
    status4xx: 0,
    status5xx: 0,
    totalMs: 0,
  };
}
