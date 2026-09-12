import type { Express, Request, Response } from 'express';
import type { LevelWithSilent } from 'pino';

// GCE ingress appends the client and load-balancer addresses to X-Forwarded-For.
// Trust the direct proxy and the load-balancer address so Express selects the
// client address instead of grouping every request under the load balancer.
export const GCE_INGRESS_PROXY_HOPS = 2;

export function configureTrustProxy(app: Express): void {
  app.set('trust proxy', GCE_INGRESS_PROXY_HOPS);
}

// Keep failed probes visible; successful probes dominate request completion logs.
export function requestLogLevel(
  req: Request,
  res: Response,
  error?: Error,
): LevelWithSilent {
  if (
    req.originalUrl === '/health' &&
    res.statusCode === 200 &&
    res.writableEnded &&
    !error &&
    !res.err
  ) {
    return 'silent';
  }
  return 'info';
}
