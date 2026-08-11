import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ApolloServerPluginLandingPageLocalDefault } from '@apollo/server/plugin/landingPage/default';
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
import { ScraperDbService } from './scraperdb/scraperdb.service.js';
import {
  cacheControlHeaderForGraphqlRequestBody,
  normalizeGraphqlRequestBody,
} from './scraperdb/request-compatibility.js';
import { buildResolvers } from './scraperdb/resolver-map.js';
import { sanitizeScraperDbSchema } from './scraperdb/schema.js';

type RequestWithBody = {
  body?: unknown;
  method?: string;
  originalUrl?: string;
  url?: string;
};

type ResponseWithFinish = {
  on(event: 'finish', listener: () => void): void;
  setHeader?(name: string, value: number | readonly string[] | string): unknown;
  statusCode?: number;
};

const graphqlLogger = new Logger('GraphQL');

const schemaPath = [
  join(import.meta.dirname, 'graphql/scraperdb-schema.graphql'),
  join(import.meta.dirname, '../src/graphql/scraperdb-schema.graphql'),
].find((path) => existsSync(path));

if (!schemaPath) {
  throw new Error('Missing scraper DB GraphQL schema');
}

@Module({
  imports: [
    GraphQLModule.forRootAsync<ApolloDriverConfig>({
      driver: ApolloDriver,
      imports: [DbModule],
      inject: [DbService],
      useFactory: (db: DbService) => {
        const scraperDb = new ScraperDbService(db);
        return {
          csrfPrevention: false,
          plugins: [
            ApolloServerPluginLandingPageLocalDefault(),
            scraperDbCachePlugin(),
          ] as ApolloDriverConfig['plugins'],
          playground: false,
          formatError: formatGraphqlError,
          resolvers: buildResolvers(
            scraperDb,
          ) as ApolloDriverConfig['resolvers'],
          typeDefs: sanitizeScraperDbSchema(readFileSync(schemaPath, 'utf8')),
        };
      },
    }),
    DbModule,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(graphqlRequestMiddleware).forRoutes('graphql');
  }
}

function graphqlRequestMiddleware(
  req: RequestWithBody,
  res: ResponseWithFinish,
  next: () => void,
): void {
  const startedAt = Date.now();
  normalizeGraphqlRequestBody(req.body);
  applyCacheControlCompatibility(req.body, res);
  res.on('finish', () => {
    graphqlLogger.log(
      `${req.method ?? 'REQUEST'} ${req.originalUrl ?? req.url ?? '/graphql'} ${res.statusCode ?? 0} ${Date.now() - startedAt}ms`,
    );
  });
  next();
}

function applyCacheControlCompatibility(
  body: unknown,
  res: ResponseWithFinish,
): void {
  const cacheControl = cacheControlHeaderForGraphqlRequestBody(body);
  if (!cacheControl || !res.setHeader) {
    return;
  }

  const setHeader = res.setHeader.bind(res);
  res.setHeader = (name, value) => {
    if (
      name.toLowerCase() === 'cache-control' &&
      String(value).toLowerCase() === 'no-store'
    ) {
      return setHeader(name, cacheControl);
    }

    return setHeader(name, value);
  };
}

function formatGraphqlError(
  error: GraphQLFormattedError,
): GraphQLFormattedError {
  const code =
    typeof error.extensions?.code === 'string'
      ? ` code=${error.extensions.code}`
      : '';
  graphqlLogger.warn(`error${code}: ${error.message}`);
  return error;
}
