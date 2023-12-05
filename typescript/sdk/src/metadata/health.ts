import { Mailbox__factory } from '@hyperlane-xyz/core';
import { Address, ProtocolType, timeout } from '@hyperlane-xyz/utils';

import { chainIdToMetadata } from '../consts/chainMetadata';
import { CoreChainName } from '../consts/chains';
import { hyperlaneContractAddresses } from '../consts/environments';
import { logger } from '../logger';
import {
  CosmJsProvider,
  EthersV5Provider,
  ProviderType,
  SolanaWeb3Provider,
} from '../providers/ProviderType';
import { protocolToDefaultProviderBuilder } from '../providers/providerBuilders';

import { getExplorerAddressUrl, getExplorerBaseUrl } from './blockExplorer';
import { ChainMetadata, RpcUrl } from './chainMetadataTypes';

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
      resultPromise = isSolanaWeb3ProviderHealthy(provider.provider);
    else if (provider.type === ProviderType.CosmJs)
      resultPromise = isCosmJsProviderHealthy(provider.provider);
    else
      throw new Error(
        `Unsupported provider type ${provider.type}, new health check required`,
      );
    const result = await timeout(
      resultPromise,
      5000,
      'RPC health check timed out',
    );
    return result;
  } catch (err) {
    logger(`Provider error for ${rpc.http}`, err);
    return false;
  }
}

export async function isEthersV5ProviderHealthy(
  provider: EthersV5Provider['provider'],
  chainId: string | number,
): Promise<boolean> {
  const blockNumber = await provider.getBlockNumber();
  if (!blockNumber || blockNumber < 0) return false;
  if (chainIdToMetadata[chainId]) {
    const chainName = chainIdToMetadata[chainId].name as CoreChainName;
    const mailboxAddr = hyperlaneContractAddresses[chainName].mailbox;
    const mailbox = Mailbox__factory.createInterface();
    const topics = mailbox.encodeFilterTopics(
      mailbox.events['DispatchId(bytes32)'],
      [],
    );
    const mailboxLogs = await provider.getLogs({
      address: mailboxAddr,
      topics,
      fromBlock: blockNumber - 99,
      toBlock: blockNumber,
    });
    if (!mailboxLogs) return false;
  }
  return true;
}

export async function isSolanaWeb3ProviderHealthy(
  provider: SolanaWeb3Provider['provider'],
): Promise<boolean> {
  const blockNumber = await provider.getBlockHeight();
  if (!blockNumber || blockNumber < 0) return false;
  return true;
}

export async function isCosmJsProviderHealthy(
  provider: CosmJsProvider['provider'],
): Promise<boolean> {
  const readyProvider = await provider;
  const blockNumber = await readyProvider.getHeight();
  if (!blockNumber || blockNumber < 0) return false;
  return true;
}

export async function isBlockExplorerHealthy(
  chainMetadata: ChainMetadata,
  address?: Address,
  txHash?: string,
): Promise<boolean> {
  const baseUrl = getExplorerBaseUrl(chainMetadata);
  if (!baseUrl) return false;

  const homeReq = await fetch(baseUrl);
  if (!homeReq.ok) return false;

  if (address) {
    const addressUrl = getExplorerAddressUrl(chainMetadata, address);
    if (!addressUrl) return false;
    const addressReq = await fetch(addressUrl);
    if (!addressReq.ok) return false;
  }

  if (txHash) {
    const txUrl = getExplorerAddressUrl(chainMetadata, txHash);
    if (!txUrl) return false;
    const txReq = await fetch(txUrl);
    if (!txReq.ok) return false;
  }

  return true;
}
