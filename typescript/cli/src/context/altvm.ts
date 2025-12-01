import { password } from '@inquirer/prompts';

import {
  CosmosNativeProvider,
  CosmosNativeSigner,
} from '@hyperlane-xyz/cosmos-sdk';
import {
  AltVM,
  type MinimumRequiredGasByAction,
  getProtocolProvider,
  hasProtocol,
  listProtocols,
} from '@hyperlane-xyz/provider-sdk';
import { ProtocolType } from '@hyperlane-xyz/provider-sdk';
import { AnnotatedTx, TxReceipt } from '@hyperlane-xyz/provider-sdk/module';
import { RadixProvider, RadixSigner } from '@hyperlane-xyz/radix-sdk';
import {
  AltVMJsonRpcTxSubmitter,
  ChainMap,
  ChainMetadataManager,
  MultiProvider,
  ProtocolMap,
  SubmitterFactory,
  SubmitterMetadata,
  TxSubmitterType,
} from '@hyperlane-xyz/sdk';
import { assert } from '@hyperlane-xyz/utils';

import { AltVMFileSubmitter } from '../submitters/AltVMFileSubmitter.js';
import {
  CustomTxSubmitterType,
  ExtendedChainSubmissionStrategy,
} from '../submitters/types.js';

import { SignerKeyProtocolMap } from './types.js';

// ### ALL Alt VM PROTOCOLS ARE REGISTERED HERE ###
const ALT_VM_SUPPORTED_PROTOCOLS: AltVMProtocol = {
  [ProtocolType.CosmosNative]: {
    provider: CosmosNativeProvider,
    signer: CosmosNativeSigner,
    gas: {
      CORE_DEPLOY_GAS: BigInt(1e6),
      WARP_DEPLOY_GAS: BigInt(3e6),
      TEST_SEND_GAS: BigInt(3e5),
      AVS_GAS: BigInt(3e6),
    },
  },
  [ProtocolType.Radix]: {
    provider: RadixProvider,
    signer: RadixSigner,
  },
  // [NEW PROTOCOL]: {...}
};

type AltVMProtocol = ProtocolMap<{
  provider: AltVM.IProviderConnect;
  signer: AltVM.ISignerConnect<AnnotatedTx, TxReceipt>;
  gas?: MinimumRequiredGasByAction;
}>;

class AltVMSupportedProtocols implements AltVM.ISupportedProtocols {
  public getSupportedProtocols(): ProtocolType[] {
    return Object.keys(ALT_VM_SUPPORTED_PROTOCOLS) as ProtocolType[];
  }

  public supports(protocol: ProtocolType) {
    return !!ALT_VM_SUPPORTED_PROTOCOLS[protocol];
  }

  public getMinGas(protocol: ProtocolType) {
    const protocolDefinition = ALT_VM_SUPPORTED_PROTOCOLS[protocol];

    if (!protocolDefinition) {
      throw new Error(`Protocol type ${protocol} not supported in AltVM`);
    }

    if (!protocolDefinition.gas) {
      return {
        CORE_DEPLOY_GAS: BigInt(0),
        WARP_DEPLOY_GAS: BigInt(0),
        TEST_SEND_GAS: BigInt(0),
        AVS_GAS: BigInt(0),
      };
    }

    return protocolDefinition.gas;
  }
}

export class AltVMSignerFactory
  extends AltVMSupportedProtocols
  implements AltVM.ISignerFactory<AnnotatedTx, TxReceipt>
{
  private readonly metadataManager: ChainMetadataManager;
  private readonly chains: ChainMap<AltVM.ISigner<AnnotatedTx, TxReceipt>>;

  private constructor(
    metadataManager: ChainMetadataManager,
    chains: ChainMap<AltVM.ISigner<AnnotatedTx, TxReceipt>>,
  ) {
    super();

    this.metadataManager = metadataManager;
    this.chains = chains;
  }

  public get(chain: string): AltVM.ISigner<AnnotatedTx, TxReceipt> {
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
    keyByProtocol: SignerKeyProtocolMap,
    strategyConfig: Partial<ExtendedChainSubmissionStrategy>,
    protocol: ProtocolType,
    chain: string,
  ): Promise<string> {
    // 1. First try to get private key from --key.{protocol} flag
    if (keyByProtocol[protocol]) {
      return keyByProtocol[protocol]!;
    }

    // 2. If no key flag was provided we check if a strategy config
    // was provided for our chain where we can read our private key
    if (strategyConfig[chain]) {
      const rawConfig = strategyConfig[chain]!.submitter;

      if (rawConfig.type === TxSubmitterType.JSON_RPC) {
        if (!rawConfig.privateKey) {
          throw new Error(
            `missing private key in strategy config for chain ${chain}`,
          );
        }

        return rawConfig.privateKey;
      }
    }

    // 3. Finally, if no key flag or strategy was provided we prompt the user
    // for the private key. We save it in the keyByProtocol map so that we can
    // reuse it if another chain is of the same protocol
    keyByProtocol[protocol] = await password({
      message: `Please enter the private key for chain ${chain} (will be re-used for other chains with the same protocol type)`,
    });

    return keyByProtocol[protocol]!;
  }

  public static async createSigners(
    metadataManager: ChainMetadataManager,
    chains: string[],
    keyByProtocol: SignerKeyProtocolMap,
    strategyConfig: Partial<ExtendedChainSubmissionStrategy>,
  ) {
    const signers: Map<
      string,
      AltVM.ISigner<AnnotatedTx, TxReceipt>
    > = new Map();
    for (const chain of chains) {
      const metadata = metadataManager.getChainMetadata(chain);

      if (!hasProtocol(metadata.protocol)) {
        continue;
      }

      const jsonSubmitterConfig = {
        privateKey: await AltVMSignerFactory.loadPrivateKey(
          keyByProtocol,
          strategyConfig,
          metadata.protocol,
          chain,
        ),
      };

      signers.set(
        metadata.protocol,
        await getProtocolProvider(metadata.protocol).createSigner(
          metadata,
          jsonSubmitterConfig,
        ),
      );
    }

    return signers;
  }

  public static submitterFactories(
    metadataManager: ChainMetadataManager,
    altVmSigner: Map<string, AltVM.ISigner<AnnotatedTx, TxReceipt>>,
    chain: string,
  ): ProtocolMap<Record<string, SubmitterFactory>> {
    const protocol = metadataManager.getProtocol(chain);

    const factories: ProtocolMap<Record<string, SubmitterFactory>> = {};

    if (!ALT_VM_SUPPORTED_PROTOCOLS[protocol]) {
      return factories;
    }

    const signer = altVmSigner.get(protocol);
    assert(
      signer,
      `Cannot find signer for protocol ${protocol} for chain ${chain}`,
    );
    for (const protocol of listProtocols()) {
      factories[protocol] = {
        [TxSubmitterType.JSON_RPC]: (
          _multiProvider: MultiProvider,
          metadata: SubmitterMetadata,
        ) => {
          // Used to type narrow metadata
          assert(
            metadata.type === TxSubmitterType.JSON_RPC,
            `Invalid metadata type: ${metadata.type}, expected ${TxSubmitterType.JSON_RPC}`,
          );
          return new AltVMJsonRpcTxSubmitter(signer, metadata);
        },
        [CustomTxSubmitterType.FILE]: (
          _multiProvider: MultiProvider,
          metadata: any,
        ) => {
          return new AltVMFileSubmitter(signer, metadata);
        },
      };
    }

    return factories;
  }
}
