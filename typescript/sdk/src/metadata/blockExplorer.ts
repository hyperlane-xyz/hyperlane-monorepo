import { ProtocolType } from '@hyperlane-xyz/utils';

import { solanaChainToClusterName } from '../consts/chainMetadata';

import { ChainMetadata } from './chainMetadataTypes';

export function getExplorerBaseUrl(metadata: ChainMetadata): string | null {
  if (!metadata?.blockExplorers?.length) return null;
  const url = new URL(metadata.blockExplorers[0].url);
  // TODO consider move handling of these chain/protocol specific quirks to ChainMetadata
  if (
    metadata.protocol === ProtocolType.Sealevel &&
    solanaChainToClusterName[metadata.name]
  ) {
    url.searchParams.set('cluster', solanaChainToClusterName[metadata.name]);
  }
  return url.toString();
}

export function getExplorerApiUrl(metadata: ChainMetadata): string | null {
  const { protocol, blockExplorers } = metadata;
  // TODO solana + cosmos support here as needed
  if (protocol !== ProtocolType.Ethereum) return null;
  if (!blockExplorers?.length || !blockExplorers[0].apiUrl) return null;
  const { apiUrl, apiKey } = blockExplorers[0];
  if (!apiKey) return apiUrl;
  const url = new URL(apiUrl);
  url.searchParams.set('apikey', apiKey);
  return url.toString();
}

export function getExplorerTxUrl(
  metadata: ChainMetadata,
  hash: string,
): string | null {
  const baseUrl = getExplorerBaseUrl(metadata);
  if (!baseUrl) return null;
  const chainName = metadata.name;
  // TODO consider move handling of these chain/protocol specific quirks to ChainMetadata
  const urlPathStub = ['nautilus', 'proteustestnet'].includes(chainName)
    ? 'transaction'
    : 'tx';
  return appendToPath(baseUrl, `${urlPathStub}/${hash}`).toString();
}

export function getExplorerAddressUrl(
  metadata: ChainMetadata,
  address: string,
): string | null {
  const baseUrl = getExplorerBaseUrl(metadata);
  if (!baseUrl) return null;
  return appendToPath(baseUrl, `address/${address}`).toString();
}

function appendToPath(baseUrl: string, pathExtension: string) {
  const base = new URL(baseUrl);
  let currentPath = base.pathname;
  if (currentPath.endsWith('/')) currentPath = currentPath.slice(0, -1);
  const newPath = `${currentPath}/${pathExtension}`;
  return new URL(newPath, base);
}
