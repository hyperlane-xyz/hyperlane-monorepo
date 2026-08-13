import express, { Express, Request, Response } from 'express';
import type { Server } from 'node:http';
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
import { FileSystemRegistryWatcher } from './src/services/watcherService.js';

export interface HttpServerOptions {
  writeMode?: boolean;
}

export class HttpServer {
  app: Express;
  protected readonly logger: Logger;
  private registryService: RegistryService | null = null;
  protected readonly writeMode: boolean;

  private constructor(
    protected getRegistry: () => Promise<IRegistry>,
    logger: Logger,
    options: HttpServerOptions = {},
  ) {
    this.logger = logger;
    this.writeMode = options.writeMode ?? false;
    this.app = express();
    this.app.set('trust proxy', true); // trust proxy for x-forwarded-for header
    this.app.use(express.json());
  }

  static async create(
    getRegistry: () => Promise<IRegistry>,
    options: HttpServerOptions = {},
  ): Promise<HttpServer> {
    const logger = await createServiceLogger({
      service: 'http-registry-server',
      version: packageJson.version,
    });
    return new HttpServer(getRegistry, logger, options);
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

    let server: Server | undefined;
    try {
      this.registryService = new RegistryService(
        this.getRegistry,
        refreshInterval,
        this.logger,
        new FileSystemRegistryWatcher(),
      );
      await this.registryService.initialize();

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
      this.app.use(
        '/',
        createRootRouter(new RootService(this.registryService)),
      );
      this.app.use(
        '/chain',
        createChainRouter(new ChainService(this.registryService)),
      );
      this.app.use(
        '/warp-route',
        createWarpRouter(new WarpService(this.registryService), {
          writeMode: this.writeMode,
        }),
      );

      // add error handler to the end of the middleware stack
      this.app.use(createErrorHandler(this.logger));

      const host = process.env.HOST || ServerConstants.DEFAULT_HOST;
      const listeningServer = await this.listen(port, host);
      server = listeningServer;

      listeningServer.on('request', (req, _res) =>
        this.logger.info({ url: req.url }, 'Request received'),
      );
      listeningServer.on('error', (error) =>
        this.logger.error({ error }, 'Server error'),
      );

      // add shutdown handler
      const shutdown = () => {
        this.logger.info('Shutting down…');
        this.registryService?.stop();
        listeningServer.close(() => process.exit(0));
      };
      process.on('SIGTERM', shutdown);
      process.on('SIGINT', shutdown);
    } catch (error) {
      this.logger.error({ error }, 'Error starting server');
      // initialize() may have already started the registry's filesystem watcher,
      // whose active handle would keep the event loop alive after callers give up
      // on this failed start. Stop it (and any partially-set-up server) before
      // rethrowing so a bind failure cannot orphan a lingering watcher.
      this.registryService?.stop();
      this.registryService = null;
      server?.close();
      throw error;
    }
  }

  /**
   * Resolves once the server is listening and rejects if binding fails (e.g.
   * EADDRINUSE) before it starts listening, so callers can observe a bind
   * failure instead of a silently orphaned server. Runtime errors after
   * listening are logged rather than surfaced here.
   */
  private listen(port: number, host: string): Promise<Server> {
    return new Promise((resolve, reject) => {
      const server = this.app.listen(port, host);
      const onError = (error: Error) => reject(error);
      server.once('error', onError);
      server.once('listening', () => {
        server.removeListener('error', onError);
        this.logger.info({ port }, 'Server running');
        resolve(server);
      });
    });
  }
}
