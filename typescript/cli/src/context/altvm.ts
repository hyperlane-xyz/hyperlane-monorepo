import { input, password } from '@inquirer/prompts';

import {
  type AltVM,
  type ChainMetadataForAltVM,
  type ProtocolProvider,
  getProtocolProvider,
  hasProtocol,
} from '@hyperlane-xyz/provider-sdk';
import {
  type AnnotatedTx,
  type TxReceipt,
} from '@hyperlane-xyz/provider-sdk/module';
import { assert, ProtocolType } from '@hyperlane-xyz/utils';
import { SealevelSigner } from '@hyperlane-xyz/sealevel-sdk';

import { type ExtendedChainSubmissionStrategy } from '../submitters/types.js';

import {
  JSON_RPC_SUBMITTER_TYPE,
  resolveAltVmAccountAddress,
} from './altvm-signer-config.js';
import { type SignerKeyProtocolMap } from './types.js';
import { HttpRemoteKitSigner } from './strategies/signer/HttpRemoteKitSigner.js';
import { HttpSignerClient } from './strategies/signer/HttpSignerClient.js';
import {
  parseSignerSource,
  SignerSourceType,
} from './strategies/signer/signerSource.js';

export const altVmPrompts = {
  input,
  password,
};

type ChainMetadataManagerLike = {
  getChainMetadata: (chain: string) => ChainMetadataForAltVM;
};

type ChainMap<T> = Record<string, T>;

async function loadPrivateKey(
  keyByProtocol: SignerKeyProtocolMap,
  promptedKeyByProtocol: Partial<Record<ProtocolType, string>>,
  strategyConfig: Partial<ExtendedChainSubmissionStrategy>,
  protocol: ProtocolType,
  chain: string,
): Promise<string> {
  // 1. A strategy's explicit private key remains chain-specific and wins.
  let strategyRequiresKey = false;
  if (strategyConfig[chain]) {
    const rawConfig = strategyConfig[chain]!.submitter;

    if (rawConfig.type === JSON_RPC_SUBMITTER_TYPE) {
      if (rawConfig.privateKey) {
        return rawConfig.privateKey;
      }
      strategyRequiresKey = protocol !== ProtocolType.Starknet;
    } else {
      throw new Error(
        `unsupported submitter type in strategy config for chain ${chain}: ${rawConfig.type}`,
      );
    }
  }

  // 2. Try the protocol key from --key.{protocol}.
  const explicitKey = keyByProtocol[protocol];
  if (explicitKey) {
    return explicitKey;
  }

  if (strategyRequiresKey) {
    throw new Error(
      `missing private key in strategy config for chain ${chain}`,
    );
  }

  // 3. Finally, if no key flag or strategy was provided we prompt the user.
  // Cache prompted values locally so explicit per-chain strategy keys still win.
  const promptedKey = promptedKeyByProtocol[protocol];
  if (promptedKey) {
    return promptedKey;
  }

  const fallbackKey = await altVmPrompts.password({
    message: `Please enter the private key for chain ${chain} (will be re-used for other chains with the same protocol type)`,
  });
  promptedKeyByProtocol[protocol] = fallbackKey;
  return fallbackKey;
}

async function loadAccountAddress(
  strategyConfig: Partial<ExtendedChainSubmissionStrategy>,
  protocol: ProtocolType,
  chain: string,
): Promise<string | undefined> {
  if (protocol !== ProtocolType.Starknet) {
    return undefined;
  }

  const resolved = resolveAltVmAccountAddress(strategyConfig, protocol, chain);
  if (resolved) return resolved;

  const promptedAddress = await altVmPrompts.input({
    message: `Please enter the Starknet account contract address for chain ${chain}`,
  });
  const accountAddress = promptedAddress.trim();
  assert(
    accountAddress,
    `Missing Starknet account contract address for chain ${chain}`,
  );
  return accountAddress;
}

type AltVmProtocolRegistry = {
  getProtocolProvider: (
    protocol: ProtocolType,
  ) => Pick<ProtocolProvider, 'createSigner'>;
  hasProtocol: (protocol: ProtocolType) => boolean;
};

export async function createAltVMSigners(
  metadataManager: ChainMetadataManagerLike,
  chains: string[],
  keyByProtocol: SignerKeyProtocolMap,
  strategyConfig: Partial<ExtendedChainSubmissionStrategy>,
  protocolRegistry: AltVmProtocolRegistry = {
    getProtocolProvider,
    hasProtocol,
  },
) {
  const signers: ChainMap<AltVM.ISigner<AnnotatedTx, TxReceipt>> = {};
  const promptedKeyByProtocol: Partial<Record<ProtocolType, string>> = {};
  const httpClients = new Map<string, HttpSignerClient>();

  for (const chain of chains) {
    const metadata = metadataManager.getChainMetadata(chain);

    if (!protocolRegistry.hasProtocol(metadata.protocol)) {
      continue;
    }

    const accountAddress = await loadAccountAddress(
      strategyConfig,
      metadata.protocol,
      chain,
    );
    const key = await loadPrivateKey(
      keyByProtocol,
      promptedKeyByProtocol,
      strategyConfig,
      metadata.protocol,
      chain,
    );

    const source = parseSignerSource(key);
    switch (source.type) {
      case SignerSourceType.HTTP: {
        assert(
          metadata.protocol === ProtocolType.Sealevel,
          `HTTP signing is not supported for ${metadata.protocol} chains`,
        );
        const cacheKey = source.url.href;
        const client =
          httpClients.get(cacheKey) ?? new HttpSignerClient(source.url);
        httpClients.set(cacheKey, client);
        const remoteSigner = await HttpRemoteKitSigner.create(chain, client);
        signers[chain] = await SealevelSigner.connectWithSigner(
          metadata,
          remoteSigner,
        );
        break;
      }
      case SignerSourceType.PRIVATE_KEY:
        signers[chain] = await protocolRegistry
          .getProtocolProvider(metadata.protocol)
          .createSigner(metadata, {
            privateKey: source.privateKey,
            accountAddress,
          });
        break;
      default: {
        const _exhaustive: never = source;
        throw new Error(`Unhandled signer source: ${String(_exhaustive)}`);
      }
    }
  }

  return signers;
}
