import fs from 'fs';
import { Logger } from 'pino';

import {
  BaseRegistry,
  ChainAddresses,
  GithubRegistry,
  IRegistry,
  RegistryContent,
  RegistryType,
} from '@hyperlane-xyz/registry';
import { LocalRegistry } from '@hyperlane-xyz/registry/local';
import { ChainMap, ChainMetadata, ChainName } from '@hyperlane-xyz/sdk';
import {
  isHttpsUrl,
  objKeys,
  objMerge,
  rootLogger,
} from '@hyperlane-xyz/utils';

export interface MergedRegistryOptions {
  primaryRegistryUri?: string;
  overrideRegistryUri?: string;
  logger?: Logger;
}

export class MergedRegistry extends BaseRegistry implements IRegistry {
  public type = RegistryType.Local;
  public readonly primaryRegistry: IRegistry;
  public readonly overrideRegistry: IRegistry | undefined;

  constructor({
    primaryRegistryUri,
    overrideRegistryUri,
    logger,
  }: MergedRegistryOptions) {
    logger ||= rootLogger.child({ module: 'MergedRegistry' });
    super({ logger });

    // If not provided, allow the GithubRegistry to use its default
    if (!primaryRegistryUri || isHttpsUrl(primaryRegistryUri)) {
      this.primaryRegistry = new GithubRegistry({
        uri: primaryRegistryUri,
        logger: logger.child({ registry: 'primary-github' }),
      });
    } else {
      this.primaryRegistry = new LocalRegistry({
        uri: primaryRegistryUri,
        logger: logger.child({ registry: 'primary-local' }),
      });
    }

    if (!overrideRegistryUri || !fs.existsSync(overrideRegistryUri)) {
      this.overrideRegistry = undefined;
    } else {
      this.overrideRegistry = new LocalRegistry({
        uri: overrideRegistryUri,
        logger: logger.child({ registry: 'override-local' }),
      });
    }
  }

  async listRegistryContent(): Promise<RegistryContent> {
    const primaryContent = await this.primaryRegistry.listRegistryContent();
    if (!this.overrideRegistry) return primaryContent;
    const overrideContent = await this.overrideRegistry.listRegistryContent();
    return objMerge(primaryContent, overrideContent);
  }

  async getChains(): Promise<Array<ChainName>> {
    return objKeys(await this.getMetadata);
  }

  async getMetadata(): Promise<ChainMap<ChainMetadata>> {
    const primaryMetadata = await this.primaryRegistry.getMetadata();
    if (!this.overrideRegistry) return primaryMetadata;
    const overrideMetadata = await this.overrideRegistry.getMetadata();
    return objMerge(primaryMetadata, overrideMetadata);
  }

  async getChainMetadata(chainName: ChainName): Promise<ChainMetadata | null> {
    return (await this.getMetadata())[chainName] || null;
  }

  async getAddresses(): Promise<ChainMap<ChainAddresses>> {
    const primaryAddresses = await this.primaryRegistry.getAddresses();
    if (!this.overrideRegistry) return primaryAddresses;
    const overrideAddresses = await this.overrideRegistry.getAddresses();
    return objMerge(primaryAddresses, overrideAddresses);
  }

  async getChainAddresses(
    chainName: ChainName,
  ): Promise<ChainAddresses | null> {
    return (await this.getAddresses())[chainName] || null;
  }

  async addChain(chains: {
    chainName: ChainName;
    metadata?: ChainMetadata;
    addresses?: ChainAddresses;
  }): Promise<void> {
    return this.primaryRegistry.addChain(chains);
  }

  async updateChain(chains: {
    chainName: ChainName;
    metadata?: ChainMetadata;
    addresses?: ChainAddresses;
  }): Promise<void> {
    return this.primaryRegistry.updateChain(chains);
  }

  async removeChain(chains: ChainName): Promise<void> {
    return this.primaryRegistry.removeChain(chains);
  }
}
