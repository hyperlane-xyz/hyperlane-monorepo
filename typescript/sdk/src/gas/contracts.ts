import {
  InterchainGasPaymaster,
  InterchainGasPaymaster__factory,
  OverheadIgp,
  OverheadIgp__factory,
  StorageGasOracle,
  StorageGasOracle__factory,
} from '@hyperlane-xyz/core';

import { ProxiedContract, TransparentProxyAddresses } from '../proxy';

export type IgpContracts = {
  interchainGasPaymaster: ProxiedContract<
    InterchainGasPaymaster,
    TransparentProxyAddresses
  >;
  defaultIsmInterchainGasPaymaster: OverheadIgp;
  storageGasOracle: StorageGasOracle;
};

export const igpFactories = {
  interchainGasPaymaster: new InterchainGasPaymaster__factory(),
  overheadIgp: new OverheadIgp__factory(),
  storageGasOracle: new StorageGasOracle__factory(),
};
