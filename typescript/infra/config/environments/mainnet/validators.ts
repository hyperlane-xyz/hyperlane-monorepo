import { ChainName } from '@abacus-network/sdk';

import {
  ChainValidatorSets,
  CheckpointSyncerType,
} from '../../../src/config/agent';

import { MainnetChains } from './chains';

const s3BucketRegion = 'us-east-1';

const s3BucketName = (chainName: ChainName, index: number) =>
  `abacus-mainnet-${chainName}-validator-${index}`;

export const validators: ChainValidatorSets<MainnetChains> = {
  celo: {
    threshold: 2,
    validators: [
      {
        address: '',
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('celo', 0),
          region: s3BucketRegion,
        },
      },
      {
        address: '',
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('celo', 1),
          region: s3BucketRegion,
        },
      },
      {
        address: '',
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('celo', 2),
          region: s3BucketRegion,
        },
      },
    ],
  },
  ethereum: {
    threshold: 2,
    validators: [
      {
        address: '',
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('kovan', 0),
          region: s3BucketRegion,
        },
      },
      {
        address: '',
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('kovan', 1),
          region: s3BucketRegion,
        },
      },
      {
        address: '',
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('kovan', 2),
          region: s3BucketRegion,
        },
      },
    ],
  },
  avalanche: {
    threshold: 2,
    validators: [
      {
        address: '',
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('avalanche', 0),
          region: s3BucketRegion,
        },
      },
      {
        address: '',
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('avalanche', 1),
          region: s3BucketRegion,
        },
      },
      {
        address: '',
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('avalanche', 2),
          region: s3BucketRegion,
        },
      },
    ],
  },
  polygon: {
    threshold: 2,
    validators: [
      {
        address: '',
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('polygon', 0),
          region: s3BucketRegion,
        },
      },
      {
        address: '',
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('polygon', 1),
          region: s3BucketRegion,
        },
      },
      {
        address: '',
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('polygon', 2),
          region: s3BucketRegion,
        },
      },
    ],
  },
  bsc: {
    threshold: 2,
    validators: [
      {
        address: '',
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('bsc', 0),
          region: s3BucketRegion,
        },
      },
      {
        address: '',
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('bsc', 1),
          region: s3BucketRegion,
        },
      },
      {
        address: '',
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('bsc', 2),
          region: s3BucketRegion,
        },
      },
    ],
  },
  arbitrum: {
    threshold: 2,
    validators: [
      {
        address: '',
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('arbitrum', 0),
          region: s3BucketRegion,
        },
      },
      {
        address: '',
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('arbitrum', 1),
          region: s3BucketRegion,
        },
      },
      {
        address: '',
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('arbitrum', 2),
          region: s3BucketRegion,
        },
      },
    ],
  },
  optimism: {
    threshold: 2,
    validators: [
      {
        address: '',
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('optimism', 0),
          region: s3BucketRegion,
        },
      },
      {
        address: '',
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('optimism', 1),
          region: s3BucketRegion,
        },
      },
      {
        address: '',
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('optimism', 2),
          region: s3BucketRegion,
        },
      },
    ],
  },
};
