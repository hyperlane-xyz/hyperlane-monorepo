import {
  CosmosNativeProvider,
  CosmosNativeSigner,
} from '@hyperlane-xyz/cosmos-sdk';
import {
  ChainMap,
  ChainMetadataManager,
  ProtocolMap,
} from '@hyperlane-xyz/sdk';
import { MINIMUM_GAS, MultiVM, ProtocolType } from '@hyperlane-xyz/utils';

// ### ADD NEW PROTOCOLS HERE ###
const MULTI_VM_SUPPORTED_PROTOCOLS: SUPPORTED_PROTOCOL = {
  [ProtocolType.CosmosNative]: {
    provider: CosmosNativeProvider,
    signer: CosmosNativeSigner,
    gas: {
      CORE_DEPLOY_GAS: (1e6).toString(),
      WARP_DEPLOY_GAS: (3e6).toString(),
      TEST_SEND_GAS: (3e5).toString(),
      AVS_GAS: (3e6).toString(),
    },
  },
};

type SUPPORTED_PROTOCOL = ProtocolMap<{
  provider: MultiVM.IProviderConnect;
  signer: MultiVM.ISignerConnect;
  gas: MINIMUM_GAS;
}>;

export class MultiVMProviderFactory implements MultiVM.IProviderFactory {
  private readonly metadataManager: ChainMetadataManager;

  constructor(metadataManager: ChainMetadataManager) {
    this.metadataManager = metadataManager;
  }

  public getSupportedProtocols(): ProtocolType[] {
    return Object.keys(MULTI_VM_SUPPORTED_PROTOCOLS) as ProtocolType[];
  }

  public supports(protocol: ProtocolType) {
    return !!MULTI_VM_SUPPORTED_PROTOCOLS[protocol];
  }

  public getGas(protocol: ProtocolType) {
    if (!this.supports(protocol)) {
      throw new Error(`Protocol type ${protocol} not supported in MultiVM`);
    }

    const { gas } = MULTI_VM_SUPPORTED_PROTOCOLS[protocol]!;
    return gas;
  }

  public async get(chain: string): Promise<MultiVM.IProvider> {
    const metadata = this.metadataManager.getChainMetadata(chain);

    if (!this.supports(metadata.protocol)) {
      throw new Error(
        `Chain ${chain} with protocol type ${metadata.protocol} not supported in MultiVM`,
      );
    }

    const { provider } = MULTI_VM_SUPPORTED_PROTOCOLS[metadata.protocol]!;
    return provider.connect(metadata.rpcUrls[0].http);
  }
}

export class MultiVmSignerFactory implements MultiVM.ISignerFactory {
  private readonly metadataManager: ChainMetadataManager;
  private readonly chains: ChainMap<MultiVM.ISigner>;

  private constructor(
    metadataManager: ChainMetadataManager,
    chains: ChainMap<MultiVM.ISigner>,
  ) {
    this.metadataManager = metadataManager;
    this.chains = chains;
  }

  public getSupportedProtocols(): ProtocolType[] {
    return Object.keys(MULTI_VM_SUPPORTED_PROTOCOLS) as ProtocolType[];
  }

  public supports(protocol: ProtocolType) {
    return !!MULTI_VM_SUPPORTED_PROTOCOLS[protocol];
  }

  public getGas(protocol: ProtocolType) {
    if (!this.supports(protocol)) {
      throw new Error(`Protocol type ${protocol} not supported in MultiVM`);
    }

    const { gas } = MULTI_VM_SUPPORTED_PROTOCOLS[protocol]!;
    return gas;
  }

  public get(chain: string): MultiVM.ISigner {
    const protocol = this.metadataManager.getProtocol(chain);

    if (!this.supports(protocol)) {
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
    const signers: ChainMap<MultiVM.ISigner> = {};

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

      const protocol = MULTI_VM_SUPPORTED_PROTOCOLS[metadata.protocol];

      if (!protocol) {
        throw new Error(
          `Chain ${chain} with protocol type ${metadata.protocol} not supported in MultiVM`,
        );
      }

      signers[chain] = await protocol.signer.connectWithSigner(
        metadata.rpcUrls[0].http,
        key[metadata.protocol]!,
        {
          bech32Prefix: metadata.bech32Prefix,
          gasPrice: `${metadata.gasPrice?.amount ?? '0'}${metadata.gasPrice?.denom ?? ''}`,
        },
      );
    }

    return new MultiVmSignerFactory(metadataManager, signers);
  }
}
