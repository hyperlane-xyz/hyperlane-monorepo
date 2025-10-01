import {
  CosmosNativeProviderFactory,
  CosmosNativeSignerFactory,
} from '@hyperlane-xyz/cosmos-sdk';
import {
  ChainMap,
  ChainMetadataManager,
  ChainName,
  ProtocolMap,
} from '@hyperlane-xyz/sdk';
import { MultiVM, ProtocolType } from '@hyperlane-xyz/utils';

// ADD NEW PROTOCOL HERE
const MULTI_VM_SUPPORTED_PROTOCOLS = [ProtocolType.CosmosNative];

export class MultiVMProvider {
  private readonly metadataManager: ChainMetadataManager;

  constructor(metadataManager: ChainMetadataManager) {
    this.metadataManager = metadataManager;
  }

  public static supports(protocol: ProtocolType) {
    return MULTI_VM_SUPPORTED_PROTOCOLS.includes(protocol);
  }

  public async get(chain: ChainName): Promise<MultiVM.IMultiVMProvider> {
    const metadata = this.metadataManager.getChainMetadata(chain);

    switch (metadata.protocol) {
      // ADD NEW PROTOCOL HERE
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

  public static supports(protocol: ProtocolType) {
    return MULTI_VM_SUPPORTED_PROTOCOLS.includes(protocol);
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
    key: ProtocolMap<string> | string,
  ) {
    const signers: ChainMap<MultiVM.IMultiVMSigner> = {};

    if (typeof key === 'string') {
      throw new Error(
        `The private key has to be provided with the protocol type: --key.{protocol}`,
      );
    }

    for (const chain of chains) {
      const metadata = metadataManager.getChainMetadata(chain);

      if (!key[metadata.protocol]) {
        throw new Error(
          `No private key provided for protocol ${metadata.protocol}`,
        );
      }

      switch (metadata.protocol) {
        // ADD NEW PROTOCOL HERE
        case ProtocolType.CosmosNative: {
          signers[chain] = await CosmosNativeSignerFactory.connectWithSigner(
            metadata.rpcUrls[0].http,
            key[metadata.protocol]!,
            {
              bech32Prefix: metadata.bech32Prefix,
              gasPrice: `${metadata.gasPrice?.amount ?? '0'}${metadata.gasPrice?.denom ?? ''}`,
            },
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
