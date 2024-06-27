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
        address: '0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65',
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
        address: '0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc',
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
        address: '0x976EA74026E726554dB657fA54763abd0C3a0aa9',
        name: 'local-validator-test3',
        checkpointSyncer: {
          type: CheckpointSyncerType.LocalStorage,
          path: localStoragePath('test3'),
        },
      },
    ],
  },
  test4: {
    interval: 5,
    reorgPeriod: 0,
    validators: [
      {
        address: '0x14dC79964da2C08b23698B3D3cc7Ca32193d9955',
        name: 'local-validator-test4',
        checkpointSyncer: {
          type: CheckpointSyncerType.LocalStorage,
          path: localStoragePath('test4'),
        },
      },
    ],
  },
};
