import { Request, Response, Router } from 'express';
import { type Address, isAddress } from 'viem';
import { z } from 'zod';

import { FeeQuotingCommand } from '@hyperlane-xyz/sdk';

import type { QuoteService } from '../services/quoteService.js';

import { asyncHandler } from './asyncHandler.js';
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

export function createQuoteRouter(quoteService: QuoteService): Router {
  const router = Router();

  function warpHandler(command: FeeQuotingCommand) {
    return async (req: Request, res: Response) => {
      const data = parseAndValidate(WarpQuerySchema, req.query);
      const response = await quoteService.getQuote(
        data.origin,
        command,
        data.router,
        data.destination,
        data.salt,
        data.recipient,
      );
      res.json(response);
    };
  }

  function icaHandler(command: FeeQuotingCommand) {
    return async (req: Request, res: Response) => {
      const data = parseAndValidate(IcaQuerySchema, req.query);
      const response = await quoteService.getQuote(
        data.origin,
        command,
        data.router,
        data.destination,
        data.salt,
      );
      res.json(response);
    };
  }

  router.get(
    '/transferRemote',
    asyncHandler(warpHandler(FeeQuotingCommand.TransferRemote)),
  );
  router.get(
    '/transferRemoteTo',
    asyncHandler(async (req: Request, res: Response) => {
      const data = parseAndValidate(WarpQueryWithTargetRouterSchema, req.query);
      const response = await quoteService.getQuote(
        data.origin,
        FeeQuotingCommand.TransferRemoteTo,
        data.router,
        data.destination,
        data.salt,
        data.recipient,
        data.targetRouter,
      );
      res.json(response);
    }),
  );
  router.get(
    '/callRemoteWithOverrides',
    asyncHandler(icaHandler(FeeQuotingCommand.CallRemoteWithOverrides)),
  );
  router.get(
    '/callRemoteCommitReveal',
    asyncHandler(icaHandler(FeeQuotingCommand.CallRemoteCommitReveal)),
  );

  return router;
}
