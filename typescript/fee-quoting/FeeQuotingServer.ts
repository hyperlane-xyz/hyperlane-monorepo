import cors from '@fastify/cors';
import Fastify from 'fastify';
import type { Logger } from 'pino';
import { Registry } from 'prom-client';
import { type Address, hexToBytes, isAddress, isHex } from 'viem';

import { IRegistry } from '@hyperlane-xyz/registry';
import {
  type ChainMetadata,
  HyperlaneCore,
  MultiProvider,
} from '@hyperlane-xyz/sdk';
import {
  type ChainMetadataForAltVM,
  ProtocolType,
} from '@hyperlane-xyz/provider-sdk';
import { assert, createServiceLogger, pick } from '@hyperlane-xyz/utils';

import packageJson from './package.json' with { type: 'json' };
import type { ServerConfig } from './src/config.js';
import { DEFAULT_METRICS_PORT, DEFAULT_PORT } from './src/constants.js';
import type { FeeQuotingApp } from './src/http.js';
import { createApiKeyAuth } from './src/middleware/apiKeyAuth.js';
import { createErrorHandler } from './src/middleware/errorHandler.js';
import { createMetrics } from './src/middleware/metrics.js';
import { registerHealthRoute } from './src/routes/health.js';
import { registerQuoteRoutes } from './src/routes/quote.js';
import { registerQuoteV2Routes } from './src/routes/quote.v2.js';
import {
  EvmQuoteService,
  type EvmRouteSpec,
} from './src/services/evmQuoteService.js';
import type { IProtocolQuoteService } from './src/services/IProtocolQuoteService.js';
import { QuoteService } from './src/services/quoteService.js';
import {
  SvmQuoteService,
  type SvmRouteSpec,
} from './src/services/svmQuoteService.js';

export class FeeQuotingServer {
  readonly app: FeeQuotingApp;
  private readonly logger: Logger;
  private readonly config: ServerConfig;
  private ready = false;

  private constructor(config: ServerConfig, logger: Logger) {
    this.config = config;
    this.logger = logger;
    this.app = createApp(logger);
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

    await this.app.register(cors);
    this.app.addHook('onRequest', metrics.onRequest);
    this.app.addHook('onResponse', metrics.onResponse);
    this.app.setErrorHandler(createErrorHandler(this.logger));

    // Serve metrics on a separate port (cluster-internal only)
    const metricsApp = Fastify({ logger: false });
    metricsApp.get('/metrics', async (_request, reply) => {
      reply.type(register.contentType);
      return register.metrics();
    });
    registerHealthRoute(this.app, () => this.ready);

    const { multiProvider, core, evmRoutes, svmRoutes, protocolByChain } =
      await this.partitionWarpRoutes(registry);

    assert(
      isHex(this.config.signerKey),
      'signerKey must be a valid hex string',
    );
    const signerKeyHex = this.config.signerKey;

    const evm = await EvmQuoteService.create({
      signerKey: signerKeyHex,
      logger: this.logger,
      multiProvider,
      core,
      routes: evmRoutes,
    });

    const services: Map<ProtocolType, IProtocolQuoteService> = new Map([
      [ProtocolType.Ethereum, evm],
    ]);

    if (svmRoutes.length > 0) {
      const svm = await SvmQuoteService.create({
        // Same secp256k1 key as EVM — SVM verifier recovers H160 the same way
        // viem's `privateKeyToAccount` does, so the whitelist entry can be
        // identical across protocols.
        signerKey: hexToBytes(signerKeyHex),
        logger: this.logger,
        multiProvider,
        routes: svmRoutes,
      });
      services.set(ProtocolType.Sealevel, svm);
    }

    const quoteService = new QuoteService({
      services,
      protocolByChain,
      quoteMode: this.config.quoteMode,
      quoteExpiry: this.config.quoteExpiry,
      transientBuffer: this.config.transientBuffer,
      multiProvider,
      logger: this.logger,
      quotesServed: metrics.quotesServed,
    });

    this.logger.info(
      {
        signerAddress: quoteService.signerAddress,
        chains: [...protocolByChain.keys()],
        warpRouteIds: this.config.warpRouteIds,
        quoteMode: this.config.quoteMode,
      },
      'Quote service initialized',
    );

    for (const r of evmRoutes) {
      this.logger.info(
        { chain: r.origin, router: r.warpRouter, protocol: 'ethereum' },
        'Registered router',
      );
    }
    for (const r of svmRoutes) {
      this.logger.info(
        { chain: r.origin, router: r.warpProgramId, protocol: 'sealevel' },
        'Registered router',
      );
    }

    const apiKeyAuth = createApiKeyAuth(
      new Set(this.config.apiKeys),
      this.logger,
    );
    registerQuoteRoutes(this.app, quoteService, apiKeyAuth);
    registerQuoteV2Routes(this.app, quoteService, apiKeyAuth);

    const port = this.config.port ?? DEFAULT_PORT;
    try {
      await metricsApp.listen({
        host: '0.0.0.0',
        port: DEFAULT_METRICS_PORT,
      });
      this.logger.info(
        { port: DEFAULT_METRICS_PORT },
        'Metrics server running',
      );
      await this.app.listen({ host: '0.0.0.0', port });
      this.ready = true;
      this.logger.info({ port }, 'Server running');
    } catch (error) {
      await Promise.allSettled([metricsApp.close(), this.app.close()]);
      throw error;
    }

    let shuttingDown = false;
    const shutdown = async () => {
      if (shuttingDown) return;
      shuttingDown = true;
      this.logger.info('Shutting down...');
      this.ready = false;
      setTimeout(() => {
        this.logger.warn('Forcing shutdown after timeout');
        process.exit(1);
      }, 10_000).unref();
      try {
        await Promise.all([metricsApp.close(), this.app.close()]);
        this.logger.info('Server closed');
        process.exit(0);
      } catch (error) {
        this.logger.error({ error }, 'Failed to close server');
        process.exit(1);
      }
    };
    process.once('SIGTERM', shutdown);
    process.once('SIGINT', shutdown);
  }

