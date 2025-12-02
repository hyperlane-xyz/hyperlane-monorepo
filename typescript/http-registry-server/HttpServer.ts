import express, { Express, Request, Response } from 'express';
import type { Logger } from 'pino';

import { IRegistry } from '@hyperlane-xyz/registry';
import { createServiceLogger } from '@hyperlane-xyz/utils';

import packageJson from './package.json' with { type: 'json' };
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
  protected readonly logger: Logger;

  private constructor(
    protected getRegistry: () => Promise<IRegistry>,
    logger: Logger,
  ) {
    this.logger = logger;
    this.app = express();
    this.app.set('trust proxy', true); // trust proxy for x-forwarded-for header
    this.app.use(express.json());
  }

  static async create(
    getRegistry: () => Promise<IRegistry>,
  ): Promise<HttpServer> {
    const logger = await createServiceLogger({
      service: 'http-registry-server',
      version: packageJson.version,
    });
    return new HttpServer(getRegistry, logger);
  }

  async start(
    portInput = process.env.PORT,
    refreshIntervalInput = process.env.REFRESH_INTERVAL,
  ) {
    const parsedPort = parseInt(portInput || '', 10);
    const isPortInvalid = isNaN(parsedPort);
    const port = isPortInvalid ? ServerConstants.DEFAULT_PORT : parsedPort;
    if (isPortInvalid && portInput) {
      this.logger.warn(
        { port: portInput, defaultPort: ServerConstants.DEFAULT_PORT },
        `Invalid PORT value "${portInput}". Falling back to default ${ServerConstants.DEFAULT_PORT}.`,
      );
    }

    const parsedRefreshInterval = parseInt(refreshIntervalInput || '', 10);
    const isRefreshIntervalInvalid = isNaN(parsedRefreshInterval);
    const refreshInterval = isRefreshIntervalInvalid
      ? ServerConstants.DEFAULT_REFRESH_INTERVAL
      : parsedRefreshInterval;
    if (isRefreshIntervalInvalid && refreshIntervalInput) {
      this.logger.warn(
        {
          refreshInterval: refreshIntervalInput,
          defaultRefreshInterval: ServerConstants.DEFAULT_REFRESH_INTERVAL,
        },
        `Invalid REFRESH_INTERVAL value "${refreshIntervalInput}". Falling back to default ${ServerConstants.DEFAULT_REFRESH_INTERVAL}.`,
      );
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
        this.logger.info({ port }, 'Server running'),
      );

      server.on('request', (req, _res) =>
        this.logger.info({ url: req.url }, 'Request received'),
      );
      server.on('error', (error) =>
        this.logger.error({ error }, 'Server error'),
      );

      // add shutdown handler
      const shutdown = () => {
        this.logger.info('Shutting down…');
        server.close(() => process.exit(0));
      };
      process.on('SIGTERM', shutdown);
      process.on('SIGINT', shutdown);
    } catch (error) {
      this.logger.error({ error }, 'Error starting server');
      process.exit(1);
    }
  }
}
