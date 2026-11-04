import fs from 'fs';
import http from 'http';
import { Logger } from 'pino';

import { startMetricsServer } from '@hyperlane-xyz/metrics';
import { IRegistry } from '@hyperlane-xyz/registry';
import { ChainMap, HyperlaneCore, MultiProvider } from '@hyperlane-xyz/sdk';
import { Address, LazyAsync, rootLogger } from '@hyperlane-xyz/utils';

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
  private relayerLazy?: LazyAsync<HyperlaneRelayer>;
  private metricsServer?: http.Server;
  private lifecycle = Promise.resolve();
  private running = false;
  private needsFinalization = false;
  private readonly signalHandler = () => {
    void this.stop().catch((error: unknown) => {
      this.logger.error({ error }, 'Failed to stop relayer service');
      process.exitCode = 1;
    });
  };
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

  /**
   * Creates and initializes a RelayerService.
   *
   * Note: The whitelist is captured on first initialization. If subsequent calls
   * to `getRelayer()` pass different whitelists, they will still receive the
   * relayer created with the whitelist from the first call.
   */
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

    if (!this.relayerLazy) {
      this.relayerLazy = new LazyAsync(() => this.createRelayer(whitelist));
    }

    this.relayer = await this.relayerLazy.get();
    return this.relayer;
  }

  private async createRelayer(
    whitelist?: ChainMap<Address[]>,
  ): Promise<HyperlaneRelayer> {
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
      return relayerConfig.whitelist;
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
      const temporaryFile = `${cacheFile}.${process.pid}.tmp`;
      fs.writeFileSync(temporaryFile, cache, 'utf-8');
      fs.renameSync(temporaryFile, cacheFile);
      this.logger.info(`Relayer cache saved to ${cacheFile}`);
    } catch (e) {
      this.logger.error(`Failed to save cache to ${cacheFile}: ${e}`);
      throw e;
    }
  }

  private transition(operation: () => Promise<void>): Promise<void> {
    const next = this.lifecycle.then(operation);
    // Keep later lifecycle requests usable after a failed transition. The
    // original promise is returned so its caller still observes the failure.
    this.lifecycle = next.catch((error: unknown) => {
      this.logger.error({ error }, 'Relayer service transition failed');
    });
    return next;
  }

  start(whitelist?: ChainMap<Address[]>): Promise<void> {
    return this.transition(async () => {
      if (this.running) return;
      const relayer = await this.initialize(whitelist);
      this.logger.info('Starting relayer...');
      relayer.start();
      this.running = true;
      this.needsFinalization = true;
      try {
        if (this.config.enableMetrics) {
          this.metricsServer = startMetricsServer(
            relayerMetricsRegistry,
            this.logger,
          );
        }
        process.once('SIGINT', this.signalHandler);
        process.once('SIGTERM', this.signalHandler);
      } catch (error) {
        this.running = false;
        await relayer.stopAndDrain();
        throw error;
      }
    });
  }

  /** Wait for in-flight work before writing the final cache snapshot. */
  stop(): Promise<void> {
    return this.transition(async () => {
      if (!this.running && !this.needsFinalization) return;
      this.running = false;
      process.removeListener('SIGINT', this.signalHandler);
      process.removeListener('SIGTERM', this.signalHandler);
      this.logger.info('Stopping relayer...');

      const metricsServer = this.metricsServer;
      this.metricsServer = undefined;
      const metricsClosed = metricsServer
        ? new Promise<void>((resolve, reject) => {
            metricsServer.close((error) => {
              if (error) reject(error);
              else resolve();
            });
          })
        : Promise.resolve();
      // Both owned resources must settle even if one fails.
      const outcomes = await Promise.allSettled([
        this.relayer?.stopAndDrain(),
        metricsClosed,
      ]);
      const cacheFile = this.config.relayerConfig?.cacheFile;
      if (cacheFile) this.saveCache(cacheFile);
      for (const outcome of outcomes) {
        if (outcome.status === 'rejected') throw outcome.reason;
      }
      this.needsFinalization = false;
    });
  }

  async getRelayer(whitelist?: ChainMap<Address[]>): Promise<HyperlaneRelayer> {
    return this.initialize(whitelist);
  }

  getCache(): RelayerCache | undefined {
    return this.relayer?.cache;
  }
}
