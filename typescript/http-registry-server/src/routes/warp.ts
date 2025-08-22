import { Request, Response, Router } from 'express';
import { z } from 'zod';

import { WarpRouteFilterSchema } from '@hyperlane-xyz/registry';

import {
  joinPathSegments,
  validateQueryParams,
  validateRequestParam,
} from '../middleware/validateRequest.js';
import { WarpService } from '../services/warpService.js';

export function createWarpRouter(warpService: WarpService) {
  const router = Router();

  // get warp deploy config
  router.get(
    '/deploy/*id',
    joinPathSegments,
    validateRequestParam('id', z.string()),
    async (req: Request, res: Response) => {
      const warpRoute = await warpService.getWarpDeployConfig(req.params.id);
      res.json(warpRoute);
    },
  );

  // get warp core config
  router.get(
    '/core/*id',
    joinPathSegments,
    validateRequestParam('id', z.string()),
    async (req: Request, res: Response) => {
      const warpRoute = await warpService.getWarpCoreConfig(req.params.id);
      res.json(warpRoute);
    },
  );

  router.get(
    '/core',
    validateQueryParams(WarpRouteFilterSchema),
    async (req: Request, res: Response) => {
      const warpRoute = await warpService.getWarpCoreConfigs(req.query);
      res.json(warpRoute);
    },
  );

  return router;
}
