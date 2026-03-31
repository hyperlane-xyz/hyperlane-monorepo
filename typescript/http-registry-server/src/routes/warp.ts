import { NextFunction, Request, Response, Router } from 'express';
import { z } from 'zod';

import {
  AddWarpRouteConfigOptionsSchema,
  WarpRouteFilterSchema,
} from '@hyperlane-xyz/registry';
import {
  WarpCoreConfigSchema,
  WarpRouteDeployConfigSchema,
} from '@hyperlane-xyz/sdk';

import { AppConstants } from '../constants/AppConstants.js';
import { MethodNotAllowedError } from '../errors/ApiError.js';
import {
  joinPathSegments,
  validateBody,
  validateQueryParams,
  validateRequestParam,
} from '../middleware/validateRequest.js';
import { WarpService } from '../services/warpService.js';

export interface WarpRouterOptions {
  writeMode?: boolean;
}

const AddWarpRouteBodySchema = z.object({
  config: WarpCoreConfigSchema,
  options: AddWarpRouteConfigOptionsSchema.optional(),
});

const AddWarpRouteConfigBodySchema = z.object({
  config: WarpRouteDeployConfigSchema,
  options: AddWarpRouteConfigOptionsSchema,
});

function requireWriteMode(writeMode: boolean) {
  return (_req: Request, _res: Response, next: NextFunction) => {
    if (!writeMode) {
      return next(new MethodNotAllowedError());
    }
    next();
  };
}

export function createWarpRouter(
  warpService: WarpService,
  options: WarpRouterOptions = {},
): Router {
  const router = Router();
  const { writeMode = false } = options;

  // get warp deploy config by id
  router.get(
    '/deploy/*id',
    joinPathSegments,
    validateRequestParam('id', z.string()),
    async (req: Request, res: Response) => {
      const warpRoute = await warpService.getWarpDeployConfig(req.params.id);
      res.json(warpRoute);
    },
  );

  // get all warp deploy configs
  router.get(
    '/deploy',
    validateQueryParams(WarpRouteFilterSchema),
    async (req: Request, res: Response) => {
      const warpDeployConfigs = await warpService.getWarpDeployConfigs(
        req.query,
      );
      res.json(warpDeployConfigs);
    },
  );

  // add warp deploy config
  router.post(
    '/deploy',
    requireWriteMode(writeMode),
    validateBody(AddWarpRouteConfigBodySchema),
    async (req: Request, res: Response) => {
      await warpService.addWarpRouteConfig(req.body.config, req.body.options);
      res.sendStatus(AppConstants.HTTP_STATUS_NO_CONTENT);
    },
  );

  // get warp core config by id
  router.get(
    '/core/*id',
    joinPathSegments,
    validateRequestParam('id', z.string()),
    async (req: Request, res: Response) => {
      const warpRoute = await warpService.getWarpCoreConfig(req.params.id);
      res.json(warpRoute);
    },
  );

  // get all warp core configs
  router.get(
    '/core',
    validateQueryParams(WarpRouteFilterSchema),
    async (req: Request, res: Response) => {
      const warpRoute = await warpService.getWarpCoreConfigs(req.query);
      res.json(warpRoute);
    },
  );

  // add warp route (core config)
  router.post(
    '/',
    requireWriteMode(writeMode),
    validateBody(AddWarpRouteBodySchema),
    async (req: Request, res: Response) => {
      await warpService.addWarpRoute(req.body.config, req.body.options);
      res.sendStatus(AppConstants.HTTP_STATUS_NO_CONTENT);
    },
  );

  return router;
}
