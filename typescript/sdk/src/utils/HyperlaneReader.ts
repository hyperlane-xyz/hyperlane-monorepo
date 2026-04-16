import { providers } from 'ethers';
import { LevelWithSilentOrString } from 'pino';

import type { ChainMetadata } from '../metadata/chainMetadataTypes.js';
import { HyperlaneSmartProvider } from '../providers/SmartProvider/SmartProvider.js';
import type { ChainName, ChainNameOrId } from '../types.js';

export interface EvmReadProviderRegistry<MetaExt = {}> {
  getEvmProvider(chainNameOrId: ChainNameOrId): providers.Provider;
  getChainMetadata(chainNameOrId: ChainNameOrId): ChainMetadata<MetaExt>;
  getChainName(chainNameOrId: ChainNameOrId): ChainName;
  tryGetChainName(chainNameOrId: ChainNameOrId): string | null;
  getKnownChainNames(): string[];
  getDomainId(chainNameOrId: ChainNameOrId): number;
  tryGetRpcConcurrency(
    chainNameOrId: ChainNameOrId,
    index?: number,
  ): number | null;
}

export class HyperlaneReader<MetaExt = {}> {
  provider: providers.Provider;

  constructor(
    protected readonly multiProvider: EvmReadProviderRegistry<MetaExt>,
    protected readonly chain: ChainNameOrId,
  ) {
    this.provider = this.multiProvider.getEvmProvider(chain);
  }

  /**
   * Conditionally sets the log level for a smart provider.
   *
   * @param level - The log level to set, e.g. 'debug', 'info', 'warn', 'error'.
   */
  protected setSmartProviderLogLevel(level: LevelWithSilentOrString): void {
    if (this.provider instanceof HyperlaneSmartProvider) {
      this.provider.setLogLevel(level);
    }
  }
}
