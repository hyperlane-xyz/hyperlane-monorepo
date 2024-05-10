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
import {
  ChainMap,
  ChainMetadata,
  ChainName,
  WarpCoreConfig,
} from '@hyperlane-xyz/sdk';
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
    super({ uri: '__merged_registry__', logger });

    if (!registryUris.length)
      throw new Error('At least one registry URI is required');

    this.registries = registryUris.map((uri, index) => {
      if (isHttpsUrl(uri)) {
        return new GithubRegistry({ uri, logger: logger!.child({ index }) });
      } else {
        return new LocalRegistry({ uri, logger: logger!.child({ index }) });
      }
    });

    this.isDryRun = !!isDryRun;
  }

  async listRegistryContent(): Promise<RegistryContent> {
    const results = await this.multiRegistryRead((r) =>
      r.listRegistryContent(),
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
    const results = await this.multiRegistryRead((r) => r.getMetadata());
    return results.reduce((acc, content) => objMerge(acc, content), {});
  }

  async getChainMetadata(chainName: ChainName): Promise<ChainMetadata | null> {
    return (await this.getMetadata())[chainName] || null;
  }

  async getAddresses(): Promise<ChainMap<ChainAddresses>> {
    const results = await this.multiRegistryRead((r) => r.getAddresses());
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
      `adding chain ${chain.chainName}`,
    );
  }

  async updateChain(chain: {
    chainName: ChainName;
    metadata?: ChainMetadata;
    addresses?: ChainAddresses;
  }): Promise<void> {
    return this.multiRegistryWrite(
      async (registry) => await registry.updateChain(chain),
      `updating chain ${chain.chainName}`,
    );
  }

  async removeChain(chain: ChainName): Promise<void> {
    return this.multiRegistryWrite(
      async (registry) => await registry.removeChain(chain),
      `removing chain ${chain}`,
    );
  }

  async addWarpRoute(config: WarpCoreConfig): Promise<void> {
    return this.multiRegistryWrite(
      async (registry) => await registry.addWarpRoute(config),
      'adding warp route',
    );
  }

  protected multiRegistryRead<R>(
    readFn: (registry: IRegistry) => Promise<R> | R,
  ) {
    return Promise.all(this.registries.map(readFn));
  }

  protected async multiRegistryWrite(
    writeFn: (registry: IRegistry) => Promise<void>,
    logMsg: string,
  ): Promise<void> {
    if (this.isDryRun) return;
    for (const registry of this.registries) {
      // TODO remove this when GithubRegistry supports write methods
      if (registry.type === RegistryType.Github) {
        this.logger.warn(`skipping ${logMsg} at ${registry.type} registry`);
        continue;
      }
      try {
        this.logger.info(
          `${logMsg} at ${registry.type} registry at ${registry.uri}`,
        );
        await writeFn(registry);
        this.logger.info(`done ${logMsg} at ${registry.type} registry`);
      } catch (error) {
        // To prevent loss of artifacts, MergedRegistry write methods are failure tolerant
        this.logger.error(
          `failure ${logMsg} at ${registry.type} registry`,
          error,
        );
      }
    }
  }
}
