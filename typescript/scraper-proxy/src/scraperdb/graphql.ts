import { rootLogger } from '@hyperlane-xyz/utils';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import mercurius, { type MercuriusOptions } from 'mercurius';

import { config } from '../config.js';
import {
  graphqlActiveRequestLimit,
  graphqlActiveRequests,
  graphqlErrors,
  graphqlRequestDuration,
  graphqlRequests,
} from '../metrics.js';
import { cacheControlHeader } from './cache-config.js';
import type { ScraperDbDatabase } from './database.js';
import { stripUnusedVariables } from './request-compatibility.js';
import { buildResolvers } from './resolver-map.js';
import {
  GraphqlResponseCache,
  type PreparedCacheRequest,
} from './response-cache.js';
import { schema } from './schema.js';
import { ScraperDbService } from './scraperdb.service.js';
import {
  MAX_GRAPHQL_TOKENS,
  scraperProxyValidationRule,
} from './validation.js';

type RequestState = {
  failed?: boolean;
  preparedCache?: PreparedCacheRequest;
  started: number;
};
const logger = rootLogger.child({ module: 'GraphQL' });
export const MAX_REQUEST_BYTES = 100 * 1_024;

export type ScraperProxyAppOptions = {
  jit?: MercuriusOptions['jit'];
};

