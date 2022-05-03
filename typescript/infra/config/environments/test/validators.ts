import { ChainName } from '@abacus-network/sdk';

import {
  ChainValidatorSets,
  CheckpointSyncerType,
} from '../../../src/config/agent';

import { TestNetworks } from './domains';

const localStoragePath = (chainName: ChainName) =>
  `/tmp/abacus-test-${chainName}-validator`;

export const validators: ChainValidatorSets<TestNetworks> = {
  alfajores: {
    threshold: 1,
    validators: [
      {
        address: '0x70997970c51812dc3a010c7d01b50e0d17dc79c8',
        checkpointSyncer: {
          type: CheckpointSyncerType.LocalStorage,
          path: localStoragePath('alfajores'),
        },
      },
    ],
  },
  fuji: {
    threshold: 1,
    validators: [
      {
        address: '0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc',
        checkpointSyncer: {
          type: CheckpointSyncerType.LocalStorage,
          path: localStoragePath('fuji'),
        },
      },
    ],
  },
  kovan: {
    threshold: 1,
    validators: [
      {
        address: '0x90f79bf6eb2c4f870365e785982e1f101e93b906',
        checkpointSyncer: {
          type: CheckpointSyncerType.LocalStorage,
          path: localStoragePath('kovan'),
        },
      },
    ],
  },
  mumbai: {
    threshold: 1,
    validators: [
      {
        address: '0x15d34aaf54267db7d7c367839aaf71a00a2c6a65',
        checkpointSyncer: {
          type: CheckpointSyncerType.LocalStorage,
          path: localStoragePath('mumbai'),
        },
      },
    ],
  },
};
