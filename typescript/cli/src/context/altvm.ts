import { input, password } from '@inquirer/prompts';

import {
  type AltVM,
  type ChainMetadataForAltVM,
  getProtocolProvider,
  hasProtocol,
} from '@hyperlane-xyz/provider-sdk';
import {
  type AnnotatedTx,
  type TxReceipt,
} from '@hyperlane-xyz/provider-sdk/module';
import { ProtocolType } from '@hyperlane-xyz/utils';

import { type ExtendedChainSubmissionStrategy } from '../submitters/types.js';

import { resolveAltVmAccountAddress } from './altvm-signer-config.js';
import { type SignerKeyProtocolMap } from './types.js';

type ChainMetadataManagerLike = {
  getChainMetadata: (chain: string) => ChainMetadataForAltVM;
};

type ChainMap<T> = Record<string, T>;

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

    if (rawConfig.type === 'jsonRpc') {
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

async function loadAccountAddress(
  strategyConfig: Partial<ExtendedChainSubmissionStrategy>,
  protocol: ProtocolType,
  chain: string,
  fallbackPromptedAddress?: string,
): Promise<{ accountAddress?: string; isPrompted: boolean }> {
  if (protocol !== ProtocolType.Starknet) {
    return { accountAddress: undefined, isPrompted: false };
  }

  const resolved = resolveAltVmAccountAddress(strategyConfig, protocol, chain);
  if (resolved) return { accountAddress: resolved, isPrompted: false };

  if (fallbackPromptedAddress) {
    return { accountAddress: fallbackPromptedAddress, isPrompted: false };
  }

  const promptedAddress = await input({
    message: `Please enter the Starknet account contract address for chain ${chain}`,
  });
  return { accountAddress: promptedAddress, isPrompted: true };
}

export async function createAltVMSigners(
  metadataManager: ChainMetadataManagerLike,
  chains: string[],
  keyByProtocol: SignerKeyProtocolMap,
  strategyConfig: Partial<ExtendedChainSubmissionStrategy>,
) {
  const signers: ChainMap<AltVM.ISigner<AnnotatedTx, TxReceipt>> = {};
  const promptedAccountAddressByProtocol: Partial<
    Record<ProtocolType, string>
  > = {};

  for (const chain of chains) {
    const metadata = metadataManager.getChainMetadata(chain);

    if (!hasProtocol(metadata.protocol)) {
      continue;
    }

    const { accountAddress, isPrompted } = await loadAccountAddress(
      strategyConfig,
      metadata.protocol,
      chain,
      promptedAccountAddressByProtocol[metadata.protocol],
    );
    const signerConfig = {
      privateKey: await loadPrivateKey(
        keyByProtocol,
        strategyConfig,
        metadata.protocol,
        chain,
      ),
      accountAddress,
    };

    if (isPrompted && signerConfig.accountAddress) {
      promptedAccountAddressByProtocol[metadata.protocol] =
        signerConfig.accountAddress;
    }

    signers[chain] = await getProtocolProvider(metadata.protocol).createSigner(
      metadata,
      signerConfig,
    );
  }

  return signers;
}
