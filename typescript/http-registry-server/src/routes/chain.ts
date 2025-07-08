import { Request, Response, Router } from 'express';

import { ChainMetadataSchema, ZChainName } from '@hyperlane-xyz/sdk';

import AppConstants from '../constants/AppConstants.js';
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

  router.post(
    '/:chain/metadata',
    validateRequestParam('chain', ZChainName),
    validateBody(ChainMetadataSchema),
    async (req: Request, res: Response) => {
      await chainService.setChainMetadata(req.params.chain, req.body);
      res.sendStatus(AppConstants.HTTP_STATUS_NO_CONTENT);
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

  return router;
}
