import { MultiProvider } from '../index.js';
import {
  BlockExplorer,
  ExplorerFamily,
} from '../metadata/chainMetadataTypes.js';
import { ChainNameOrId } from '../types.js';

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
