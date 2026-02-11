import {
  InterchainGasPaymaster__factory,
  ProxyAdmin__factory,
  StorageGasOracle__factory,
} from '@hyperlane-xyz/core';
import {
  InterchainGasPaymaster__factory as TronInterchainGasPaymaster__factory,
  ProxyAdmin__factory as TronProxyAdmin__factory,
  StorageGasOracle__factory as TronStorageGasOracle__factory,
} from '@hyperlane-xyz/tron-sdk';

export const igpFactories = {
  interchainGasPaymaster: new InterchainGasPaymaster__factory(),
  storageGasOracle: new StorageGasOracle__factory(),
  proxyAdmin: new ProxyAdmin__factory(),
};

// Tron-compiled factories for TVM compatibility
export const tronIgpFactories = {
  interchainGasPaymaster: new TronInterchainGasPaymaster__factory(),
  storageGasOracle: new TronStorageGasOracle__factory(),
  proxyAdmin: new TronProxyAdmin__factory(),
};

export type IgpFactories = typeof igpFactories;
