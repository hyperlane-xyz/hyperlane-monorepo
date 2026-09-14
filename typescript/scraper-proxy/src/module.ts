import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import cors from '@fastify/cors';
import { rootLogger } from '@hyperlane-xyz/utils';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import mercurius, { type MercuriusOptions } from 'mercurius';

import { config } from './config.js';
import {
  graphqlActiveRequestLimit,
  graphqlActiveRequests,
  graphqlErrors,
  graphqlRequestDuration,
  graphqlRequests,
  metricsRegistry,
} from './metrics.js';
import { cacheControlHeader } from './scraperdb/cache-config.js';
import { normalizeGraphqlRequestBody } from './scraperdb/request-compatibility.js';
import { buildResolvers } from './scraperdb/resolver-map.js';
import {
  GraphqlResponseCache,
  type PreparedCacheRequest,
} from './scraperdb/response-cache.js';
import { sanitizeScraperDbSchema } from './scraperdb/schema.js';
import {
  ScraperDbService,
  type ScraperDbDatabase,
} from './scraperdb/scraperdb.service.js';
import { scraperProxyValidationRule } from './scraperdb/validation.js';

type GraphqlBody = {
  operationName?: unknown;
  query?: unknown;
  variables?: unknown;
};
type RequestState = {
  cacheHit: boolean;
  completed: boolean;
  preparedCache?: PreparedCacheRequest;
  started: number;
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

const logger = rootLogger.child({ module: 'GraphQL' });
const MAX_REQUEST_BYTES = 100 * 1_024;
const CSRF_HEADERS = ['x-apollo-operation-name', 'apollo-require-preflight'];
const CSRF_ERROR_PREFIX =
  'This operation has been blocked as a potential Cross-Site Request Forgery';
const schemaPath = [
  join(import.meta.dirname, 'graphql/scraperdb-schema.graphql'),
  join(import.meta.dirname, '../src/graphql/scraperdb-schema.graphql'),
].find(existsSync);
if (!schemaPath) throw new Error('Missing scraper DB GraphQL schema');
const schema = sanitizeScraperDbSchema(readFileSync(schemaPath, 'utf8'));

let stats = newStats();
graphqlActiveRequestLimit.set(config.GRAPHQL_MAX_ACTIVE_REQUESTS);
setInterval(() => {
  const current = stats;
  stats = newStats();
  logger.info(
    `graphql stats requests=${current.requests} rejected=${current.rejected} errors=${current.errors} status4xx=${current.status4xx} status5xx=${current.status5xx} avgMs=${current.requests ? Math.round(current.totalMs / current.requests) : 0} maxMs=${current.maxMs}`,
  );
}, 60_000).unref();

export type ScraperProxyAppOptions = {
  jit?:
    | number
    | {
        eluThreshold?: number;
        maxCompilePerTick?: number;
        maxQueueSize?: number;
        minCount?: number;
      };
};

export async function createScraperProxyApp(
  db: ScraperDbDatabase,
  options: ScraperProxyAppOptions = {},
): Promise<FastifyInstance> {
  const app = Fastify({ bodyLimit: MAX_REQUEST_BYTES, logger: false });
  let activeRequests = 0;
  const responseCache = new GraphqlResponseCache();
  const requestStates = new WeakMap<FastifyRequest, RequestState>();

  await app.register(cors, {
    allowedHeaders: ['content-type', ...CSRF_HEADERS],
    credentials: false,
    origin: true,
  });

  app.addHook('onRequest', async (request, reply) => {
    if (!isGraphqlRequest(request)) return;
    const started = Date.now();
    if (activeRequests >= config.GRAPHQL_MAX_ACTIVE_REQUESTS) {
      reply.code(503).header('retry-after', '1');
      graphqlRequests.inc({ outcome: 'capacity_rejected' });
      graphqlRequestDuration.observe((Date.now() - started) / 1_000);
      recordRequest(started, 503, true);
      return reply.send('GraphQL request capacity exceeded');
    }

    activeRequests++;
    graphqlActiveRequests.inc();
    const state: RequestState = {
      cacheHit: false,
      completed: false,
      started,
    };
    requestStates.set(request, state);
    const complete = () => {
      const state = requestStates.get(request);
      if (!state || state.completed) return;
      state.completed = true;
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

  app.addHook('preValidation', async (request, reply) => {
    if (!isGraphqlRequest(request)) return;
    const state = requestStates.get(request);
    if (!state) return;
    normalizeGraphqlRequestBody(request.body);
    const body =
      graphqlBody(request.body) ??
      (request.method === 'GET' ? graphqlBody(request.query) : undefined);
    if (!body || typeof body.query !== 'string') return;
    const prepared = responseCache.prepareSource(
      body.query,
      typeof body.operationName === 'string' ? body.operationName : null,
      variables(body.variables),
    );
    if (!prepared) return;
    const cached = responseCache.read(prepared);
    if (!cached) {
      state.preparedCache = prepared;
      return;
    }
    state.cacheHit = true;
    reply
      .header('cache-control', cacheControlHeader(cached.ttl))
      .type('application/json');
    return reply.send(cached.body);
  });

  app.addHook('onSend', async (request, reply, payload) => {
    if (!isGraphqlRequest(request)) return payload;
    const state = requestStates.get(request);
    if (!state || state.cacheHit) return payload;
    const body = serializedBody(payload);
    const errors = graphqlErrorMessages(body);
    if (errors.length) {
      stats.errors += errors.length;
      graphqlErrors.inc(errors.length);
      errors.forEach((message) => logger.warn(`error: ${message}`));
    }
    const prepared = state.preparedCache;
    if (!prepared) return payload;
    if (errors.length) {
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

  registerMetricsRoute(app);

  await app.register(mercurius, {
    allowBatchedQueries: false,
    cache: 1_024,
    csrfPrevention: {
      allowedContentTypes: ['application/json', 'application/graphql'],
      requiredHeaders: CSRF_HEADERS,
    },
    errorFormatter: compatibleErrorFormatter,
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
    path: '/graphql',
    resolvers: buildResolvers(new ScraperDbService(db)),
    schema,
    subscription: false,
    validationRules: [scraperProxyValidationRule],
  });

  return app;
}

const compatibleErrorFormatter: NonNullable<
  MercuriusOptions['errorFormatter']
> = (execution, context) => {
  const formatted = mercurius.defaultErrorFormatter(execution, context);
  return {
    statusCode: formatted.statusCode,
    response: {
      ...formatted.response,
      errors: formatted.response.errors?.map((error) => {
        if (error.extensions?.code) return error;
        const code = graphqlErrorCode(formatted.statusCode, error.message);
        return code
          ? { ...error, extensions: { ...error.extensions, code } }
          : error;
      }),
    },
  };
};

function graphqlErrorCode(status: number, message: string): string | undefined {
  if (message.startsWith(CSRF_ERROR_PREFIX)) return 'BAD_REQUEST';
  if (status === 400) {
    return message.startsWith('Syntax Error:')
      ? 'GRAPHQL_PARSE_FAILED'
      : 'GRAPHQL_VALIDATION_FAILED';
  }
  return status === 200 || status >= 500 ? 'INTERNAL_SERVER_ERROR' : undefined;
}

export function registerMetricsRoute(app: FastifyInstance): void {
  app.get('/metrics', async (_request, reply) => {
    reply.type(metricsRegistry.contentType);
    return metricsRegistry.metrics();
  });
}

function isGraphqlRequest(request: FastifyRequest): boolean {
  return request.routeOptions.url === '/graphql';
}

function graphqlBody(body: unknown): GraphqlBody | undefined {
  return isRecord(body) ? body : undefined;
}

function variables(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return {};
    }
  }
  return isRecord(value) ? value : {};
}

function serializedBody(payload: unknown): string | undefined {
  if (typeof payload === 'string') return payload;
  return Buffer.isBuffer(payload) ? payload.toString('utf8') : undefined;
}

function graphqlErrorMessages(body: string | undefined): string[] {
  if (!body) return [];
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return [];
  }
  if (!value || typeof value !== 'object' || !('errors' in value)) return [];
  const errors = value.errors;
  if (!Array.isArray(errors)) return [];
  return errors.flatMap((error) =>
    error && typeof error === 'object' && 'message' in error
      ? [String(error.message)]
      : [],
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
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
