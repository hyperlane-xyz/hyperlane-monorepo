import fs from 'fs';
import http from 'http';
import { Logger } from 'pino';

import { startMetricsServer } from '@hyperlane-xyz/metrics';
import { IRegistry } from '@hyperlane-xyz/registry';
import { ChainMap, HyperlaneCore, MultiProvider } from '@hyperlane-xyz/sdk';
import { Address, rootLogger } from '@hyperlane-xyz/utils';

import { RelayerConfigInput } from '../config/schema.js';
import { HyperlaneRelayer } from '../core/HyperlaneRelayer.js';
import { RelayerCache, RelayerCacheSchema } from '../core/cache.js';
import { RelayerEvent, RelayerObserver } from '../core/events.js';

import { RelayerMetrics, relayerMetricsRegistry } from './relayerMetrics.js';

export interface RelayerServiceConfig {
  relayerConfig?: RelayerConfigInput;
  logger?: Logger;
  /** Enable Prometheus metrics server (default: false) */
  enableMetrics?: boolean;
}

export class RelayerService {
  private relayer?: HyperlaneRelayer;
  private metricsServer?: http.Server;
  private readonly logger: Logger;
  readonly metrics: RelayerMetrics;

  private constructor(
    private readonly multiProvider: MultiProvider,
    private readonly registry: IRegistry,
    private readonly config: RelayerServiceConfig,
  ) {
    this.logger =
      config.logger ?? rootLogger.child({ module: 'RelayerService' });
    this.metrics = new RelayerMetrics();
  }

  static async create(
    multiProvider: MultiProvider,
    registry: IRegistry,
    config: RelayerServiceConfig,
    whitelist?: ChainMap<Address[]>,
  ): Promise<RelayerService> {
    const service = new RelayerService(multiProvider, registry, config);
    await service.initialize(whitelist);
    return service;
  }

  private handleEvent(event: RelayerEvent): void {
    switch (event.type) {
      case 'messageRelayed':
        this.metrics.recordMessageSuccess(
          event.originChain,
          event.destinationChain,
        );
        this.metrics.recordRelayDuration(
          event.originChain,
          event.destinationChain,
          event.durationMs / 1000,
        );
        break;
      case 'messageFailed':
        this.metrics.recordMessageFailure(
          event.originChain,
          event.destinationChain,
        );
        break;
      case 'messageSkipped':
        if (event.reason === 'whitelist') {
          this.metrics.recordMessageSkipped(
            event.originChain,
            event.destinationChain,
          );
        } else if (event.reason === 'already_delivered') {
          this.metrics.recordMessageAlreadyDelivered(
            event.originChain,
            event.destinationChain,
          );
        }
        break;
      case 'retry':
        this.metrics.recordRetry(event.originChain, event.destinationChain);
        break;
      case 'backlog':
        this.metrics.updateBacklogSize(event.size);
        break;
      default: {
        const _exhaustive: never = event;
        return _exhaustive;
      }
    }
  }

  private async initialize(
    whitelist?: ChainMap<Address[]>,
  ): Promise<HyperlaneRelayer> {
    if (this.relayer) {
      return this.relayer;
    }

    const chainAddresses = await this.registry.getAddresses();
    const core = HyperlaneCore.fromAddressesMap(
      chainAddresses,
      this.multiProvider,
    );

    const relayerWhitelist = whitelist ?? this.buildWhitelistFromConfig();

    const observer: RelayerObserver = {
      onEvent: (event: RelayerEvent) => this.handleEvent(event),
    };

    this.relayer = new HyperlaneRelayer({
      core,
      whitelist: relayerWhitelist,
      retryTimeout: this.config.relayerConfig?.retryTimeout,
      observer,
    });

    const cacheFile = this.config.relayerConfig?.cacheFile;
    if (cacheFile) {
      this.loadCache(cacheFile);
    }

    return this.relayer;
  }

  private buildWhitelistFromConfig(): ChainMap<Address[]> | undefined {
    const relayerConfig = this.config.relayerConfig;
    if (relayerConfig?.whitelist) {
      return relayerConfig.whitelist as ChainMap<Address[]>;
    }

    if (relayerConfig?.chains) {
      return Object.fromEntries(
        relayerConfig.chains.map((chain) => [chain, []]),
      );
    }

    return undefined;
  }

  private loadCache(cacheFile: string): void {
    if (!this.relayer) return;

    try {
      const contents = fs.readFileSync(cacheFile, 'utf-8');
      const data = JSON.parse(contents);
      const cache = RelayerCacheSchema.parse(data);
      this.relayer.hydrate(cache);
      this.logger.info(`Relayer cache loaded from ${cacheFile}`);
    } catch (e) {
      this.logger.debug(`Failed to load cache from ${cacheFile}: ${e}`);
    }
  }

  private saveCache(cacheFile: string): void {
    if (!this.relayer?.cache) return;

    try {
      const cache = JSON.stringify(this.relayer.cache);
      fs.writeFileSync(cacheFile, cache, 'utf-8');
      this.logger.info(`Relayer cache saved to ${cacheFile}`);
    } catch (e) {
      this.logger.error(`Failed to save cache to ${cacheFile}: ${e}`);
    }
  }

  async start(whitelist?: ChainMap<Address[]>): Promise<void> {
    const relayer = await this.initialize(whitelist);

    if (this.config.enableMetrics) {
      this.metricsServer = startMetricsServer(
        relayerMetricsRegistry,
        this.logger,
      );
    }

    this.logger.info('Starting relayer...');
    relayer.start();

    process.once('SIGINT', () => this.stop());
    process.once('SIGTERM', () => this.stop());
  }

  stop(): void {
    if (!this.relayer) return;

    this.logger.info('Stopping relayer...');
    this.relayer.stop();

    if (this.metricsServer) {
      this.metricsServer.close();
      this.logger.info('Metrics server stopped');
    }

    const cacheFile = this.config.relayerConfig?.cacheFile;
    if (cacheFile) {
      this.saveCache(cacheFile);
    }
  }

  async getRelayer(whitelist?: ChainMap<Address[]>): Promise<HyperlaneRelayer> {
    return this.initialize(whitelist);
  }

  getCache(): RelayerCache | undefined {
    return this.relayer?.cache;
  }
}
