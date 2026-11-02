import type { FastifyReply, FastifyRequest } from 'fastify';
import { type Address, isAddress } from 'viem';
import { z } from 'zod';

import { FeeQuotingCommand } from '@hyperlane-xyz/sdk';

import type { FeeQuotingApp } from '../http.js';
import type { createApiKeyAuth } from '../middleware/apiKeyAuth.js';
import type { QuoteService } from '../services/quoteService.js';

import { bytes32Schema, domainSchema } from './commonSchemas.js';
import { parseAndValidate } from './parseAndValidate.js';

const addressSchema = z.custom<Address>(
  (v): boolean => typeof v === 'string' && isAddress(v),
  'Invalid EVM address',
);

const WarpQuerySchema = z.object({
  origin: z.string().min(1),
  router: addressSchema,
  destination: domainSchema,
  salt: bytes32Schema,
  recipient: bytes32Schema,
});

const WarpQueryWithTargetRouterSchema = WarpQuerySchema.extend({
  targetRouter: bytes32Schema.optional(),
});

const IcaQuerySchema = z.object({
  origin: z.string().min(1),
  router: addressSchema,
  destination: domainSchema,
  salt: bytes32Schema,
});

const CompiledWarpQuerySchema = z.compile(WarpQuerySchema);
const CompiledWarpQueryWithTargetRouterSchema = z.compile(
  WarpQueryWithTargetRouterSchema,
);
const CompiledIcaQuerySchema = z.compile(IcaQuerySchema);

export function registerQuoteRoutes(
  app: FeeQuotingApp,
  quoteService: QuoteService,
  onRequest: ReturnType<typeof createApiKeyAuth>,
): void {
  const routeOptions = { onRequest };

  function warpHandler(command: FeeQuotingCommand) {
    return async (request: FastifyRequest, reply: FastifyReply) => {
      const data = parseAndValidate(CompiledWarpQuerySchema, request.query);
      const response = await quoteService.getQuote(
        data.origin,
        command,
        data.router,
        data.destination,
        data.salt,
        data.recipient,
      );
      return reply.send(response);
    };
  }

  function icaHandler(command: FeeQuotingCommand) {
    return async (request: FastifyRequest, reply: FastifyReply) => {
      const data = parseAndValidate(CompiledIcaQuerySchema, request.query);
      const response = await quoteService.getQuote(
        data.origin,
        command,
        data.router,
        data.destination,
        data.salt,
      );
      return reply.send(response);
    };
  }

  app.get(
    '/quote/transferRemote',
    routeOptions,
    warpHandler(FeeQuotingCommand.TransferRemote),
  );
  app.get('/quote/transferRemoteTo', routeOptions, async (request, reply) => {
    const data = parseAndValidate(
      CompiledWarpQueryWithTargetRouterSchema,
      request.query,
    );
    const response = await quoteService.getQuote(
      data.origin,
      FeeQuotingCommand.TransferRemoteTo,
      data.router,
      data.destination,
      data.salt,
      data.recipient,
      data.targetRouter,
    );
    return reply.send(response);
  });
  app.get(
    '/quote/callRemoteWithOverrides',
    routeOptions,
    icaHandler(FeeQuotingCommand.CallRemoteWithOverrides),
  );
  app.get(
    '/quote/callRemoteCommitReveal',
    routeOptions,
    icaHandler(FeeQuotingCommand.CallRemoteCommitReveal),
  );
}
