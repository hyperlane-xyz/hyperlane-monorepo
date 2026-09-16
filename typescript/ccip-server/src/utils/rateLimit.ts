import rateLimit, { normalizeIP } from '@fastify/rate-limit';

import type { CcipApp } from '../http.js';
import {
  PrometheusMetrics,
  RateLimitedMethod,
  RateLimitedRoute,
} from './prometheus.js';

const RATE_LIMIT_MAX = 20;
const RATE_LIMIT_WINDOW_SECONDS = 60;

export async function registerRateLimiting(app: CcipApp): Promise<void> {
  await app.register(rateLimit, {
    enableDraftSpec: true,
    global: false,
    hook: 'preHandler',
    max: RATE_LIMIT_MAX,
    timeWindow: RATE_LIMIT_WINDOW_SECONDS * 1_000,
  });

  app.addHook('onSend', async (request, reply, payload) => {
    if (
      toRateLimitedRoute(request.routeOptions.url) !== RateLimitedRoute.Unknown
    ) {
      reply.header(
        'ratelimit-policy',
        `${RATE_LIMIT_MAX};w=${RATE_LIMIT_WINDOW_SECONDS}`,
      );
    }
    return payload;
  });

  app.setErrorHandler(async (error, request, reply) => {
    if (error instanceof RateLimitExceededError) {
      return reply.code(429).send({ error: 'Too many requests' });
    }
    request.log.error({ err: error }, 'Unhandled request error');
    return reply.code(500).send({ error: 'Internal server error' });
  });
}

export function createRateLimitHook(
  app: CcipApp,
  group: 'read' | 'write',
): ReturnType<CcipApp['rateLimit']> {
  return app.rateLimit({
    errorResponseBuilder: () => new RateLimitExceededError(),
    keyGenerator: (request) => `${normalizeIP(request.ip, 56)}:${group}`,
    onExceeded: (request) => {
      PrometheusMetrics.logRateLimited(
        toRateLimitedMethod(request.method),
        toRateLimitedRoute(request.routeOptions.url),
      );
    },
  });
}

class RateLimitExceededError extends Error {
  readonly statusCode = 429;
}

function toRateLimitedMethod(method: string): RateLimitedMethod {
  if (method === RateLimitedMethod.GET) return RateLimitedMethod.GET;
  if (method === RateLimitedMethod.POST) return RateLimitedMethod.POST;
  return RateLimitedMethod.OTHER;
}

function toRateLimitedRoute(routeUrl: string | undefined): RateLimitedRoute {
  if (!routeUrl) return RateLimitedRoute.Unknown;
  return (
    Object.values(RateLimitedRoute).find(
      (route) => route !== RateLimitedRoute.Unknown && routeUrl.endsWith(route),
    ) ?? RateLimitedRoute.Unknown
  );
}
