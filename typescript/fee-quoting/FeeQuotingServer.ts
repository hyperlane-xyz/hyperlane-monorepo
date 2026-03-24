import cors from 'cors';
import express, { Express } from 'express';
import type { Logger } from 'pino';
import { pinoHttp } from 'pino-http';
import { Registry } from 'prom-client';
import type { Address, Hex } from 'viem';

import { IRegistry } from '@hyperlane-xyz/registry';
import {
  type ChainMetadata,
  EvmWarpRouteReader,
  MultiProvider,
  getChainIdNumber,
  getDomainId,
} from '@hyperlane-xyz/sdk';
import { assert, createServiceLogger } from '@hyperlane-xyz/utils';

import packageJson from './package.json' with { type: 'json' };
import type { ServerConfig } from './src/config.js';
import { DEFAULT_PORT } from './src/constants.js';
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

    this.app.get('/metrics', async (_req, res) => {
      res.set('Content-Type', register.contentType);
      res.end(await register.metrics());
    });
    this.app.use(createHealthRouter(() => this.ready));

    const chainContexts = await this.buildChainContexts(registry);

    const quoteService = new QuoteService({
      signerKey: this.config.signerKey as Hex,
      quoteMode: this.config.quoteMode,
      quoteExpiry: this.config.quoteExpiry,
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

  private async buildChainContexts(
    registry: IRegistry,
  ): Promise<Map<string, ChainQuoteContext>> {
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
            chainMetadataMap[token.chainName] = metadata as ChainMetadata;
          }
        }
        return config;
      }),
    );

    const multiProvider = new MultiProvider(chainMetadataMap);
    const chainContexts = new Map<string, ChainQuoteContext>();

    for (const warpConfig of warpConfigs) {
      for (const token of warpConfig.tokens) {
        const { chainName } = token;

        const addresses = chainAddresses[chainName];
        assert(addresses, `No core addresses for chain: ${chainName}`);

        const quotedCallsAddress = addresses.quotedCalls;
        assert(
          quotedCallsAddress,
          `No quotedCalls address for chain: ${chainName}`,
        );

        const warpRouteAddress = token.addressOrDenom;
        assert(warpRouteAddress, `No address for token on chain: ${chainName}`);

        // Read full config from on-chain state
        const reader = new EvmWarpRouteReader(multiProvider, chainName);
        const derivedConfig =
          await reader.deriveWarpRouteConfig(warpRouteAddress);

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
          const metadata = chainMetadataMap[chainName];
          ctx = {
            chainId: getChainIdNumber(metadata),
            domainId: getDomainId(metadata),
            chainName,
            quotedCallsAddress: quotedCallsAddress as Address,
            multiProvider,
            routers: new Map(),
          };
          chainContexts.set(chainName, ctx);
        }

        ctx.routers.set(warpRouteAddress as Address, {
          feeToken,
          derivedConfig,
        });
      }
    }

    return chainContexts;
  }
}