  /**
   * Walk the configured warp routes and partition their tokens by protocol.
   * Each protocol's concrete service consumes only its own slice. Builds the
   * `protocolByChain` map used by `QuoteService` for v2 dispatch.
   */
  private async partitionWarpRoutes(registry: IRegistry): Promise<{
    multiProvider: MultiProvider;
    core: HyperlaneCore;
    evmRoutes: EvmRouteSpec[];
    svmRoutes: SvmRouteSpec[];
    protocolByChain: Map<string, ProtocolType>;
  }> {
    const chainAddresses = await registry.getAddresses();
    assert(chainAddresses, 'Failed to load registry addresses');

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

    const evmRoutes: EvmRouteSpec[] = [];
    const svmRoutes: SvmRouteSpec[] = [];
    const protocolByChain = new Map<string, ProtocolType>();

    for (const warpConfig of warpConfigs) {
      for (const token of warpConfig.tokens) {
        const { chainName } = token;
        const metadata = chainMetadataMap[chainName];

        switch (metadata?.protocol) {
          case ProtocolType.Ethereum:
          case ProtocolType.Tron: {
            const spec = this.buildEvmRouteSpec(
              chainName,
              token,
              chainAddresses,
            );
            if (spec) {
              evmRoutes.push(spec);
              protocolByChain.set(chainName, metadata.protocol);
            }
            break;
          }
          case ProtocolType.Sealevel: {
            const spec = this.buildSvmRouteSpec(chainName, token, metadata);
            if (spec) {
              svmRoutes.push(spec);
              protocolByChain.set(chainName, ProtocolType.Sealevel);
            }
            break;
          }
          default:
            this.logger.debug(
              { chainName, protocol: metadata?.protocol },
              'Skipping chain with unsupported protocol',
            );
        }
      }
    }

    return { multiProvider, core, evmRoutes, svmRoutes, protocolByChain };
  }

  private buildEvmRouteSpec(
    chainName: string,
    token: { addressOrDenom?: string; igpTokenAddressOrDenom?: string },
    chainAddresses: Record<string, Record<string, string>>,
  ): EvmRouteSpec | undefined {
    const addresses = chainAddresses[chainName];
    if (!addresses) {
      this.logger.warn({ chainName }, 'No core addresses, skipping');
      return undefined;
    }

    const quotedCallsAddress = addresses.quotedCalls;
    if (!quotedCallsAddress) {
      this.logger.warn({ chainName }, 'No quotedCalls address, skipping');
      return undefined;
    }

    const warpRouteAddress = token.addressOrDenom;
    assert(warpRouteAddress, `No address for token on chain: ${chainName}`);

    const feeTokenRaw = token.igpTokenAddressOrDenom ?? warpRouteAddress;
    assert(
      isAddress(feeTokenRaw),
      `Fee token for ${chainName} is not a valid EVM address: ${feeTokenRaw}`,
    );
    assert(
      isAddress(quotedCallsAddress),
      `quotedCalls for ${chainName} is not a valid EVM address: ${quotedCallsAddress}`,
    );
    assert(
      isAddress(warpRouteAddress),
      `Warp router for ${chainName} is not a valid EVM address: ${warpRouteAddress}`,
    );
    const feeToken: Address = feeTokenRaw;
    const quotedCalls: Address = quotedCallsAddress;
    const warpRouter: Address = warpRouteAddress;

    return {
      origin: chainName,
      warpRouter,
      quotedCallsAddress: quotedCalls,
      feeToken,
    };
  }

  /**
   * Build the Sealevel route spec consumed by `SvmQuoteService.create`. The
   * warp program ID comes from the registry token entry; fee program +
   * fee_account PDA + IGP-hook signers are discovered on-chain at service
   * construction time (no registry plumbing required).
   *
   * SVM has no `quotedCalls`-equivalent contract, so unlike EVM there's no
   * core-addresses precondition for the route to be registered.
   */
  private buildSvmRouteSpec(
    chainName: string,
    token: { addressOrDenom?: string },
    metadata: ChainMetadata,
  ): SvmRouteSpec | undefined {
    const warpProgramId = token.addressOrDenom;
    if (!warpProgramId) {
      this.logger.warn(
        { chainName },
        'No warp program ID for Sealevel token, skipping',
      );
      return undefined;
    }
    return {
      origin: chainName,
      domainId: metadata.domainId,
      warpProgramId,
      // `ChainMetadata` from the registry is a structural superset of the
      // multi-VM `ChainMetadataForAltVM` artifact managers consume.
      chainMetadata: metadata satisfies ChainMetadataForAltVM,
    };
  }
}

function createApp(logger: Logger) {
  return Fastify({
    bodyLimit: 100 * 1_024,
    loggerInstance: logger,
    trustProxy: true,
  });
}
