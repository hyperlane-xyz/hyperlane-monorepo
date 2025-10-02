import {
  CosmosNativeProvider,
  CosmosNativeSigner,
} from '@hyperlane-xyz/cosmos-sdk';
import {
  ChainMap,
  ChainMetadataManager,
  ProtocolMap,
  isJsonRpcSubmitterConfig,
} from '@hyperlane-xyz/sdk';
import { AltVM, MINIMUM_GAS, ProtocolType } from '@hyperlane-xyz/utils';

import { ExtendedChainSubmissionStrategy } from '../submitters/types.js';

import { SignerKeyProtocolMap } from './types.js';

// ### ALL Alt VM PROTOCOLS ARE REGISTERED HERE ###
const ALT_VM_SUPPORTED_PROTOCOLS: ALT_VM_PROTOCOL = {
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
  // [NEW PROTOCOL]: {...}
};

type ALT_VM_PROTOCOL = ProtocolMap<{
  provider: AltVM.IProviderConnect;
  signer: AltVM.ISignerConnect;
  gas: MINIMUM_GAS;
}>;

export class AltVMProviderFactory implements AltVM.IProviderFactory {
  private readonly metadataManager: ChainMetadataManager;

  constructor(metadataManager: ChainMetadataManager) {
    this.metadataManager = metadataManager;
  }

  public getSupportedProtocols(): ProtocolType[] {
    return Object.keys(ALT_VM_SUPPORTED_PROTOCOLS) as ProtocolType[];
  }

  public supports(protocol: ProtocolType) {
    return !!ALT_VM_SUPPORTED_PROTOCOLS[protocol];
  }

  public getGas(protocol: ProtocolType) {
    if (!this.supports(protocol)) {
      throw new Error(`Protocol type ${protocol} not supported in AltVM`);
    }

    const { gas } = ALT_VM_SUPPORTED_PROTOCOLS[protocol]!;
    return gas;
  }

  public async get(chain: string): Promise<AltVM.IProvider> {
    const metadata = this.metadataManager.getChainMetadata(chain);

    if (!this.supports(metadata.protocol)) {
      throw new Error(
        `Chain ${chain} with protocol type ${metadata.protocol} not supported in AltVM`,
      );
    }

    const { provider } = ALT_VM_SUPPORTED_PROTOCOLS[metadata.protocol]!;
    return provider.connect(metadata.rpcUrls[0].http);
  }
}

export class AltVMSignerFactory implements AltVM.ISignerFactory {
  private readonly metadataManager: ChainMetadataManager;
  private readonly chains: ChainMap<AltVM.ISigner>;

  private constructor(
    metadataManager: ChainMetadataManager,
    chains: ChainMap<AltVM.ISigner>,
  ) {
    this.metadataManager = metadataManager;
    this.chains = chains;
  }

  public getSupportedProtocols(): ProtocolType[] {
    return Object.keys(ALT_VM_SUPPORTED_PROTOCOLS) as ProtocolType[];
  }

  public supports(protocol: ProtocolType) {
    return !!ALT_VM_SUPPORTED_PROTOCOLS[protocol];
  }

  public getGas(protocol: ProtocolType) {
    if (!this.supports(protocol)) {
      throw new Error(`Protocol type ${protocol} not supported in AltVM`);
    }

    const { gas } = ALT_VM_SUPPORTED_PROTOCOLS[protocol]!;
    return gas;
  }

  public get(chain: string): AltVM.ISigner {
    const protocol = this.metadataManager.getProtocol(chain);

    if (!this.supports(protocol)) {
      throw new Error(
        `Chain ${chain} with protocol type ${protocol} not supported in AltVM`,
      );
    }

    if (!this.chains[chain]) {
      throw new Error(`AltVM was not initialized with chain ${chain}`);
    }

    return this.chains[chain];
  }

  private static async loadPrivateKey(
    key: SignerKeyProtocolMap,
    strategyConfig: Partial<ExtendedChainSubmissionStrategy>,
    protocol: ProtocolType,
    chain: string,
  ): Promise<string> {
    if (key[protocol]) {
      return key[protocol]!;
    }

    if (!strategyConfig[chain]) {
      throw new Error(`found no strategy in config for chain ${chain}`);
    }

    const rawConfig = strategyConfig[chain]!.submitter;
    if (!isJsonRpcSubmitterConfig(rawConfig)) {
      throw new Error(
        `found unknown submitter in strategy config for chain ${chain}`,
      );
    }

    if (!rawConfig.privateKey) {
      throw new Error(
        `missing private key in strategy config for chain ${chain}`,
      );
    }

    return rawConfig.privateKey;
  }

  public static async createSigners(
    metadataManager: ChainMetadataManager,
    chains: string[],
    key: SignerKeyProtocolMap,
    strategyConfig: Partial<ExtendedChainSubmissionStrategy>,
  ) {
    const signers: ChainMap<AltVM.ISigner> = {};

    for (const chain of chains) {
      const metadata = metadataManager.getChainMetadata(chain);

      if (metadata.protocol === ProtocolType.Ethereum) {
        continue;
      }

      const protocol = ALT_VM_SUPPORTED_PROTOCOLS[metadata.protocol];

      if (!protocol) {
        throw new Error(
          `Chain ${chain} with protocol type ${metadata.protocol} not supported in AltVM`,
        );
      }

      const privateKey = await AltVMSignerFactory.loadPrivateKey(
        key,
        strategyConfig,
        metadata.protocol,
        chain,
      );

      signers[chain] = await protocol.signer.connectWithSigner(
        metadata.rpcUrls[0].http,
        privateKey,
        {
          bech32Prefix: metadata.bech32Prefix,
          gasPrice: `${metadata.gasPrice?.amount ?? '0'}${metadata.gasPrice?.denom ?? ''}`,
        },
      );
    }

    return new AltVMSignerFactory(metadataManager, signers);
  }
}
