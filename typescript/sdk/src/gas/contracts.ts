import {
  InterchainGasPaymaster__factory,
  ProxyAdmin__factory,
  StorageGasOracle__factory,
} from '@hyperlane-xyz/core';
import {
  InterchainGasPaymaster__artifact,
  ProxyAdmin__artifact,
  StorageGasOracle__artifact,
} from '@hyperlane-xyz/core/artifacts';

export const igpFactories = {
  interchainGasPaymaster: new InterchainGasPaymaster__factory(),
  storageGasOracle: new StorageGasOracle__factory(),
  proxyAdmin: new ProxyAdmin__factory(),
};
export const igpFactoriesArtifacts = {
  interchainGasPaymaster: InterchainGasPaymaster__artifact,
  storageGasOracle: StorageGasOracle__artifact,
  proxyAdmin: ProxyAdmin__artifact,
};

export type IgpFactories = typeof igpFactories;
