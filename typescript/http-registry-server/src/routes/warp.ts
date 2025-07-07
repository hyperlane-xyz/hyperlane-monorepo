import { Request, Response, Router } from 'express';
import { z } from 'zod';

import { validateRequestParam } from '../middleware/validateRequest.js';
import { WarpService } from '../services/warpService.js';

export function createWarpRouter(warpService: WarpService) {
  const router = Router();

  // get warp route
  router.get(
    '/:id',
    validateRequestParam('id', z.string()),
    async (req: Request, res: Response) => {
      const warpRoute = await warpService.getWarpRoute(req.params.id);
      res.json(warpRoute);
    },
  );

  return router;
}
