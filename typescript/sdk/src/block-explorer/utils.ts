import {
  BlockExplorer,
  ExplorerFamily,
} from '../metadata/chainMetadataTypes.js';

export function isEvmBlockExplorerAndNotEtherscan(
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
