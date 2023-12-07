import { Mailbox__factory } from '@hyperlane-xyz/core';
import { Address, ProtocolType, timeout } from '@hyperlane-xyz/utils';

import { chainIdToMetadata } from '../consts/chainMetadata';
import { CoreChainName } from '../consts/chains';
import { hyperlaneContractAddresses } from '../consts/environments';
import { logger } from '../logger';
import {
  CosmJsProvider,
  CosmJsWasmProvider,
  EthersV5Provider,
  ProviderType,
  SolanaWeb3Provider,
} from '../providers/ProviderType';
import { protocolToDefaultProviderBuilder } from '../providers/providerBuilders';

import {
  getExplorerAddressUrl,
  getExplorerBaseUrl,
  getExplorerTxUrl,
} from './blockExplorer';
import { ChainMetadata, RpcUrl } from './chainMetadataTypes';

const HEALTH_CHECK_TIMEOUT = 5000; // 5s

export async function isRpcHealthy(
  rpc: RpcUrl,
  chainId: string | number,
  protocol: ProtocolType,
): Promise<boolean> {
  try {
    const builder = protocolToDefaultProviderBuilder[protocol];
    const provider = builder([rpc], chainId);
    let resultPromise;
    if (provider.type === ProviderType.EthersV5)
      resultPromise = isEthersV5ProviderHealthy(provider.provider, chainId);
    else if (provider.type === ProviderType.SolanaWeb3)
      resultPromise = isSolanaWeb3ProviderHealthy(provider.provider, chainId);
    else if (
      provider.type === ProviderType.CosmJsWasm ||
      provider.type === ProviderType.CosmJs
    )
      resultPromise = isCosmJsProviderHealthy(provider.provider, chainId);
    else
      throw new Error(
        `Unsupported provider type ${provider.type}, new health check required`,
      );
    const result = await timeout(
      resultPromise,
      HEALTH_CHECK_TIMEOUT,
      'RPC health check timed out',
    );
    return result;
  } catch (error) {
    logger(`Provider error for ${rpc.http}`, error);
    return false;
  }
}

export async function isEthersV5ProviderHealthy(
  provider: EthersV5Provider['provider'],
  chainId: string | number,
): Promise<boolean> {
  logger(`Checking ethers provider for ${chainId}`);
  const blockNumber = await provider.getBlockNumber();
  if (!blockNumber || blockNumber < 0) return false;
  logger(`Block number is okay for ${chainId}`);

  const chainName = chainIdToMetadata[chainId]?.name as CoreChainName;
  if (chainName && hyperlaneContractAddresses[chainName]) {
    const mailboxAddr = hyperlaneContractAddresses[chainName].mailbox;
    const mailbox = Mailbox__factory.createInterface();
    const topics = mailbox.encodeFilterTopics(
      mailbox.events['DispatchId(bytes32)'],
      [],
    );
    logger(`Checking mailbox logs for ${chainId}`);
    const mailboxLogs = await provider.getLogs({
      address: mailboxAddr,
      topics,
      fromBlock: blockNumber - 99,
      toBlock: blockNumber,
    });
    if (!mailboxLogs) return false;
    logger(`Mailbox logs okay for ${chainId}`);
  }
  return true;
}

export async function isSolanaWeb3ProviderHealthy(
  provider: SolanaWeb3Provider['provider'],
  chainId: string | number,
): Promise<boolean> {
  logger(`Checking solana provider for ${chainId}`);
  const blockNumber = await provider.getBlockHeight();
  if (!blockNumber || blockNumber < 0) return false;
  logger(`Block number is okay for ${chainId}`);
  return true;
}

export async function isCosmJsProviderHealthy(
  provider: CosmJsProvider['provider'] | CosmJsWasmProvider['provider'],
  chainId: string | number,
): Promise<boolean> {
  const readyProvider = await provider;
  const blockNumber = await readyProvider.getHeight();
  if (!blockNumber || blockNumber < 0) return false;
  logger(`Block number is okay for ${chainId}`);
  return true;
}

export async function isBlockExplorerHealthy(
  chainMetadata: ChainMetadata,
  address?: Address,
  txHash?: string,
): Promise<boolean> {
  try {
    const baseUrl = getExplorerBaseUrl(chainMetadata);
    if (!baseUrl) return false;
    logger(`Got base url: ${baseUrl}`);

    logger(`Checking explorer home for ${chainMetadata.name}`);
    const homeReq = await fetch(baseUrl);
    if (!homeReq.ok) return false;
    logger(`Explorer home okay for ${chainMetadata.name}`);

    if (address) {
      logger(`Checking explorer address page for ${chainMetadata.name}`);
      const addressUrl = getExplorerAddressUrl(chainMetadata, address);
      if (!addressUrl) return false;
      logger(`Got address url: ${addressUrl}`);
      const addressReq = await fetch(addressUrl);
      if (!addressReq.ok) return false;
      logger(`Explorer address page okay for ${chainMetadata.name}`);
    }

    if (txHash) {
      logger(`Checking explorer tx page for ${chainMetadata.name}`);
      const txUrl = getExplorerTxUrl(chainMetadata, txHash);
      if (!txUrl) return false;
      logger(`Got tx url: ${txUrl}`);
      const txReq = await fetch(txUrl);
      if (!txReq.ok) return false;
      logger(`Explorer tx page okay for ${chainMetadata.name}`);
    }

    return true;
  } catch (error) {
    logger(`Explorer error for ${chainMetadata.name}`, error);
    return false;
  }
}
