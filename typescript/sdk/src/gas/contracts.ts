import {
  InterchainGasPaymaster__factory,
  ProxyAdmin__factory,
  StorageGasOracle__factory,
} from '@hyperlane-xyz/core';

// Default IGP factory targets cancun (offchain-quoted, byte-identical to
// pre-split deployments). On legacy-EVM chains, MultiProvider.resolveEvmTargetFactory
// swaps in MinimalInterchainGasPaymaster__factory from the paris bundle
// (same selectors, no offchain quoting).
export const igpFactories = {
  interchainGasPaymaster: new InterchainGasPaymaster__factory(),
  storageGasOracle: new StorageGasOracle__factory(),
  proxyAdmin: new ProxyAdmin__factory(),
};

export type IgpFactories = typeof igpFactories;
