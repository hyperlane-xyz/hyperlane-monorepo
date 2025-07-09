import express, { Express, Request, Response } from 'express';
import type { Logger } from 'pino';

import { IRegistry } from '@hyperlane-xyz/registry';

import { AppConstants, ServerConstants } from './src/constants/index.js';
import { createErrorHandler } from './src/middleware/errorHandler.js';
import { createChainRouter } from './src/routes/chain.js';
import { createRootRouter } from './src/routes/root.js';
import { createWarpRouter } from './src/routes/warp.js';
import { ChainService } from './src/services/chainService.js';
import { RegistryService } from './src/services/registryService.js';
import { RootService } from './src/services/rootService.js';
import { WarpService } from './src/services/warpService.js';

export class HttpServer {
  app: Express;
  protected logger: Logger | Console;

  constructor(
    protected getRegistry: () => Promise<IRegistry>,
    logger?: Logger,
  ) {
    this.logger = logger || console;
    this.app = express();
    this.app.set('trust proxy', true); // trust proxy for x-forwarded-for header
    this.app.use(express.json());
  }

  async start(
    portInput = process.env.PORT,
    refreshIntervalInput = process.env.REFRESH_INTERVAL,
  ) {
    let port = parseInt(portInput || '', 10);
    if (isNaN(port)) {
      if (portInput) {
        this.logger.warn(
          `Invalid PORT value "${portInput}". Falling back to default ${ServerConstants.DEFAULT_PORT}.`,
        );
      }
      port = ServerConstants.DEFAULT_PORT;
    }

    let refreshInterval = parseInt(refreshIntervalInput || '', 10);
    if (isNaN(refreshInterval)) {
      if (refreshIntervalInput) {
        this.logger.warn(
          `Invalid REFRESH_INTERVAL value "${refreshIntervalInput}". Falling back to default ${ServerConstants.DEFAULT_REFRESH_INTERVAL}.`,
        );
      }
      refreshInterval = ServerConstants.DEFAULT_REFRESH_INTERVAL;
    }

    try {
      const registryService = new RegistryService(
        this.getRegistry,
        refreshInterval,
        this.logger,
      );
      await registryService.initialize();

      // add health check routes
      this.app.use(
        '/health',
        (_req: Request, res: Response) =>
          void res.sendStatus(AppConstants.HTTP_STATUS_OK),
      );
      this.app.use(
        '/readiness',
        (_req: Request, res: Response) =>
          void res.sendStatus(AppConstants.HTTP_STATUS_OK),
      );

      // add routes
      this.app.use('/', createRootRouter(new RootService(registryService)));
      this.app.use(
        '/chain',
        createChainRouter(new ChainService(registryService)),
      );
      this.app.use(
        '/warp-route',
        createWarpRouter(new WarpService(registryService)),
      );

      // add error handler to the end of the middleware stack
      this.app.use(createErrorHandler(this.logger));

      const host = process.env.HOST || ServerConstants.DEFAULT_HOST;
      const server = this.app.listen(port, host, () =>
        this.logger.info(`Server running on port ${port}`),
      );

      server.on('request', (req, _res) =>
        this.logger.info('Request:', req.url),
      );
      server.on('error', (error) => this.logger.error('Server error:', error));

      // add shutdown handler
      const shutdown = () => {
        this.logger.info('Shutting down…');
        server.close(() => process.exit(0));
      };
      process.on('SIGTERM', shutdown);
      process.on('SIGINT', shutdown);
    } catch (error) {
      this.logger.error('Error starting server:', error);
      process.exit(1);
    }
  }
}
