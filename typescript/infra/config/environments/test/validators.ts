import { ChainName } from '@hyperlane-xyz/sdk';

import {
  CheckpointSyncerType,
  ValidatorBaseChainConfigMap,
} from '../../../src/config/agent/validator.js';

const localStoragePath = (chainName: ChainName) =>
  `/tmp/hyperlane-test-${chainName}-validator`;

export const validators: ValidatorBaseChainConfigMap = {
  test1: {
    interval: 5,
    reorgPeriod: 0,
    validators: [
      {
        address: '0x70997970c51812dc3a010c7d01b50e0d17dc79c8',
        name: 'local-validator-test1',
        checkpointSyncer: {
          type: CheckpointSyncerType.LocalStorage,
          path: localStoragePath('test1'),
        },
      },
    ],
  },
  test2: {
    interval: 5,
    reorgPeriod: 0,
    validators: [
      {
        address: '0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc',
        name: 'local-validator-test2',
        checkpointSyncer: {
          type: CheckpointSyncerType.LocalStorage,
          path: localStoragePath('test2'),
        },
      },
    ],
  },
  test3: {
    interval: 5,
    reorgPeriod: 0,
    validators: [
      {
        address: '0x90f79bf6eb2c4f870365e785982e1f101e93b906',
        name: 'local-validator-test3',
        checkpointSyncer: {
          type: CheckpointSyncerType.LocalStorage,
          path: localStoragePath('test3'),
        },
      },
    ],
  },
};
