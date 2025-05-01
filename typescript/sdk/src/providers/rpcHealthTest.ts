import { Mailbox__factory } from '@hyperlane-xyz/core';
import { Address, rootLogger } from '@hyperlane-xyz/utils';

import { ChainMetadata } from '../metadata/chainMetadataTypes.js';

import {
  CosmJsNativeProvider,
  CosmJsProvider,
  CosmJsWasmProvider,
  EthersV5Provider,
  ProviderType,
  SolanaWeb3Provider,
} from './ProviderType.js';
import { protocolToDefaultProviderBuilder } from './providerBuilders.js';

export async function isRpcHealthy(
  metadata: ChainMetadata,
  rpcIndex: number,
): Promise<boolean> {
  const rpc = metadata.rpcUrls[rpcIndex];
  const builder = protocolToDefaultProviderBuilder[metadata.protocol];
  const provider = builder([rpc], metadata.chainId);
  if (provider.type === ProviderType.EthersV5)
    return isEthersV5ProviderHealthy(provider.provider, metadata);
  else if (provider.type === ProviderType.SolanaWeb3)
    return isSolanaWeb3ProviderHealthy(provider.provider, metadata);
  else if (
    provider.type === ProviderType.CosmJsWasm ||
    provider.type === ProviderType.CosmJs ||
    provider.type === ProviderType.CosmJsNative
  )
    return isCosmJsProviderHealthy(provider.provider, metadata);
  else
    throw new Error(
      `Unsupported provider type ${provider.type}, new health check required`,
    );
}

export async function isEthersV5ProviderHealthy(
  provider: EthersV5Provider['provider'],
  metadata: ChainMetadata,
  mailboxAddress?: Address,
): Promise<boolean> {
  const chainName = metadata.name;
  const blockNumber = await provider.getBlockNumber();
  if (!blockNumber || blockNumber < 0) return false;
  rootLogger.debug(`Block number is okay for ${chainName}`);

  if (mailboxAddress) {
    const mailbox = Mailbox__factory.createInterface();
    const topics = mailbox.encodeFilterTopics(
      mailbox.events['DispatchId(bytes32)'],
      [],
    );
    rootLogger.debug(`Checking mailbox logs for ${chainName}`);
    const mailboxLogs = await provider.getLogs({
      address: mailboxAddress,
      topics,
      fromBlock: blockNumber - 99,
      toBlock: blockNumber,
    });
    if (!mailboxLogs) return false;
    rootLogger.debug(`Mailbox logs okay for ${chainName}`);
  }
  return true;
}

export async function isSolanaWeb3ProviderHealthy(
  provider: SolanaWeb3Provider['provider'],
  metadata: ChainMetadata,
): Promise<boolean> {
  const blockNumber = await provider.getBlockHeight();
  if (!blockNumber || blockNumber < 0) return false;
  rootLogger.debug(`Block number is okay for ${metadata.name}`);
  return true;
}

export async function isCosmJsProviderHealthy(
  provider:
    | CosmJsProvider['provider']
    | CosmJsWasmProvider['provider']
    | CosmJsNativeProvider['provider'],
  metadata: ChainMetadata,
): Promise<boolean> {
  const readyProvider = await provider;
  const blockNumber = await readyProvider.getHeight();
  if (!blockNumber || blockNumber < 0) return false;
  rootLogger.debug(`Block number is okay for ${metadata.name}`);
  return true;
}
