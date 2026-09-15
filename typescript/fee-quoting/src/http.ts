import type { IncomingMessage, Server, ServerResponse } from 'node:http';

import type { FastifyInstance } from 'fastify';
import type { Logger } from 'pino';

export type FeeQuotingApp = FastifyInstance<
  Server,
  IncomingMessage,
  ServerResponse,
  Logger
>;
