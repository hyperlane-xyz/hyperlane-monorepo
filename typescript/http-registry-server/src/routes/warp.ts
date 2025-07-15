import { Request, Response, Router } from 'express';
import { z } from 'zod';

import { validateRequestParam } from '../middleware/validateRequest.js';
import { WarpService } from '../services/warpService.js';

export function createWarpRouter(warpService: WarpService) {
  const router = Router();

  // get warp route
  router.get(
    '/*id',
    (req, res, next) => {
      if (Array.isArray(req.params.id)) {
        // The splat route captures path segments as an array. Join them back together.
        req.params.id = req.params.id.join('/');
      }
      next();
    },
    validateRequestParam('id', z.string()),
    async (req: Request, res: Response) => {
      const warpRoute = await warpService.getWarpRoute(req.params.id);
      res.json(warpRoute);
    },
  );

  return router;
}