export async function registerGraphqlRoute(
  app: FastifyInstance,
  db: ScraperDbDatabase,
  options: ScraperProxyAppOptions = {},
): Promise<void> {
  let stats = newStats();
  graphqlActiveRequestLimit.set(config.GRAPHQL_MAX_ACTIVE_REQUESTS);
  const statsTimer = setInterval(() => {
    const current = stats;
    stats = newStats();
    logger.info(
      `graphql stats requests=${current.requests} rejected=${current.rejected} errors=${current.errors} status4xx=${current.status4xx} status5xx=${current.status5xx} avgMs=${current.requests ? Math.round(current.totalMs / current.requests) : 0} maxMs=${current.maxMs}`,
    );
  }, 60_000).unref();

  app.addHook('onClose', async () => {
    clearInterval(statsTimer);
  });

  let activeRequests = 0;
  let activeUploads = 0;
  const uploadReleases = new WeakMap<FastifyRequest, () => void>();
  const responseCache = new GraphqlResponseCache();
  const requestStates = new WeakMap<FastifyRequest, RequestState>();

  // Fastify buffers bodies before preHandler. Bound that memory independently
  // of execution slots; each admitted upload retains at most MAX_REQUEST_BYTES.
  app.addHook('onRequest', async (request, reply) => {
    if (request.method === 'GET') return;
    if (activeUploads >= config.GRAPHQL_MAX_ACTIVE_UPLOADS) {
      reply.code(503).header('retry-after', '1').header('connection', 'close');
      reply.raw.once('finish', () => request.raw.destroy());
      return reply.send('GraphQL upload capacity exceeded');
    }
    activeUploads++;
    const release = () => {
      if (!uploadReleases.delete(request)) return;
      activeUploads--;
      request.raw.off('close', release);
    };
    uploadReleases.set(request, release);
    request.raw.once('close', release);
  });

  app.addHook('preValidation', async (request) => {
    uploadReleases.get(request)?.();
  });

  app.addHook('onSend', async (request, reply, payload) => {
    if (!uploadReleases.has(request)) return payload;
    if (request.raw.complete) {
      uploadReleases.get(request)?.();
    } else {
      // Rejected/oversized uploads must stop buffering before returning capacity.
      reply.header('connection', 'close');
      reply.raw.once('finish', () => request.raw.destroy());
    }
    return payload;
  });

  app.addHook('preHandler', async (request, reply) => {
    const started = Date.now();
    if (activeRequests >= config.GRAPHQL_MAX_ACTIVE_REQUESTS) {
      reply.code(503).header('retry-after', '1');
      recordRequest(started, 503, true);
      return reply.send('GraphQL request capacity exceeded');
    }

    activeRequests++;
    graphqlActiveRequests.inc();
    const state: RequestState = {
      started,
    };
    requestStates.set(request, state);
    const complete = () => {
      if (!requestStates.delete(request)) return;
      activeRequests--;
      graphqlActiveRequests.dec();
      recordRequest(
        state.started,
        reply.statusCode,
        false,
        `${request.method} ${request.url}`,
      );
    };
    reply.raw.once('close', complete);
    reply.raw.once('finish', complete);
  });

  app.addHook('preHandler', async (request, reply) => {
    if (request.validationError) return;
    const state = requestStates.get(request);
    if (!state) return;
    const prepared = responseCache.prepare(
      app.graphql.schema,
      request.method === 'GET' ? request.query : request.body,
    );
    if (!prepared) return;
    const cached = responseCache.read(prepared);
    if (!cached) {
      state.preparedCache = prepared;
      return;
    }
    reply
      .header('cache-control', cacheControlHeader(cached.ttl))
      .type('application/json');
    return reply.send(cached.body);
  });

  app.addHook('onSend', async (request, reply, payload) => {
    const state = requestStates.get(request);
    const prepared = state?.preparedCache;
    if (!prepared) return payload;
    const body = serializedBody(payload);
    if (state.failed) {
      reply.header('cache-control', 'no-store');
      return payload;
    }
    reply.header(
      'cache-control',
      prepared.ttl === 0 ? 'no-store' : cacheControlHeader(prepared.ttl),
    );
    if (prepared.ttl > 0 && body) responseCache.write(prepared, body);
    return payload;
  });

  await app.register(mercurius, {
    allowBatchedQueries: false,
    cache: 1_024,
    csrfPrevention: {
      requiredHeaders: [
        'x-apollo-operation-name',
        'apollo-require-preflight',
        'x-mercurius-operation-name',
        'mercurius-require-preflight',
      ],
    },
    errorFormatter: (execution, context) => {
      const formatted = mercurius.defaultErrorFormatter(execution, context);
      const state = requestStates.get(context.reply.request);
      const errors = formatted.response.errors;
      if (state && errors?.length) {
        state.failed = true;
        stats.errors += errors.length;
        graphqlErrors.inc(errors.length);
        for (const error of errors) {
          logger.warn(
            {
              graphqlError: {
                code: error.extensions?.code,
                message: error.message,
                path: error.path,
              },
            },
            'GraphQL request error',
          );
        }
      }
      return formatted;
    },
    graphiql: false,
    ide: false,
    jit:
      options.jit === undefined
        ? {
            eluThreshold: 0.8,
            maxCompilePerTick: 1,
            maxQueueSize: 100,
            minCount: 3,
          }
        : options.jit,
    graphql: { parseOptions: { maxTokens: MAX_GRAPHQL_TOKENS } },
    path: '/graphql',
    resolvers: buildResolvers(new ScraperDbService(db)),
    schema,
    subscription: false,
    validationRules: [scraperProxyValidationRule],
  });

  app.graphql.addHook('preValidation', async (_schema, document) => {
    // Mercurius caches this AST after validation; compatibility needs no separate
    // parse/print pass or query-text cache.
    Object.assign(document, stripUnusedVariables(document));
  });

  function recordRequest(
    started: number,
    status: number,
    rejected: boolean,
    request = 'REQUEST /graphql',
  ): void {
    const duration = Date.now() - started;
    graphqlRequests.inc({
      outcome: rejected ? 'capacity_rejected' : requestOutcome(status),
    });
    graphqlRequestDuration.observe(duration / 1_000);
    stats.requests++;
    stats.totalMs += duration;
    stats.maxMs = Math.max(stats.maxMs, duration);
    if (rejected) stats.rejected++;
    if (status >= 400 && status < 500) stats.status4xx++;
    if (status >= 500) stats.status5xx++;
    logger.debug(`${request} ${status} ${duration}ms`);
  }
}

function serializedBody(payload: unknown): string | undefined {
  if (typeof payload === 'string') return payload;
  return Buffer.isBuffer(payload) ? payload.toString('utf8') : undefined;
}

function requestOutcome(status: number): string {
  if (status >= 500) return 'server_error';
  if (status >= 400) return 'client_error';
  return 'success';
}

function newStats() {
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
