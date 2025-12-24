import fs from 'fs';
import { Logger } from 'pino';

import { IRegistry } from '@hyperlane-xyz/registry';
import { ChainMap, HyperlaneCore, MultiProvider } from '@hyperlane-xyz/sdk';
import { Address, rootLogger } from '@hyperlane-xyz/utils';

import { RelayerConfig } from '../config/RelayerConfig.js';

import {
  HyperlaneRelayer,
  RelayerCache,
  RelayerCacheSchema,
} from './HyperlaneRelayer.js';

export interface RelayerServiceConfig {
  mode: 'manual' | 'daemon';
  cacheFile?: string;
  retryTimeout?: number;
  logger?: Logger;
}

export class RelayerService {
  private relayer?: HyperlaneRelayer;
  private readonly logger: Logger;

  constructor(
    private readonly multiProvider: MultiProvider,
    private readonly registry: IRegistry,
    private readonly config: RelayerServiceConfig,
    private readonly relayerConfig?: RelayerConfig,
  ) {
    this.logger =
      config.logger ?? rootLogger.child({ module: 'RelayerService' });
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

    this.relayer = new HyperlaneRelayer({
      core,
      whitelist: relayerWhitelist,
      retryTimeout:
        this.config.retryTimeout ?? this.relayerConfig?.retryTimeout,
    });

    const cacheFile = this.config.cacheFile ?? this.relayerConfig?.cacheFile;
    if (cacheFile) {
      this.loadCache(cacheFile);
    }

    return this.relayer;
  }

  private buildWhitelistFromConfig(): ChainMap<Address[]> | undefined {
    if (this.relayerConfig?.whitelist) {
      return this.relayerConfig.whitelist as ChainMap<Address[]>;
    }

    if (this.relayerConfig?.chains) {
      return Object.fromEntries(
        this.relayerConfig.chains.map((chain) => [chain, []]),
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

    this.logger.info('Starting relayer...');
    relayer.start();

    process.once('SIGINT', () => this.stop());
    process.once('SIGTERM', () => this.stop());
  }

  stop(): void {
    if (!this.relayer) return;

    this.logger.info('Stopping relayer...');
    this.relayer.stop();

    const cacheFile = this.config.cacheFile ?? this.relayerConfig?.cacheFile;
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
