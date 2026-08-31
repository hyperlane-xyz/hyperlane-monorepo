import { Request, Response, Router } from 'express';
import { z } from 'zod';

import { ChainAddressesSchema } from '@hyperlane-xyz/registry';
import { ChainMetadataSchema, ZChainName } from '@hyperlane-xyz/sdk';

import { AppConstants } from '../constants/AppConstants.js';
import {
  legacyRegistrySchema,
  validateBody,
  validateRequestParam,
} from '../middleware/validateRequest.js';
import { requireWriteMode } from '../middleware/writeMode.js';
import { ChainService } from '../services/chainService.js';

export interface ChainRouterOptions {
  writeMode?: boolean;
}

// The published registry's UpdateChainSchema combines its Zod 3 object with
// the consumer-provided SDK schema, which is Zod 4 after this migration.
// Compose the same boundary in Zod 4 until the linked registry release lands.
const UpdateChainBodySchema = z.strictObject({
  metadata: ChainMetadataSchema.optional(),
  addresses: legacyRegistrySchema(ChainAddressesSchema).optional(),
});

export function createChainRouter(
  chainService: ChainService,
  options: ChainRouterOptions = {},
): Router {
  const router = Router();
  const { writeMode = false } = options;

  router.get(
    '/:chain/metadata',
    validateRequestParam('chain', ZChainName),
    async (req: Request<{ chain: string }>, res: Response) => {
      const metadata = await chainService.getChainMetadata(req.params.chain);
      res.json(metadata);
    },
  );

  router.get(
    '/:chain/addresses',
    validateRequestParam('chain', ZChainName),
    async (req: Request<{ chain: string }>, res: Response) => {
      const addresses = await chainService.getChainAddresses(req.params.chain);
      res.json(addresses);
    },
  );

  router.post(
    '/:chain',
    requireWriteMode(writeMode),
    validateRequestParam('chain', ZChainName),
    validateBody(UpdateChainBodySchema),
    async (req: Request<{ chain: string }>, res: Response) => {
      await chainService.updateChain({
        chainName: req.params.chain,
        ...req.body,
      });
      res.sendStatus(AppConstants.HTTP_STATUS_NO_CONTENT);
    },
  );

  return router;
}
