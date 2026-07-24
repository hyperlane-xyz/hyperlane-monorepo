import type { BlockExplorer } from '../metadata/chainMetadataTypes.js';
import { ExplorerFamily } from '../metadata/chainMetadataTypes.js';

function isEvmBlockExplorerFamilyAndNotEtherscan(
  family?: ExplorerFamily,
): boolean {
  if (!family) {
    return false;
  }

  const byFamily: Record<ExplorerFamily, boolean> = {
    [ExplorerFamily.Blockscout]: true,
    [ExplorerFamily.Etherscan]: false,
    [ExplorerFamily.Other]: false,
    [ExplorerFamily.Routescan]: true,
    [ExplorerFamily.Voyager]: false,
    [ExplorerFamily.ZkSync]: true,
    [ExplorerFamily.RadixDashboard]: false,
    [ExplorerFamily.TronScan]: false,
    [ExplorerFamily.Unknown]: false,
  };

  return byFamily[family] ?? false;
}

export function isEvmBlockExplorerAndNotEtherscan(
  blockExplorer: BlockExplorer,
): boolean {
  return isEvmBlockExplorerFamilyAndNotEtherscan(blockExplorer.family);
}

/**
 * Whether the given explorer family exposes an Etherscan-compatible logs/API
 * surface (Etherscan itself plus Blockscout/Routescan/ZkSync). Families such as
 * TronScan, Voyager, RadixDashboard, Other and Unknown are not compatible and
 * must not be queried with the Etherscan-style API.
 */
export function isEtherscanApiCompatibleFamily(
  family?: ExplorerFamily,
): boolean {
  return (
    family === ExplorerFamily.Etherscan ||
    isEvmBlockExplorerFamilyAndNotEtherscan(family)
  );
}
