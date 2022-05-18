import { ChainMap } from '@abacus-network/sdk';

import { ControllerConfig } from '../../../src/controller';

import { DevChains } from './chains';

const defaultControllerConfig = {
  recoveryManager: '0x3909CFACD7a568634716CbCE635F76b9Cf37364B',
  recoveryTimelock: 180,
};

const addresses = {
  alfajores: {
    ...defaultControllerConfig,
    controller: '0x3909CFACD7a568634716CbCE635F76b9Cf37364B',
  },
  kovan: defaultControllerConfig,
};

export const controller: ChainMap<DevChains, ControllerConfig> = addresses;
