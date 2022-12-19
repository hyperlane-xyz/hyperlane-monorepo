import { ChainName } from '@hyperlane-xyz/sdk';

import {
  ChainValidatorSets,
  CheckpointSyncerType,
} from '../../../src/config/agent';

import { MainnetChains, environment } from './chains';

const s3BucketRegion = 'us-east-1';

const s3BucketName = <Chain extends ChainName>(
  chainName: Chain,
  index: number,
) => `hyperlane-${environment}-${chainName}-validator-${index}`;

export const validators: ChainValidatorSets<MainnetChains> = {
  celo: {
    threshold: 3,
    validators: [
      {
        address: '0x',
        name: s3BucketName('celo', 0),
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('celo', 0),
          region: s3BucketRegion,
        },
      },
      {
        address: '0x',
        name: s3BucketName('celo', 1),
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('celo', 1),
          region: s3BucketRegion,
        },
      },
      {
        address: '0x',
        name: s3BucketName('celo', 2),
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('celo', 2),
          region: s3BucketRegion,
        },
      },
    ],
  },
  ethereum: {
    threshold: 3,
    validators: [
      {
        address: '0x',
        name: s3BucketName('ethereum', 0),
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('ethereum', 0),
          region: s3BucketRegion,
        },
      },
      {
        address: '0x',
        name: s3BucketName('ethereum', 1),
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('ethereum', 1),
          region: s3BucketRegion,
        },
      },
      {
        address: '0x',
        name: s3BucketName('ethereum', 2),
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('ethereum', 2),
          region: s3BucketRegion,
        },
      },
    ],
  },
  avalanche: {
    threshold: 3,
    validators: [
      {
        address: '0x',
        name: s3BucketName('avalanche', 0),
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('avalanche', 0),
          region: s3BucketRegion,
        },
      },
      {
        address: '0x',
        name: s3BucketName('avalanche', 1),
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('avalanche', 1),
          region: s3BucketRegion,
        },
      },
      {
        address: '0x',
        name: s3BucketName('avalanche', 2),
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('avalanche', 2),
          region: s3BucketRegion,
        },
      },
    ],
  },
  polygon: {
    threshold: 3,
    validators: [
      {
        address: '0x',
        name: s3BucketName('polygon', 0),
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('polygon', 0),
          region: s3BucketRegion,
        },
      },
      {
        address: '0x',
        name: s3BucketName('polygon', 1),
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('polygon', 1),
          region: s3BucketRegion,
        },
      },
      {
        address: '0x',
        name: s3BucketName('polygon', 2),
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('polygon', 2),
          region: s3BucketRegion,
        },
      },
    ],
  },
  bsc: {
    threshold: 3,
    validators: [
      {
        address: '0x',
        name: s3BucketName('bsc', 0),
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('bsc', 0),
          region: s3BucketRegion,
        },
      },
      {
        address: '0x',
        name: s3BucketName('bsc', 1),
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('bsc', 1),
          region: s3BucketRegion,
        },
      },
      {
        address: '0x',
        name: s3BucketName('bsc', 2),
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('bsc', 2),
          region: s3BucketRegion,
        },
      },
    ],
  },
  arbitrum: {
    threshold: 3,
    validators: [
      {
        address: '0x',
        name: s3BucketName('arbitrum', 0),
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('arbitrum', 0),
          region: s3BucketRegion,
        },
      },
      {
        address: '0x',
        name: s3BucketName('arbitrum', 1),
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('arbitrum', 1),
          region: s3BucketRegion,
        },
      },
      {
        address: '0x',
        name: s3BucketName('arbitrum', 2),
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('arbitrum', 2),
          region: s3BucketRegion,
        },
      },
    ],
  },
  optimism: {
    threshold: 3,
    validators: [
      {
        address: '0x',
        name: s3BucketName('optimism', 0),
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('optimism', 0),
          region: s3BucketRegion,
        },
      },
      {
        address: '0x',
        name: s3BucketName('optimism', 1),
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('optimism', 1),
          region: s3BucketRegion,
        },
      },
      {
        address: '0x',
        name: s3BucketName('optimism', 2),
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('optimism', 2),
          region: s3BucketRegion,
        },
      },
    ],
  },
  moonbeam: {
    threshold: 2,
    validators: [
      {
        address: '0x',
        name: s3BucketName('moonbeam', 0),
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('moonbeam', 0),
          region: s3BucketRegion,
        },
      },
      {
        address: '0x',
        name: s3BucketName('moonbeam', 1),
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('moonbeam', 1),
          region: s3BucketRegion,
        },
      },
      {
        address: '0x',
        name: s3BucketName('moonbeam', 2),
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('moonbeam', 2),
          region: s3BucketRegion,
        },
      },
    ],
  },
};
