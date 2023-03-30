import {
  InterchainGasPaymaster__factory,
  OverheadIgp__factory,
  ProxyAdmin__factory,
  StorageGasOracle__factory,
} from '@hyperlane-xyz/core';

export const igpFactories = {
  proxyAdmin: new ProxyAdmin__factory(),
  interchainGasPaymaster: new InterchainGasPaymaster__factory(),
  defaultIsmInterchainGasPaymaster: new OverheadIgp__factory(),
  storageGasOracle: new StorageGasOracle__factory(),
};
