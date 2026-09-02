import { Router } from 'express';

import { assert } from '@hyperlane-xyz/utils';

import {
  validateBody,
  validateRequestParam,
} from '../middleware/validateRequest.js';
import {
  SignerTransactionRequestSchema,
  SignerTypedDataRequestSchema,
} from '../signer/schemas.js';
import type { SignerService } from '../signer/signerService.js';

const ChainNameSchema = SignerTransactionRequestSchema.shape.chain;

export function createSignerRouter(service: SignerService): Router {
  const router = Router();

  router.get(
    '/account/:chain',
    validateRequestParam('chain', ChainNameSchema),
    async (req, res, next) => {
      try {
        const chain = req.params.chain;
        assert(typeof chain === 'string', 'Expected one chain name');
        res.json(await service.getAccount(chain));
      } catch (error) {
        next(error);
      }
    },
  );
  router.post(
    '/transaction',
    validateBody(SignerTransactionRequestSchema),
    async (req, res, next) => {
      try {
        res.json(await service.signTransaction(req.body));
      } catch (error) {
        next(error);
      }
    },
  );
  router.post(
    '/typed-data',
    validateBody(SignerTypedDataRequestSchema),
    async (req, res, next) => {
      try {
        res.json(await service.signTypedData(req.body));
      } catch (error) {
        next(error);
      }
    },
  );
  return router;
}
