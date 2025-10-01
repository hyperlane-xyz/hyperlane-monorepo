import {
  CosmosNativeProviderFactory,
  CosmosNativeSignerFactory,
} from '@hyperlane-xyz/cosmos-sdk';
import { ChainMap, ChainMetadataManager, ChainName } from '@hyperlane-xyz/sdk';
import { MultiVM, ProtocolType } from '@hyperlane-xyz/utils';

export class MultiVMProvider {
  private readonly metadataManager: ChainMetadataManager;

  constructor(metadataManager: ChainMetadataManager) {
    this.metadataManager = metadataManager;
  }

  public async get(chain: ChainName): Promise<MultiVM.IMultiVMProvider> {
    const metadata = this.metadataManager.getChainMetadata(chain);

    switch (metadata.protocol) {
      case ProtocolType.CosmosNative: {
        return CosmosNativeProviderFactory.connect(metadata.rpcUrls[0].http);
      }
      default: {
        throw new Error(
          `Chain ${chain} with protocol type ${metadata.protocol} not supported in MultiVM`,
        );
      }
    }
  }
}

export class MultiVmSigner {
  private readonly chains: ChainMap<MultiVM.IMultiVMSigner>;

  private constructor(chains: ChainMap<MultiVM.IMultiVMSigner>) {
    this.chains = chains;
  }

  public has(chain: ChainName): boolean {
    return !!this.chains[chain];
  }

  public get(chain: ChainName): MultiVM.IMultiVMSigner {
    return this.chains[chain];
  }

  public static async createSigners(
    metadataManager: ChainMetadataManager,
    chains: ChainName[],
    privateKey: string,
    extraParams?: Record<string, any>,
  ) {
    const signers: ChainMap<MultiVM.IMultiVMSigner> = {};

    for (const chain of chains) {
      const metadata = metadataManager.getChainMetadata(chain);

      switch (metadata.protocol) {
        case ProtocolType.CosmosNative: {
          signers[chain] = await CosmosNativeSignerFactory.connectWithSigner(
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

    return new MultiVmSigner(signers);
  }
}
