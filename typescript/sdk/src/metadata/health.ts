import { Mailbox__factory } from '@hyperlane-xyz/core';
import {
  Address,
  ProtocolType,
  rootLogger,
  timeout,
} from '@hyperlane-xyz/utils';

import { chainIdToMetadata } from '../consts/chainMetadata.js';
import { CoreChainName } from '../consts/chains.js';
import { hyperlaneContractAddresses } from '../consts/environments/index.js';
import {
  CosmJsProvider,
  CosmJsWasmProvider,
  EthersV5Provider,
  ProviderType,
  SolanaWeb3Provider,
} from '../providers/ProviderType.js';
import { protocolToDefaultProviderBuilder } from '../providers/providerBuilders.js';

import {
  getExplorerAddressUrl,
  getExplorerBaseUrl,
  getExplorerTxUrl,
} from './blockExplorer.js';
import { ChainMetadata, RpcUrl } from './chainMetadataTypes.js';

const HEALTH_CHECK_TIMEOUT = 5000; // 5s

const logger = rootLogger.child({ module: 'metadata-health' });

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
    logger.error(`Provider error for ${rpc.http}`, error);
    return false;
  }
}

export async function isEthersV5ProviderHealthy(
  provider: EthersV5Provider['provider'],
  chainId: string | number,
): Promise<boolean> {
  logger.debug(`Checking ethers provider for ${chainId}`);
  const blockNumber = await provider.getBlockNumber();
  if (!blockNumber || blockNumber < 0) return false;
  logger.debug(`Block number is okay for ${chainId}`);

  const chainName = chainIdToMetadata[chainId]?.name as CoreChainName;
  if (chainName && hyperlaneContractAddresses[chainName]) {
    const mailboxAddr = hyperlaneContractAddresses[chainName].mailbox;
    const mailbox = Mailbox__factory.createInterface();
    const topics = mailbox.encodeFilterTopics(
      mailbox.events['DispatchId(bytes32)'],
      [],
    );
    logger.debug(`Checking mailbox logs for ${chainId}`);
    const mailboxLogs = await provider.getLogs({
      address: mailboxAddr,
      topics,
      fromBlock: blockNumber - 99,
      toBlock: blockNumber,
    });
    if (!mailboxLogs) return false;
    logger.debug(`Mailbox logs okay for ${chainId}`);
  }
  return true;
}

export async function isSolanaWeb3ProviderHealthy(
  provider: SolanaWeb3Provider['provider'],
  chainId: string | number,
): Promise<boolean> {
  logger.debug(`Checking solana provider for ${chainId}`);
  const blockNumber = await provider.getBlockHeight();
  if (!blockNumber || blockNumber < 0) return false;
  logger.debug(`Block number is okay for ${chainId}`);
  return true;
}

export async function isCosmJsProviderHealthy(
  provider: CosmJsProvider['provider'] | CosmJsWasmProvider['provider'],
  chainId: string | number,
): Promise<boolean> {
  const readyProvider = await provider;
  const blockNumber = await readyProvider.getHeight();
  if (!blockNumber || blockNumber < 0) return false;
  logger.debug(`Block number is okay for ${chainId}`);
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
    logger.debug(`Got base url: ${baseUrl}`);

    logger.debug(`Checking explorer home for ${chainMetadata.name}`);
    const homeReq = await fetch(baseUrl);
    if (!homeReq.ok) return false;
    logger.debug(`Explorer home okay for ${chainMetadata.name}`);

    if (address) {
      logger.debug(`Checking explorer address page for ${chainMetadata.name}`);
      const addressUrl = getExplorerAddressUrl(chainMetadata, address);
      if (!addressUrl) return false;
      logger.debug(`Got address url: ${addressUrl}`);
      const addressReq = await fetch(addressUrl);
      if (!addressReq.ok && addressReq.status !== 404) return false;
      logger.debug(`Explorer address page okay for ${chainMetadata.name}`);
    }

    if (txHash) {
      logger.debug(`Checking explorer tx page for ${chainMetadata.name}`);
      const txUrl = getExplorerTxUrl(chainMetadata, txHash);
      if (!txUrl) return false;
      logger.debug(`Got tx url: ${txUrl}`);
      const txReq = await fetch(txUrl);
      if (!txReq.ok && txReq.status !== 404) return false;
      logger.debug(`Explorer tx page okay for ${chainMetadata.name}`);
    }

    return true;
  } catch (error) {
    logger.error(`Explorer error for ${chainMetadata.name}`, error);
    return false;
  }
}
