import { ProtocolType } from '@hyperlane-xyz/utils';

import { ChainMetadata, ExplorerFamily } from './chainMetadataTypes.js';

/**
 * Converts Etherscan-like API URLs to the new V2 format
 * @param apiUrl The original API URL
 * @param chainId The chain ID to use for the V2 API
 * @returns The converted V2 API URL
 */
// https://docs.etherscan.io/etherscan-v2/v2-quickstart
function convertToEtherscanV2Url(
  apiUrl: string,
  chainId?: number,
  family?: ExplorerFamily,
): string {
  // Only convert if it's an Etherscan family explorer
  if (family === ExplorerFamily.Etherscan) {
    // Convert to Etherscan V2 format
    const etherscanV2Url = new URL('https://api.etherscan.io/v2/api');

    // Add chainId parameter if provided
    if (chainId) {
      etherscanV2Url.searchParams.set('chainid', chainId.toString());
    }

    return etherscanV2Url.toString();
  }

  // Return original URL if not an Etherscan family
  return apiUrl;
}

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

  // Convert to V2 format if it's an Etherscan-like API
  const chainId =
    typeof metadata.chainId === 'string'
      ? parseInt(metadata.chainId)
      : metadata.chainId;
  const convertedApiUrl = convertToEtherscanV2Url(
    blockExplorers[index].apiUrl,
    chainId,
    blockExplorers[index].family,
  );

  return {
    apiUrl: convertedApiUrl,
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
