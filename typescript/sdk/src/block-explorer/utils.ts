import { Hex, Log } from 'viem';

import { MultiProvider } from '../index.js';
import {
  BlockExplorer,
  ExplorerFamily,
} from '../metadata/chainMetadataTypes.js';
import { ChainNameOrId } from '../types.js';

import { GetEventLogsResponse } from './etherscan.js';

function isEvmBlockExplorerAndNotEtherscan(
  blockExplorer: BlockExplorer,
): boolean {
  if (!blockExplorer.family) {
    return false;
  }

  const byFamily: Record<ExplorerFamily, boolean> = {
    [ExplorerFamily.Blockscout]: true,
    [ExplorerFamily.Etherscan]: false,
    [ExplorerFamily.Other]: false,
    [ExplorerFamily.Routescan]: true,
    [ExplorerFamily.Voyager]: false,
    [ExplorerFamily.ZkSync]: true,
  };

  return byFamily[blockExplorer.family] ?? false;
}

export function getExplorerFromChainMetadata(
  chain: ChainNameOrId,
  multiProvider: MultiProvider,
): ReturnType<MultiProvider['getExplorerApi']> | null {
  const defaultExplorer = multiProvider.getExplorerApi(chain);

  const chainMetadata = multiProvider.getChainMetadata(chain);
  const [fallBackExplorer] =
    chainMetadata.blockExplorers?.filter((blockExplorer) =>
      isEvmBlockExplorerAndNotEtherscan(blockExplorer),
    ) ?? [];

  // Fallback to use other block explorers if the default block explorer is etherscan and an API key is not
  // configured
  const isExplorerConfiguredCorrectly =
    defaultExplorer.family === ExplorerFamily.Etherscan
      ? !!defaultExplorer.apiKey
      : true;
  const canUseExplorerApi =
    defaultExplorer.family !== ExplorerFamily.Other &&
    isExplorerConfiguredCorrectly;

  const explorer = canUseExplorerApi ? defaultExplorer : fallBackExplorer;

  return explorer ?? null;
}

export function viemLogFromGetEventLogsResponse(
  log: GetEventLogsResponse,
): Log {
  return {
    address: log.address as Hex,
    data: log.data as Hex,
    blockNumber: BigInt(log.blockNumber),
    transactionHash: log.transactionHash as Hex,
    logIndex: Number(log.logIndex),
    transactionIndex: Number(log.transactionIndex),
    topics: log.topics as [Hex, ...Hex[]],
    blockHash: null,
    removed: false,
  };
}
