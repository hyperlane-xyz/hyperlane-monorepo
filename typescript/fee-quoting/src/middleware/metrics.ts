import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  Counter,
  Histogram,
  Registry,
  collectDefaultMetrics,
} from 'prom-client';

export function createMetrics(register: Registry) {
  collectDefaultMetrics({ register });

  const httpRequestsTotal = new Counter({
    name: 'hyperlane_fee_quoting_http_requests_total',
    help: 'Total HTTP requests',
    labelNames: ['method', 'endpoint', 'status'] as const,
    registers: [register],
  });

  const httpRequestDuration = new Histogram({
    name: 'hyperlane_fee_quoting_http_request_duration_seconds',
    help: 'HTTP request duration in seconds',
    labelNames: ['method', 'endpoint'] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
    registers: [register],
  });

  const quotesServed = new Counter({
    name: 'hyperlane_fee_quoting_quotes_served_total',
    help: 'Total quotes served per quoter contract',
    labelNames: [
      'origin',
      'command',
      'router',
      'destination',
      'quoter',
    ] as const,
    registers: [register],
  });

  const timers = new WeakMap<
    FastifyRequest,
    ReturnType<typeof httpRequestDuration.startTimer>
  >();

  async function onRequest(request: FastifyRequest) {
    const end = httpRequestDuration.startTimer({
      method: request.method,
    });
    timers.set(request, end);
  }

  async function onResponse(request: FastifyRequest, reply: FastifyReply) {
    const resolvedEndpoint = endpointLabel(request.routeOptions.url);
    timers.get(request)?.({ endpoint: resolvedEndpoint });
    timers.delete(request);
    httpRequestsTotal.inc({
      method: request.method,
      endpoint: resolvedEndpoint,
      status: String(reply.statusCode),
    });
  }

  return { onRequest, onResponse, quotesServed, register };
}

function endpointLabel(routeUrl: string | undefined): string {
  if (!routeUrl) return 'unmatched';
  if (routeUrl.startsWith('/v2/quote/'))
    return routeUrl.slice('/v2/quote'.length);
  if (routeUrl.startsWith('/quote/')) return routeUrl.slice('/quote'.length);
  return routeUrl;
}
