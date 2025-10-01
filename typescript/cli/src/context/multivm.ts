import {
  CosmosNativeProviderFactory,
  CosmosNativeSignerFactory,
} from '@hyperlane-xyz/cosmos-sdk';
import { ChainMap, ChainMetadataManager, ChainName } from '@hyperlane-xyz/sdk';
import { MultiVM, ProtocolType } from '@hyperlane-xyz/utils';

export class MultiVMFactory<T> {
  // TODO: MULTIVM
  // make this dynamic
  public static readonly SUPPORTED_PROTOCOLS = [ProtocolType.CosmosNative];

  private readonly chains: ChainMap<T>;

  private constructor(chains: ChainMap<T>) {
    this.chains = chains;
  }

  public has(chain: ChainName): boolean {
    return !!this.chains[chain];
  }

  public get(chain: ChainName): T {
    return this.chains[chain];
  }

  public static async createProviders(
    metadataManager: ChainMetadataManager,
    chains: ChainName[],
  ) {
    const providers: ChainMap<MultiVM.IMultiVMProvider> = {};

    for (const chain of chains) {
      const metadata = metadataManager.getChainMetadata(chain);

      switch (metadata.protocol) {
        case ProtocolType.CosmosNative: {
          providers[chain] = await CosmosNativeProviderFactory.connect(
            metadata.rpcUrls[0].http,
          );
          break;
        }
        default: {
          throw new Error(
            `Chain ${chain} with protocol type ${metadata.protocol} not supported in MultiVM`,
          );
        }
      }
    }

    return new MultiVMFactory(providers);
  }

  public static async createSigners(
    metadataManager: ChainMetadataManager,
    chains: ChainName[],
    privateKey: string,
    extraParams?: Record<string, any>,
  ) {
    const providers: ChainMap<MultiVM.IMultiVMSigner> = {};

    for (const chain of chains) {
      const metadata = metadataManager.getChainMetadata(chain);

      switch (metadata.protocol) {
        case ProtocolType.CosmosNative: {
          providers[chain] = await CosmosNativeSignerFactory.connectWithSigner(
            metadata.rpcUrls[0].http,
            privateKey,
            extraParams,
          );
          break;
        }
        default: {
          throw new Error(
            `Chain ${chain} with protocol type ${metadata.protocol} not supported in MultiVM`,
          );
        }
      }
    }

    return new MultiVMFactory(providers);
  }
}
