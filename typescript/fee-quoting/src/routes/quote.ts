import { Request, Response, Router } from 'express';
import type { Address, Hex } from 'viem';
import { z } from 'zod';

import { QuotedCallsCommand } from '../types.js';
import { ApiError } from '../middleware/errorHandler.js';
import type { QuoteService } from '../services/quoteService.js';

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

  function warpHandler(command: QuotedCallsCommand) {
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

  function icaHandler(command: QuotedCallsCommand) {
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

  router.get('/transferRemote', warpHandler(QuotedCallsCommand.TransferRemote));
  router.get(
    '/transferRemoteTo',
    warpHandler(QuotedCallsCommand.TransferRemoteTo),
  );
  router.get(
    '/callRemoteWithOverrides',
    icaHandler(QuotedCallsCommand.CallRemoteWithOverrides),
  );
  router.get(
    '/callRemoteCommitReveal',
    icaHandler(QuotedCallsCommand.CallRemoteCommitReveal),
  );

  return router;
}
