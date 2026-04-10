import { NextFunction, Request, Response } from 'express';
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

  function middleware(req: Request, res: Response, next: NextFunction) {
    const end = httpRequestDuration.startTimer({
      method: req.method,
    });

    res.on('finish', () => {
      const resolvedEndpoint = req.route?.path ?? 'unmatched';
      end({ endpoint: resolvedEndpoint });
      httpRequestsTotal.inc({
        method: req.method,
        endpoint: resolvedEndpoint,
        status: String(res.statusCode),
      });
    });

    next();
  }

  return { middleware, quotesServed, register };
}
