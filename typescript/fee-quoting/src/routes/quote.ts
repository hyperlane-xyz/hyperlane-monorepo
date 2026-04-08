import { type NextFunction, Request, Response, Router } from 'express';
import type { Address, Hex } from 'viem';
import { z } from 'zod';

import { FeeQuotingCommand } from '@hyperlane-xyz/sdk';

import { ApiError } from '../middleware/errorHandler.js';
import type { QuoteService } from '../services/quoteService.js';

type AsyncHandler = (
  req: Request,
  res: Response,
  next: NextFunction,
) => Promise<void>;

/** Wrap async route handler so rejections are forwarded to Express error middleware */
function asyncHandler(fn: AsyncHandler) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res, next).catch(next);
  };
}

const addressSchema = z.string().startsWith('0x').length(42);
const bytes32Schema = z.string().startsWith('0x').length(66);
const domainSchema = z.string().regex(/^\d+$/);

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

function parseAndValidate<T>(schema: z.ZodType<T>, query: unknown): T {
  const parsed = schema.safeParse(query);
  if (!parsed.success) {
    const messages = parsed.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    throw new ApiError(messages, 400);
  }
  return parsed.data;
}

export function createQuoteRouter(quoteService: QuoteService): Router {
  const router = Router();

  function warpHandler(command: FeeQuotingCommand) {
    return async (req: Request, res: Response) => {
      const data = parseAndValidate(WarpQuerySchema, req.query);
      const response = await quoteService.getQuote(
        data.origin,
        command,
        data.router as Address,
        parseInt(data.destination, 10),
        data.salt as Hex,
        data.recipient as Hex,
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
        data.router as Address,
        parseInt(data.destination, 10),
        data.salt as Hex,
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
        data.router as Address,
        parseInt(data.destination, 10),
        data.salt as Hex,
        data.recipient as Hex,
        data.targetRouter as Hex | undefined,
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
