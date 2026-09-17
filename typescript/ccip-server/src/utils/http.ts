import { BlockList, isIP } from 'node:net';

import type { FastifyReply, FastifyRequest } from 'fastify';
import type { LevelWithSilent } from 'pino';

import type { CcipApp } from '../http.js';

// GCE ingress appends proxy addresses to X-Forwarded-For. Trust only the GFE
// source ranges and private/loopback hops between the load balancer and pod so
// a directly connected client cannot spoof forwarding headers.
const trustedIngressPeers = new BlockList();
trustedIngressPeers.addSubnet('35.191.0.0', 16, 'ipv4');
trustedIngressPeers.addSubnet('130.211.0.0', 22, 'ipv4');
trustedIngressPeers.addSubnet('10.0.0.0', 8, 'ipv4');
trustedIngressPeers.addSubnet('172.16.0.0', 12, 'ipv4');
trustedIngressPeers.addSubnet('192.168.0.0', 16, 'ipv4');
trustedIngressPeers.addSubnet('127.0.0.0', 8, 'ipv4');
trustedIngressPeers.addSubnet('fc00::', 7, 'ipv6');
trustedIngressPeers.addSubnet('fe80::', 10, 'ipv6');
trustedIngressPeers.addAddress('::1', 'ipv6');

export function trustGceIngressProxy(address: string, hop: number): boolean {
  if (hop === 1) return true;
  if (hop !== 0) return false;
  const normalized = address.startsWith('::ffff:')
    ? address.slice('::ffff:'.length)
    : address;
  const family = isIP(normalized);
  if (family === 4) return trustedIngressPeers.check(normalized, 'ipv4');
  if (family === 6) return trustedIngressPeers.check(normalized, 'ipv6');
  return false;
}

export function registerRequestLogging(app: CcipApp): void {
  const requestErrors = new WeakMap<FastifyRequest, Error>();
  app.addHook('onError', async (request, _reply, error) => {
    requestErrors.set(request, error);
  });
  app.addHook('onResponse', async (request, reply) => {
    const error = requestErrors.get(request);
    const level = requestLogLevel(request, reply, error);
    requestErrors.delete(request);
    if (level !== 'silent') {
      request.log[level](
        {
          err: error,
          method: request.method,
          responseTime: reply.elapsedTime,
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
