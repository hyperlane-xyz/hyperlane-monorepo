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
