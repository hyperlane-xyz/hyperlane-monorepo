import { ChainName } from '@abacus-network/sdk';
import { DevNetworks } from './domains';
import {
  CheckpointSyncerType,
  ChainValidatorSets,
} from '../../../src/config/agent';

const s3BucketRegion = 'us-east-1';

const s3BucketName = (chainName: ChainName, index: number) =>
  `abacus-dev-${chainName}-validator-${index}`;

export const validators: ChainValidatorSets<DevNetworks> = {
  alfajores: {
    threshold: 2,
    validators: [
      {
        address: '0x4455f6B4c341d48ef8CDBe1b9bE8bb3a63c97a46',
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('alfajores', 0),
          region: s3BucketRegion,
        },
      },
      {
        address: '0xD3f317f27D71b2A5fF9A1Ee78a1230390f77e714',
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('alfajores', 1),
          region: s3BucketRegion,
        },
      },
      {
        address: '0x2C503aF4fe1BCb774E842BC0ACaAC5120dDFA560',
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('alfajores', 2),
          region: s3BucketRegion,
        },
      },
    ],
  },
  kovan: {
    threshold: 2,
    validators: [
      {
        address: '0x16975a2f4c8354A6aeE0ef539b1BfDC8Ff69bD49',
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('kovan', 0),
          region: s3BucketRegion,
        },
      },
      {
        address: '0x5f7C587cA4be989a05dd37CCF02D29c71B98F1A9',
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('kovan', 1),
          region: s3BucketRegion,
        },
      },
      {
        address: '0xF9d936b2Be7b1800E2B99cd8634c15a8A682fCE3',
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('kovan', 2),
          region: s3BucketRegion,
        },
      },
    ],
  },
};
