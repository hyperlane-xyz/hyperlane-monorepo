import cors from 'cors';
import express, { Express } from 'express';
import type { Logger } from 'pino';
import { pinoHttp } from 'pino-http';
import { Registry } from 'prom-client';
import type { Address, Hex } from 'viem';

import { IRegistry } from '@hyperlane-xyz/registry';
import {
  type ChainMetadata,
  EvmHookReader,
  EvmWarpRouteReader,
  HyperlaneCore,
  MultiProvider,
} from '@hyperlane-xyz/sdk';
import {
  ProtocolType,
  assert,
  createServiceLogger,
  isZeroishAddress,
  pick,
} from '@hyperlane-xyz/utils';

import packageJson from './package.json' with { type: 'json' };
import type { ServerConfig } from './src/config.js';
import { DEFAULT_METRICS_PORT, DEFAULT_PORT } from './src/constants.js';
import { createApiKeyAuth } from './src/middleware/apiKeyAuth.js';
import { createErrorHandler } from './src/middleware/errorHandler.js';
import { createMetrics } from './src/middleware/metrics.js';
import { createHealthRouter } from './src/routes/health.js';
import { createQuoteRouter } from './src/routes/quote.js';
import {
  QuoteService,
  type ChainQuoteContext,
} from './src/services/quoteService.js';

export class FeeQuotingServer {
  app: Express;
  private readonly logger: Logger;
  private readonly config: ServerConfig;
  private ready = false;

  private constructor(config: ServerConfig, logger: Logger) {
    this.config = config;
    this.logger = logger;
    this.app = express();
    this.app.set('trust proxy', true);
  }

  static async create(config: ServerConfig): Promise<FeeQuotingServer> {
    const logger = await createServiceLogger({
      service: 'fee-quoting',
      version: packageJson.version,
    });
    return new FeeQuotingServer(config, logger);
  }

