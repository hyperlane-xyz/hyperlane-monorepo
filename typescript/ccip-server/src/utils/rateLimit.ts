import rateLimit, { normalizeIP } from '@fastify/rate-limit';

import type { CcipApp } from '../http.js';
import {
  PrometheusMetrics,
  RateLimitedMethod,
  RateLimitedRoute,
} from './prometheus.js';

export async function registerRateLimiting(app: CcipApp): Promise<void> {
  await app.register(rateLimit, {
    enableDraftSpec: true,
    global: false,
    hook: 'preHandler',
    max: 20,
    timeWindow: 60 * 1_000,
  });

  app.setErrorHandler(async (error, _request, reply) => {
    if (error instanceof RateLimitExceededError) {
      return reply.code(429).send({ error: 'Too many requests' });
    }
    return reply.send(error);
  });
}

export function createRateLimitHook(
  app: CcipApp,
  group: 'read' | 'write',
): ReturnType<CcipApp['rateLimit']> {
  return app.rateLimit({
    errorResponseBuilder: () => new RateLimitExceededError(),
    keyGenerator: (request) => `${normalizeIP(request.ip, 64)}:${group}`,
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
