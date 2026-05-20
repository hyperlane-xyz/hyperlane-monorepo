import { Request, Response, Router } from 'express';
import { type Address, type Hex, isAddress, isHex } from 'viem';
import { z } from 'zod';

import type { QuoteV2Response } from '@hyperlane-xyz/sdk';

import type { QuoteService } from '../services/quoteService.js';

import { asyncHandler } from './asyncHandler.js';
import { parseAndValidate } from './parseAndValidate.js';

// Custom Zod schemas that narrow strings to viem's branded `Address` / `Hex`
// at parse time, so downstream handlers don't need `as` casts.
const addressSchema = z.custom<Address>(
  (v): boolean => typeof v === 'string' && isAddress(v),
  'Invalid 0x address (must be 42 hex chars)',
);

const bytes32Schema = z.custom<Hex>(
  (v): boolean =>
    typeof v === 'string' && isHex(v, { strict: true }) && v.length === 66,
  'Invalid bytes32 hex (must be 0x + 64 hex chars)',
);

const domainSchema = z
  .string()
  .regex(/^\d+$/, 'Domain must be a numeric string')
  .transform((s) => parseInt(s, 10));

const WarpQuerySchema = z.object({
  origin: z.string().min(1),
  router: addressSchema,
  destination: domainSchema,
  salt: bytes32Schema,
  recipient: bytes32Schema,
  targetRouter: bytes32Schema,
});

const IgpQuerySchema = z.object({
  origin: z.string().min(1),
  router: addressSchema,
  destination: domainSchema,
  salt: bytes32Schema,
});

/**
 * v2 quote routes — split by quoter type rather than by command. Each route
 * returns at most one signed quote (`QuoteV2Response`) or a 404
 * `NoQuoteAvailableError` body when the quoter cannot be resolved or this
 * server's signer key isn't whitelisted on-chain.
 *
 *   GET /v2/quote/warp  — token-fee program quote (`targetRouter` required)
 *   GET /v2/quote/igp   — IGP quote
 *
 * Both reuse the same protocol-dispatch path through
 * `IProtocolQuoteSigner`; Phase 4 widens the registry with the Sealevel impl.
 */
export function createQuoteV2Router(quoteService: QuoteService): Router {
  const router = Router();

  router.get(
    '/warp',
    asyncHandler(async (req: Request, res: Response) => {
      const data = parseAndValidate(WarpQuerySchema, req.query);
      const quote = await quoteService.getWarpQuoteV2(data);
      const response: QuoteV2Response = { quote };
      res.json(response);
    }),
  );

  router.get(
    '/igp',
    asyncHandler(async (req: Request, res: Response) => {
      const data = parseAndValidate(IgpQuerySchema, req.query);
      const quote = await quoteService.getIgpQuoteV2(data);
      const response: QuoteV2Response = { quote };
      res.json(response);
    }),
  );

  return router;
}
