import type { MultiProvider } from '@hyperlane-xyz/sdk';
import { fetchWithTimeout } from '@hyperlane-xyz/utils';

import { widgetLogger } from '../logger.js';

export interface ExplorerQueryResponse<R> {
  status: string;
  message: string;
  result: R;
}

export async function getExplorerApiUrl(
  chainName: string,
  multiProvider: MultiProvider,
) {
  const metadata = await multiProvider.getChainMetadata(chainName);
  const blockExplorers = metadata?.blockExplorers;
  if (!blockExplorers?.length) return null;
  return blockExplorers[0].apiUrl || blockExplorers[0].url;
}

export async function queryExplorer<P>(
  chainName: string,
  multiProvider: MultiProvider,
  path: string,
  apiKey?: string,
  timeout?: number,
) {
  const baseUrl = getExplorerApiUrl(chainName, multiProvider);
  if (!baseUrl)
    throw new Error(`No URL found for explorer for chain ${chainName}`);

  let url = `${baseUrl}/${path}`;
  widgetLogger.debug('Querying explorer url:', url);

  if (apiKey) {
    url += `&apikey=${apiKey}`;
  }

  const result = await executeExplorerQuery<P>(url, timeout);
  return result;
}

export async function executeExplorerQuery<P>(url: string, timeout?: number) {
  const response = await fetchWithTimeout(url, undefined, timeout);
  if (!response.ok) {
    throw new Error(`Fetch response not okay: ${response.status}`);
  }
  const json = (await response.json()) as ExplorerQueryResponse<P>;

  if (!json.result) {
    const responseText = await response.text();
    throw new Error(`Invalid result format: ${responseText}`);
  }

  return json.result;
}

interface PartialBlock {
  hash: string;
  number: number;
  timestamp: number;
  nonce: string;
}

export async function queryExplorerForBlock(
  chainName: string,
  multiProvider: MultiProvider,
  blockNumber?: number | string,
) {
  const path = `?module=proxy&action=eth_getBlockByNumber&tag=${
    blockNumber || 'latest'
  }&boolean=false`;
  const block = await queryExplorer<PartialBlock>(
    chainName,
    multiProvider,
    path,
  );
  if (!block?.number || parseInt(block.number.toString()) < 0) {
    const msg = 'Invalid block result';
    widgetLogger.error(msg, JSON.stringify(block), path);
    throw new Error(msg);
  }
  return block;
}
