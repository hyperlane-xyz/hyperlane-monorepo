import { Request, Response, Router } from 'express';

import { UpdateChainSchema } from '@hyperlane-xyz/registry';
import { ZChainName } from '@hyperlane-xyz/sdk';

import { AppConstants } from '../constants/AppConstants.js';
import {
  validateBody,
  validateRequestParam,
} from '../middleware/validateRequest.js';
import { requireWriteMode } from '../middleware/writeMode.js';
import { ChainService } from '../services/chainService.js';

export interface ChainRouterOptions {
  writeMode?: boolean;
}

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
    validateBody(UpdateChainSchema.strict()),
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
