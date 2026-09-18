import { z } from 'zod';

import { type QuoteV2Response, ZHash } from '@hyperlane-xyz/sdk';
import { isValidAddressSealevel } from '@hyperlane-xyz/utils';

import type { FeeQuotingApp } from '../http.js';
import type { createApiKeyAuth } from '../middleware/apiKeyAuth.js';
import type { QuoteService } from '../services/quoteService.js';

import { bytes32Schema, domainSchema } from './commonSchemas.js';
import { parseAndValidate } from './parseAndValidate.js';

const svmAddressSchema = z.string().refine(isValidAddressSealevel, {
  message: 'Must be a valid Sealevel address (base58-encoded 32-byte pubkey)',
});
const protocolAddressSchema = z.union([ZHash, svmAddressSchema]);

// `router` and `txSubmitter` use protocol-agnostic address validation. The SVM
// branch is intentionally separate from SDK `ZHash` because valid Sealevel
// pubkeys are base58 strings that decode to 32 bytes, not fixed-width hashes.
const WarpQuerySchema = z.object({
  origin: z.string().min(1),
  router: protocolAddressSchema,
  destination: domainSchema,
  salt: bytes32Schema,
  recipient: bytes32Schema,
  targetRouter: bytes32Schema,
  txSubmitter: protocolAddressSchema,
});

const IgpQuerySchema = z.object({
  origin: z.string().min(1),
  router: protocolAddressSchema,
  destination: domainSchema,
  salt: bytes32Schema,
  txSubmitter: protocolAddressSchema,
});

const CompiledWarpQuerySchema = z.compile(WarpQuerySchema);
const CompiledIgpQuerySchema = z.compile(IgpQuerySchema);

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
 * `IProtocolQuoteService`; Phase 4 widens the registry with the Sealevel impl.
 */
export function registerQuoteV2Routes(
  app: FeeQuotingApp,
  quoteService: QuoteService,
  onRequest: ReturnType<typeof createApiKeyAuth>,
): void {
  const routeOptions = { onRequest };

  app.get('/v2/quote/warp', routeOptions, async (request, reply) => {
    const data = parseAndValidate(CompiledWarpQuerySchema, request.query);
    const quote = await quoteService.getWarpQuoteV2(data);
    const response: QuoteV2Response = { quote };
    return reply.send(response);
  });

  app.get('/v2/quote/igp', routeOptions, async (request, reply) => {
    const data = parseAndValidate(CompiledIgpQuerySchema, request.query);
    const quote = await quoteService.getIgpQuoteV2(data);
    const response: QuoteV2Response = { quote };
    return reply.send(response);
  });
}
