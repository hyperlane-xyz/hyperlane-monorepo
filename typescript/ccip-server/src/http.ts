import type { IncomingMessage, Server, ServerResponse } from 'node:http';

import type {
  FastifyInstance,
  FastifyRequest,
  FastifySchema,
  FastifyTypeProviderDefault,
  RouteGenericInterface,
} from 'fastify';
import type { Logger } from 'pino';

export const MAX_CCIP_PARAMETER_LENGTH = 10 * 1_024;
export const CCIP_ROUTER_OPTIONS = {
  caseSensitive: false,
  ignoreTrailingSlash: true,
  maxParamLength: MAX_CCIP_PARAMETER_LENGTH,
} as const;
// GCE ingress reuses idle backend connections for up to 600s. Outlive that so
// the load balancer never reuses a socket the server already closed, and low
// traffic probes don't pay a fresh TCP handshake to the pod on every request.
export const CCIP_KEEP_ALIVE_TIMEOUT_MS = 620_000;

export type CcipApp = FastifyInstance<
  Server,
  IncomingMessage,
  ServerResponse,
  Logger
>;

export type CcipRequest<
  Route extends RouteGenericInterface = RouteGenericInterface,
> = FastifyRequest<
  Route,
  Server,
  IncomingMessage,
  FastifySchema,
  FastifyTypeProviderDefault,
  unknown,
  Logger
>;

export interface CommitmentParams {
  commitment: string;
}
