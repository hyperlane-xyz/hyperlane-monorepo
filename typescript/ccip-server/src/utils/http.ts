import type { FastifyReply, FastifyRequest } from 'fastify';
import type { LevelWithSilent } from 'pino';

import type { CcipApp } from '../http.js';

// GCE ingress appends proxy addresses to X-Forwarded-For. Trust only the GFE
// source ranges and private/loopback hops between the load balancer and pod so
// a directly connected client cannot spoof forwarding headers.
export const GCE_INGRESS_PROXY_CIDRS = [
  '35.191.0.0/16',
  '130.211.0.0/22',
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '127.0.0.0/8',
  '::1/128',
];

export function registerRequestLogging(app: CcipApp): void {
  const requestErrors = new WeakMap<object, Error>();
  app.addHook('onError', async (request, _reply, error) => {
    requestErrors.set(request, error);
  });
  app.addHook('onResponse', async (request, reply) => {
    const level = requestLogLevel(request, reply, requestErrors.get(request));
    requestErrors.delete(request);
    if (level !== 'silent') {
      request.log[level](
        {
          method: request.method,
          statusCode: reply.statusCode,
          url: request.raw.url,
        },
        'Request completed',
      );
    }
  });
}

// Keep failed probes visible; successful probes dominate request completion logs.
export function requestLogLevel(
  request: FastifyRequest,
  reply: FastifyReply,
  error?: Error,
): LevelWithSilent {
  if (request.raw.url === '/health' && reply.statusCode === 200 && !error) {
    return 'silent';
  }
  return 'info';
}
