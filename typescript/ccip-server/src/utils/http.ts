import type { Express } from 'express';

// GCE ingress appends the client and load-balancer addresses to X-Forwarded-For.
// Trust the direct proxy and the load-balancer address so Express selects the
// client address instead of grouping every request under the load balancer.
export const GCE_INGRESS_PROXY_HOPS = 2;

export function configureTrustProxy(app: Express): void {
  app.set('trust proxy', GCE_INGRESS_PROXY_HOPS);
}
