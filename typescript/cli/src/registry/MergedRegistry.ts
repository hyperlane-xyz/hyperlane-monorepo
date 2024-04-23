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
  registryUris: Array<string>;
  isDryRun?: boolean;
  logger?: Logger;
}

export class MergedRegistry extends BaseRegistry implements IRegistry {
  public readonly type = RegistryType.Local;
  public readonly registries: Array<IRegistry>;
  public readonly isDryRun: boolean;

  constructor({ registryUris, logger, isDryRun }: MergedRegistryOptions) {
    logger ||= rootLogger.child({ module: 'MergedRegistry' });
    super({ logger });

    if (!registryUris.length)
      throw new Error('At least one registry URI is required');

    this.registries = registryUris.map((uri, index) => {
      // If not provided, allow the GithubRegistry to use its default
      if (isHttpsUrl(uri)) {
        return new GithubRegistry({ uri, logger: logger.child({ index }) });
      } else {
        return new LocalRegistry({ uri, logger: logger.child({ index }) });
      }
    });

    this.isDryRun = !!isDryRun;
  }

  async listRegistryContent(): Promise<RegistryContent> {
    const results = await Promise.all(
      this.registries.map((registry) => registry.listRegistryContent()),
    );
    return results.reduce((acc, content) => objMerge(acc, content), {
      chains: {},
      deployments: {},
    });
  }

  async getChains(): Promise<Array<ChainName>> {
    return objKeys(await this.getMetadata);
  }

  async getMetadata(): Promise<ChainMap<ChainMetadata>> {
    const results = await Promise.all(
      this.registries.map((registry) => registry.getMetadata()),
    );
    return results.reduce((acc, content) => objMerge(acc, content), {});
  }

  async getChainMetadata(chainName: ChainName): Promise<ChainMetadata | null> {
    return (await this.getMetadata())[chainName] || null;
  }

  async getAddresses(): Promise<ChainMap<ChainAddresses>> {
    const results = await Promise.all(
      this.registries.map((registry) => registry.getAddresses()),
    );
    return results.reduce((acc, content) => objMerge(acc, content), {});
  }

  async getChainAddresses(
    chainName: ChainName,
  ): Promise<ChainAddresses | null> {
    return (await this.getAddresses())[chainName] || null;
  }

  async addChain(chain: {
    chainName: ChainName;
    metadata?: ChainMetadata;
    addresses?: ChainAddresses;
  }): Promise<void> {
    return this.multiRegistryWrite(
      async (registry) => await registry.addChain(chain),
      'adding chain',
    );
  }

  async updateChain(chain: {
    chainName: ChainName;
    metadata?: ChainMetadata;
    addresses?: ChainAddresses;
  }): Promise<void> {
    return this.multiRegistryWrite(
      async (registry) => await registry.updateChain(chain),
      'updating chain',
    );
  }

  async removeChain(chain: ChainName): Promise<void> {
    return this.multiRegistryWrite(
      async (registry) => await registry.removeChain(chain),
      'removing chain',
    );
  }

  protected async multiRegistryWrite(
    writeFn: (registry: IRegistry) => Promise<void>,
    logMsg: string,
  ): Promise<void> {
    for (const registry of this.registries) {
      // TODO remove this when GithubRegistry supports write methods
      if (registry.type === RegistryType.Github) {
        this.logger.warn(`skipping ${logMsg} to registry ${registry.type}`);
        continue;
      }
      try {
        this.logger.info(`${logMsg} to registry ${registry.type}`);
        await writeFn(registry);
        this.logger.info(`done ${logMsg} to registry ${registry.type}`);
      } catch (error) {
        // To prevent loss of artifacts, MergedRegistry write methods are failure tolerant
        this.logger.error(
          `failure ${logMsg} to registry ${registry.type}`,
          error,
        );
      }
    }
  }
}
