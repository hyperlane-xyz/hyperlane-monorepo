import {
  InterchainGasPaymaster__factory,
  OverheadIgp__factory,
  StorageGasOracle__factory,
} from '@hyperlane-xyz/core';

import { proxiedFactories } from '../router/types';

export const igpFactories = {
  interchainGasPaymaster: new InterchainGasPaymaster__factory(),
  defaultIsmInterchainGasPaymaster: new OverheadIgp__factory(),
  storageGasOracle: new StorageGasOracle__factory(),
  ...proxiedFactories,
};

export type IgpFactories = typeof igpFactories;
