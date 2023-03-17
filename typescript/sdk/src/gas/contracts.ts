import {
  InterchainGasPaymaster,
  InterchainGasPaymaster__factory,
  OverheadIgp,
  OverheadIgp__factory,
  ProxyAdmin,
  ProxyAdmin__factory,
  StorageGasOracle,
  StorageGasOracle__factory,
} from '@hyperlane-xyz/core';
import { types } from '@hyperlane-xyz/utils';

import { ProxiedContract, TransparentProxyAddresses } from '../proxy';

export type IgpAddresses = {
  proxyAdmin: types.Address;
  interchainGasPaymaster: types.Address | TransparentProxyAddresses;
  defaultIsmInterchainGasPaymaster: types.Address;
  storageGasOracle: types.Address;
};

export type IgpContracts = {
  proxyAdmin: ProxyAdmin;
  interchainGasPaymaster: ProxiedContract<
    InterchainGasPaymaster,
    TransparentProxyAddresses
  >;
  defaultIsmInterchainGasPaymaster: OverheadIgp;
  storageGasOracle: StorageGasOracle;
};

export const igpFactories = {
  proxyAdmin: new ProxyAdmin__factory(),
  interchainGasPaymaster: new InterchainGasPaymaster__factory(),
  defaultIsmInterchainGasPaymaster: new OverheadIgp__factory(),
  storageGasOracle: new StorageGasOracle__factory(),
};
