import { ProtocolType } from '@hyperlane-xyz/utils';

import { ChainMetadata, ExplorerFamily } from './chainMetadataTypes.js';

export function getExplorerBaseUrl(
  metadata: ChainMetadata,
  index = 0,
): string | null {
  if (!metadata?.blockExplorers?.length) return null;
  const url = new URL(metadata.blockExplorers[index].url);
  return url.toString();
}

export function getExplorerApi(
  metadata: ChainMetadata,
  index = 0,
): {
  apiUrl: string;
  apiKey?: string | undefined;
  family?: ExplorerFamily | undefined;
} | null {
  const { protocol, blockExplorers } = metadata;
  // TODO solana + cosmos support here as needed
  if (protocol !== ProtocolType.Ethereum) return null;
  if (!blockExplorers?.length || !blockExplorers[index].apiUrl) return null;
  return {
    apiUrl: blockExplorers[index].apiUrl,
    apiKey: blockExplorers[index].apiKey,
    family: blockExplorers[index].family,
  };
}

export function getExplorerApiUrl(
  metadata: ChainMetadata,
  index = 0,
): string | null {
  const explorer = getExplorerApi(metadata, index)!;
  if (!explorer) return null;
  const { apiUrl, apiKey } = explorer;
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

  const urlPathStub = getExplorerAddressPathStub(metadata);
  if (!urlPathStub) return null;

  return appendToPath(baseUrl, `${urlPathStub}/${address}`).toString();
}

function appendToPath(baseUrl: string, pathExtension: string) {
  const base = new URL(baseUrl);
  let currentPath = base.pathname;
  if (currentPath.endsWith('/')) currentPath = currentPath.slice(0, -1);
  const newPath = `${currentPath}/${pathExtension}`;
  const newUrl = new URL(newPath, base);
  newUrl.search = base.searchParams.toString();
  return newUrl;
}

function getExplorerAddressPathStub(metadata: ChainMetadata, index = 0) {
  if (!metadata?.blockExplorers?.[index]) return null;
  const blockExplorer = metadata.blockExplorers[index];
  if (!blockExplorer.family) return null;

  return blockExplorer.family === ExplorerFamily.Voyager
    ? 'contract'
    : 'address';
}
