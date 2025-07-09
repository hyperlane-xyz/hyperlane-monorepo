import { Request, Response, Router } from 'express';

import { UpdateChainSchema } from '@hyperlane-xyz/registry';
import { ZChainName } from '@hyperlane-xyz/sdk';

import { AppConstants } from '../constants/AppConstants.js';
import {
  validateBody,
  validateRequestParam,
} from '../middleware/validateRequest.js';
import { ChainService } from '../services/chainService.js';

export function createChainRouter(chainService: ChainService) {
  const router = Router();

  router.get(
    '/:chain/metadata',
    validateRequestParam('chain', ZChainName),
    async (req: Request, res: Response) => {
      const metadata = await chainService.getChainMetadata(req.params.chain);
      res.json(metadata);
    },
  );

  router.get(
    '/:chain/addresses',
    validateRequestParam('chain', ZChainName),
    async (req: Request, res: Response) => {
      const addresses = await chainService.getChainAddresses(req.params.chain);
      res.json(addresses);
    },
  );

  router.post(
    '/:chain',
    validateRequestParam('chain', ZChainName),
    validateBody(UpdateChainSchema.strict()),
    async (req: Request, res: Response) => {
      await chainService.updateChain({
        chainName: req.params.chain,
        ...req.body,
      });
      res.sendStatus(AppConstants.HTTP_STATUS_NO_CONTENT);
    },
  );

  return router;
}
