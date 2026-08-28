import express, { Express, Request, Response } from 'express';
import type { Server } from 'node:http';
import type { Logger } from 'pino';

import { IRegistry } from '@hyperlane-xyz/registry';
import { createServiceLogger, isObjEmpty } from '@hyperlane-xyz/utils';

import packageJson from './package.json' with { type: 'json' };
import { AppConstants, ServerConstants } from './src/constants/index.js';
import { createErrorHandler } from './src/middleware/errorHandler.js';
import { createSignerRouter } from './src/routes/signer.js';
import { createChainRouter } from './src/routes/chain.js';
import { createRootRouter } from './src/routes/root.js';
import { createWarpRouter } from './src/routes/warp.js';
import { ChainService } from './src/services/chainService.js';
import { RegistryService } from './src/services/registryService.js';
import { RootService } from './src/services/rootService.js';
import { WarpService } from './src/services/warpService.js';
import { FileSystemRegistryWatcher } from './src/services/watcherService.js';
import { createSignerAuth, validateSignerToken } from './src/signer/auth.js';
import { createSignerErrorHandler } from './src/signer/errorHandler.js';
import { SignerService } from './src/signer/signerService.js';
import type { SignerBackends } from './src/signer/types.js';

export interface HttpServerOptions {
  writeMode?: boolean;
  corsAllowedOrigins?: string[];
  signerToken?: string;
  signers?: SignerBackends;
}

export function parseCorsAllowedOrigins(
  value = process.env.CORS_ALLOWED_ORIGINS,
): string[] {
  return value
    ? value
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean)
    : [];
}

export class HttpServer {
  app: Express;
  protected readonly logger: Logger;
  private registryService: RegistryService | null = null;
  private listeningServer: Server | null = null;
  private shutdownHandler: (() => void) | null = null;
  protected readonly writeMode: boolean;
  protected readonly corsAllowedOrigins: Set<string>;
  protected readonly signerToken?: string;
  protected readonly signers: SignerBackends;

  private constructor(
    protected getRegistry: () => Promise<IRegistry>,
    logger: Logger,
    options: HttpServerOptions = {},
  ) {
    this.logger = logger;
    this.writeMode = options.writeMode ?? false;
    this.corsAllowedOrigins = new Set(
      options.corsAllowedOrigins ?? parseCorsAllowedOrigins(),
    );
    this.signers = options.signers ?? {};
    this.signerToken = !isObjEmpty(this.signers)
      ? validateSignerToken(options.signerToken)
      : undefined;
    this.app = express();
    this.app.set('trust proxy', true); // trust proxy for x-forwarded-for header
    this.app.use((req, res, next) => {
      const origin = req.get('origin');
      const isCorsRead =
        this.corsAllowedOrigins.size > 0 &&
        (req.method === 'GET' || req.method === 'HEAD');
      if (isCorsRead) {
        res.vary('Origin');
      }
      if (
        origin &&
        isCorsRead &&
        (this.corsAllowedOrigins.has('*') ||
          this.corsAllowedOrigins.has(origin))
      ) {
        res.setHeader(
          'Access-Control-Allow-Origin',
          this.corsAllowedOrigins.has('*') ? '*' : origin,
        );
      }
      next();
    });
    const registryJsonParser = express.json();
    this.app.use((req, res, next) => {
      if (req.path === '/signer' || req.path.startsWith('/signer/')) {
        next();
        return;
      }
      registryJsonParser(req, res, next);
    });
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

      if (!isObjEmpty(this.signers)) {
        const host = process.env.HOST || ServerConstants.DEFAULT_HOST;
        if (host !== '127.0.0.1' && host !== '::1') {
          throw new Error('Signer mode requires HOST to be 127.0.0.1 or ::1');
        }
        await Promise.all(
          Object.values(this.signers).map((backend) => backend.healthCheck()),
        );
        const signerService = new SignerService(
          this.registryService,
          this.signers,
          this.logger,
        );
        if (!this.signerToken) {
          throw new Error('Signer token invariant violated');
        }
        this.app.use(
          '/signer',
          createSignerAuth(this.signerToken),
          express.json({ limit: '200kb' }),
          createSignerRouter(signerService),
          createSignerErrorHandler(this.logger),
        );
      }

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
        createChainRouter(new ChainService(this.registryService), {
          writeMode: this.writeMode,
        }),
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
      this.listeningServer = listeningServer;

      listeningServer.on('request', (req, _res) =>
        this.logger.info({ url: req.url }, 'Request received'),
      );
      listeningServer.on('error', (error) =>
        this.logger.error({ error }, 'Server error'),
      );

      // add shutdown handler
      const shutdown = () => {
        this.logger.info('Shutting down…');
        void this.stop().then(() => process.exit(0));
      };
      this.shutdownHandler = shutdown;
      process.on('SIGTERM', shutdown);
      process.on('SIGINT', shutdown);
      return listeningServer;
    } catch (error) {
      if (!isObjEmpty(this.signers)) {
        this.logger.error(
          { errorType: error instanceof Error ? error.name : typeof error },
          'Error starting signer server',
        );
      } else {
        this.logger.error({ error }, 'Error starting server');
      }
      // initialize() may have already started the registry's filesystem watcher,
      // whose active handle would keep the event loop alive after callers give up
      // on this failed start. Stop it (and any partially-set-up server) before
      // rethrowing so a bind failure cannot orphan a lingering watcher.
      this.registryService?.stop();
      this.registryService = null;
      this.listeningServer = null;
      server?.close();
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (this.shutdownHandler) {
      process.removeListener('SIGTERM', this.shutdownHandler);
      process.removeListener('SIGINT', this.shutdownHandler);
      this.shutdownHandler = null;
    }
    this.registryService?.stop();
    this.registryService = null;
    const server = this.listeningServer;
    this.listeningServer = null;
    if (!server) return;
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
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