  async start(registry: IRegistry) {
    const register = new Registry();
    const metrics = createMetrics(register);

    this.app.use(cors());
    this.app.use(express.json());
    this.app.use(pinoHttp({ logger: this.logger }));
    this.app.use(metrics.middleware);

    // Serve metrics on a separate port (cluster-internal only)
    const metricsApp = express();
    metricsApp.get('/metrics', async (_req, res) => {
      res.set('Content-Type', register.contentType);
      res.end(await register.metrics());
    });
    const metricsServer = metricsApp.listen(DEFAULT_METRICS_PORT, () => {
      this.logger.info(
        { port: DEFAULT_METRICS_PORT },
        'Metrics server running',
      );
    });
    metricsServer.on('error', (error) =>
      this.logger.error({ error }, 'Metrics server error'),
    );

    this.app.use(createHealthRouter(() => this.ready));

    const { multiProvider, chainContexts } =
      await this.buildChainContexts(registry);

    const quoteService = new QuoteService({
      signerKey: this.config.signerKey as Hex,
      quoteMode: this.config.quoteMode,
      quoteExpiry: this.config.quoteExpiry,
      multiProvider,
      chainContexts,
      logger: this.logger,
      quotesServed: metrics.quotesServed,
    });

    this.logger.info(
      {
        signerAddress: quoteService.signerAddress,
        chains: [...chainContexts.keys()],
        warpRouteIds: this.config.warpRouteIds,
        quoteMode: this.config.quoteMode,
      },
      'Quote service initialized',
    );

    // Log which quoters the signer can service per chain/router
    for (const [chainName, ctx] of chainContexts) {
      for (const [routerAddr] of ctx.routers) {
        this.logger.info(
          { chain: chainName, router: routerAddr },
          'Registered router',
        );
      }
    }

    const apiKeyAuth = createApiKeyAuth(
      new Set(this.config.apiKeys),
      this.logger,
    );
    this.app.use('/quote', apiKeyAuth, createQuoteRouter(quoteService));
    this.app.use(createErrorHandler(this.logger));

    const port = this.config.port ?? DEFAULT_PORT;
    const server = this.app.listen(port, () => {
      this.ready = true;
      this.logger.info({ port }, 'Server running');
    });

    server.on('error', (error) => this.logger.error({ error }, 'Server error'));

    const shutdown = () => {
      this.logger.info('Shutting down...');
      this.ready = false;
      metricsServer.close();
      server.close(() => {
        this.logger.info('Server closed');
        process.exit(0);
      });
      setTimeout(() => {
        this.logger.warn('Forcing shutdown after timeout');
        process.exit(1);
      }, 10_000).unref();
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
  }

  private async buildChainContexts(registry: IRegistry): Promise<{
    multiProvider: MultiProvider;
    chainContexts: Map<string, ChainQuoteContext>;
  }> {
    const chainAddresses = await registry.getAddresses();
    assert(chainAddresses, 'Failed to load registry addresses');

    // Collect all chain metadata across all warp routes
    const chainMetadataMap: Record<string, ChainMetadata> = {};
    const warpConfigs = await Promise.all(
      this.config.warpRouteIds.map(async (id) => {
        const config = await registry.getWarpRoute(id);
        assert(config, `Warp route not found: ${id}`);
        for (const token of config.tokens) {
          if (!chainMetadataMap[token.chainName]) {
            const metadata = await registry.getChainMetadata(token.chainName);
            assert(metadata, `No chain metadata for: ${token.chainName}`);
            chainMetadataMap[token.chainName] = metadata;
          }
        }
        return config;
      }),
    );

    const multiProvider = new MultiProvider(chainMetadataMap);
    const filteredAddresses = pick(
      chainAddresses,
      Object.keys(chainMetadataMap),
    );
    const core = HyperlaneCore.fromAddressesMap(
      filteredAddresses,
      multiProvider,
    );
    const chainContexts = new Map<string, ChainQuoteContext>();

    for (const warpConfig of warpConfigs) {
      for (const token of warpConfig.tokens) {
        const { chainName } = token;
        const metadata = chainMetadataMap[chainName];

        if (metadata?.protocol !== ProtocolType.Ethereum) {
          this.logger.debug(
            { chainName, protocol: metadata?.protocol },
            'Skipping non-EVM chain',
          );
          continue;
        }

        const addresses = chainAddresses[chainName];
        if (!addresses) {
          this.logger.warn({ chainName }, 'No core addresses, skipping');
          continue;
        }

        const quotedCallsAddress = addresses.quotedCalls;
        if (!quotedCallsAddress) {
          this.logger.warn({ chainName }, 'No quotedCalls address, skipping');
          continue;
        }

        const warpRouteAddress = token.addressOrDenom;
        assert(warpRouteAddress, `No address for token on chain: ${chainName}`);

        // Read full config from on-chain state
        const reader = new EvmWarpRouteReader(multiProvider, chainName);
        const derivedConfig =
          await reader.deriveWarpRouteConfig(warpRouteAddress);

        // Resolve hook with Mailbox default fallback when router hook is unset
        if (
          typeof derivedConfig.hook === 'string' &&
          isZeroishAddress(derivedConfig.hook)
        ) {
          const hookAddress = await core.getHook(
            chainName,
            warpRouteAddress as Address,
          );
          const hookReader = new EvmHookReader(multiProvider, chainName);
          derivedConfig.hook = await hookReader.deriveHookConfig(hookAddress);
        }

        this.logger.info(
          {
            chainName,
            warpRoute: warpRouteAddress,
            hookType:
              typeof derivedConfig.hook === 'string'
                ? 'address'
                : derivedConfig.hook.type,
            hasFee: !!derivedConfig.tokenFee,
            feeType: derivedConfig.tokenFee?.type,
          },
          'Derived warp route config',
        );

        const feeToken = (token.igpTokenAddressOrDenom ??
          token.addressOrDenom ??
          '0x0000000000000000000000000000000000000000') as Address;

        // Get or create chain context
        let ctx = chainContexts.get(chainName);
        if (!ctx) {
          ctx = {
            chainName,
            quotedCallsAddress: quotedCallsAddress as Address,
            routers: new Map(),
          };
          chainContexts.set(chainName, ctx);
        }

        ctx.routers.set(warpRouteAddress.toLowerCase() as Address, {
          feeToken,
          derivedConfig,
        });
      }
    }

    return { multiProvider, chainContexts };
  }
}
