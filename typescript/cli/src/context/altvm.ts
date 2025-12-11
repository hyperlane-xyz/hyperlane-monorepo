import { password } from '@inquirer/prompts';

import {
  AltVM,
  ProtocolType,
  getProtocolProvider,
  hasProtocol,
} from '@hyperlane-xyz/provider-sdk';
import { AnnotatedTx, TxReceipt } from '@hyperlane-xyz/provider-sdk/module';
import {
  ChainMap,
  ChainMetadataManager,
  TxSubmitterType,
} from '@hyperlane-xyz/sdk';

import { ExtendedChainSubmissionStrategy } from '../submitters/types.js';

import { SignerKeyProtocolMap } from './types.js';

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

export async function createAltVMSigners(
  metadataManager: ChainMetadataManager,
  chains: string[],
  keyByProtocol: SignerKeyProtocolMap,
  strategyConfig: Partial<ExtendedChainSubmissionStrategy>,
) {
  const signers: ChainMap<AltVM.ISigner<AnnotatedTx, TxReceipt>> = {};
  for (const chain of chains) {
    const metadata = metadataManager.getChainMetadata(chain);

    if (!hasProtocol(metadata.protocol)) {
      continue;
    }

    const signerConfig = {
      privateKey: await loadPrivateKey(
        keyByProtocol,
        strategyConfig,
        metadata.protocol,
        chain,
      ),
    };

    signers[chain] = await getProtocolProvider(metadata.protocol).createSigner(
      metadata,
      signerConfig,
    );
  }

  return signers;
}
