import { ChainMap } from '@abacus-network/sdk';

import { ControllerConfig } from '../../../src/controller';

import { TestChains } from './chains';

const defaultControllerConfig: ControllerConfig = {
  recoveryManager: '0x4FbBB2b0820CF0cF027BbB58DC7F7f760BC0c57e',
  recoveryTimelock: 180,
};

const addresses = {
  test1: {
    ...defaultControllerConfig,
    controller: '0x4FbBB2b0820CF0cF027BbB58DC7F7f760BC0c57e',
  },
  test2: defaultControllerConfig,
  test3: defaultControllerConfig,
};

export const controller: ChainMap<TestChains, ControllerConfig> = addresses;
