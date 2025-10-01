import {
  CosmosNativeProvider,
  CosmosNativeSigner,
} from '@hyperlane-xyz/cosmos-sdk';
import {
  ChainMap,
  ChainMetadataManager,
  ProtocolMap,
} from '@hyperlane-xyz/sdk';
import { MultiVM, ProtocolType } from '@hyperlane-xyz/utils';

// ADD NEW PROTOCOL HERE
const MULTI_VM_SUPPORTED_PROTOCOLS = [ProtocolType.CosmosNative];

export class MultiVMProviderFactory implements MultiVM.IMultiVMProviderFactory {
  private readonly metadataManager: ChainMetadataManager;

  constructor(metadataManager: ChainMetadataManager) {
    this.metadataManager = metadataManager;
  }

  public static supports(protocol: ProtocolType) {
    return MULTI_VM_SUPPORTED_PROTOCOLS.includes(protocol);
  }

  public async get(chain: string): Promise<MultiVM.IMultiVMProvider> {
    const metadata = this.metadataManager.getChainMetadata(chain);

    switch (metadata.protocol) {
      // ADD NEW PROTOCOL HERE
      case ProtocolType.CosmosNative: {
        return CosmosNativeProvider.connect(metadata.rpcUrls[0].http);
      }
      default: {
        throw new Error(
          `Chain ${chain} with protocol type ${metadata.protocol} not supported in MultiVM`,
        );
      }
    }
  }
}

export class MultiVmSignerFactory implements MultiVM.IMultiVMSignerFactory {
  private readonly metadataManager: ChainMetadataManager;
  private readonly chains: ChainMap<MultiVM.IMultiVMSigner>;

  private constructor(
    metadataManager: ChainMetadataManager,
    chains: ChainMap<MultiVM.IMultiVMSigner>,
  ) {
    this.metadataManager = metadataManager;
    this.chains = chains;
  }

  public static supports(protocol: ProtocolType) {
    return MULTI_VM_SUPPORTED_PROTOCOLS.includes(protocol);
  }

  public get(chain: string): MultiVM.IMultiVMSigner {
    const protocol = this.metadataManager.getProtocol(chain);

    if (!MultiVmSignerFactory.supports(protocol)) {
      throw new Error(
        `Chain ${chain} with protocol type ${protocol} not supported in MultiVM`,
      );
    }

    if (!this.chains[chain]) {
      throw new Error(`MultiVM was not initialized with chain ${chain}`);
    }

    return this.chains[chain];
  }

  public static async createSigners(
    metadataManager: ChainMetadataManager,
    chains: string[],
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

      if (metadata.protocol === ProtocolType.Ethereum) {
        continue;
      }

      // TODO: MULTIVM
      // make this cleaner and get from env variables and strategy config
      if (!key[metadata.protocol]) {
        throw new Error(
          `No private key provided for protocol ${metadata.protocol}`,
        );
      }

      switch (metadata.protocol) {
        // ADD NEW PROTOCOL HERE
        case ProtocolType.CosmosNative: {
          signers[chain] = await CosmosNativeSigner.connectWithSigner(
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

    return new MultiVmSignerFactory(metadataManager, signers);
  }
}
