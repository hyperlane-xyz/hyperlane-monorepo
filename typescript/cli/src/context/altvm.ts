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
} from '@hyperlane-xyz/provider-sdk';
import { ProtocolType } from '@hyperlane-xyz/provider-sdk';
import { AnnotatedTx, TxReceipt } from '@hyperlane-xyz/provider-sdk/module';
import { RadixProvider, RadixSigner } from '@hyperlane-xyz/radix-sdk';
import {
  AltVMJsonRpcTxSubmitter,
  ChainMap,
  ChainMetadataManager,
  ChainName,
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

export type AltVMProviderGetter = (
  chain: ChainName,
) => Promise<AltVM.IProvider>;

export type AltVMSignerGetter = (
  chain: ChainName,
) => Promise<AltVM.ISigner<AnnotatedTx, TxReceipt>>;

export async function mustGetAltVmProvider(
  getter: AltVMProviderGetter | undefined,
  chain: ChainName,
) {
  assert(
    getter,
    `AltVM provider getter is not available for chain ${chain}. Was signerMiddleware run?`,
  );
  return getter(chain);
}

export async function mustGetAltVmSigner(
  getter: AltVMSignerGetter | undefined,
  chain: ChainName,
) {
  assert(
    getter,
    `AltVM signer getter is not available for chain ${chain}. Was signerMiddleware run?`,
  );
  return getter(chain);
}

export function createAltVMProviderGetter(
  metadataManager: ChainMetadataManager,
): AltVMProviderGetter {
  const providers: ChainMap<AltVM.IProvider> = {};

  return async (chain: ChainName) => {
    if (providers[chain]) {
      return providers[chain]!;
    }

    const metadata = metadataManager.getChainMetadata(chain);
    const protocol = metadata.protocol;

    if (!hasProtocol(protocol)) {
      throw new Error(`Unsupported AltVM protocol for chain ${chain}`);
    }

    const provider =
      await getProtocolProvider(protocol).createProvider(metadata);
    providers[chain] = provider;
    return provider;
  };
}

async function loadPrivateKey(
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

export function createAltVMSignerGetter(
  metadataManager: ChainMetadataManager,
  keyByProtocol: SignerKeyProtocolMap,
  strategyConfig: Partial<ExtendedChainSubmissionStrategy>,
): AltVMSignerGetter {
  const signers: ChainMap<AltVM.ISigner<AnnotatedTx, TxReceipt>> = {};

  return async (chain: ChainName) => {
    if (signers[chain]) {
      return signers[chain]!;
    }

    const metadata = metadataManager.getChainMetadata(chain);
    const protocol = metadata.protocol;

    if (!hasProtocol(protocol)) {
      throw new Error(`Unsupported AltVM protocol for chain ${chain}`);
    }

    const signerConfig = {
      privateKey: await loadPrivateKey(
        keyByProtocol,
        strategyConfig,
        protocol,
        chain,
      ),
    };

    const signer = await getProtocolProvider(protocol).createSigner(
      metadata,
      signerConfig,
    );
    signers[chain] = signer;
    return signer;
  };
}

export async function createAltVMSubmitterFactories(
  metadataManager: ChainMetadataManager,
  getAltVmSigner: AltVMSignerGetter | undefined,
  chain: string,
): Promise<ProtocolMap<Record<string, SubmitterFactory>>> {
  const protocol = metadataManager.getProtocol(chain);

  const factories: ProtocolMap<Record<string, SubmitterFactory>> = {};

  if (!ALT_VM_SUPPORTED_PROTOCOLS[protocol]) {
    return factories;
  }

  const signer = await mustGetAltVmSigner(getAltVmSigner, chain);
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

  return factories;
}
