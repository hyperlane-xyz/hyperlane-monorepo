import { ChainMap } from '@abacus-network/sdk';

import { ControllerConfig } from '../../../src/controller';

const defaultControllerConfig: ControllerConfig = {
  recoveryManager: '0xfaD1C94469700833717Fa8a3017278BC1cA8031C',
  recoveryTimelock: 180,
};

const addresses = {
  alfajores: {
    ...defaultControllerConfig,
    controller: '0xfaD1C94469700833717Fa8a3017278BC1cA8031C',
  },
  kovan: defaultControllerConfig,
  fuji: defaultControllerConfig,
  mumbai: defaultControllerConfig,
  bsctestnet: defaultControllerConfig,
  arbitrumrinkeby: defaultControllerConfig,
  optimismkovan: defaultControllerConfig,
};

export const controller: ChainMap<keyof typeof addresses, ControllerConfig> =
  addresses;
