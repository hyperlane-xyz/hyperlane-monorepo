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
) => `abacus-${environment}-${chainName}-validator-${index}`;

export const validators: ChainValidatorSets<MainnetChains> = {
  celo: {
    threshold: 3,
    validators: [
      {
        address: '0x8784f09c2cfb70329b936a3b75eb61c41b467b65',
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('celo', 0),
          region: s3BucketRegion,
        },
      },
      {
        address: '0x36daf0ac1f4feb22440ea0834308e0d3ae409139',
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('celo', 1),
          region: s3BucketRegion,
        },
      },
      {
        address: '0x3fc9689d60e3fe78a624eeb5d9d3452b272cb1a4',
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
        address: '0x7c1d96c9e72c41b84d74095dc2e72b979e933904',
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('ethereum', 0),
          region: s3BucketRegion,
        },
      },
      {
        address: '0xd82ebbd1ef3d75b21f33a36a5c250865d97b9ca1',
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('ethereum', 1),
          region: s3BucketRegion,
        },
      },
      {
        address: '0x333f37f29c6bca607084a75abbe66fd268f585cb',
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
        address: '0x1353b91e2b256ca0a283504b02ae3c69374fb105',
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('avalanche', 0),
          region: s3BucketRegion,
        },
      },
      {
        address: '0x9c6028433b8a0af8530399e57433d2b3b5379b55',
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('avalanche', 1),
          region: s3BucketRegion,
        },
      },
      {
        address: '0x5344d1cccaa4cb189ec7c2d30bdd9eb202aeb738',
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
        address: '0xff198cae21069d865b142f2b9e798d3b299b8df6',
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('polygon', 0),
          region: s3BucketRegion,
        },
      },
      {
        address: '0x577ae23f23a4b81c5c7e26ddd1ffa8c317937629',
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('polygon', 1),
          region: s3BucketRegion,
        },
      },
      {
        address: '0xc79c2e64c5051ac1c8df4a18df4f9ceb5a2ec767',
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
        address: '0x013d01a570b5cfa19032c5176488b5824e225a6b',
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('bsc', 0),
          region: s3BucketRegion,
        },
      },
      {
        address: '0x507ee81c640daeed081ba013324e4e26bc893446',
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('bsc', 1),
          region: s3BucketRegion,
        },
      },
      {
        address: '0x27d47d7d5f14f76b5f800481499f4c1cb1eb54d9',
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
        address: '0x6289f913acc64c2e6baaa2b5175c7db35f98f62d',
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('arbitrum', 0),
          region: s3BucketRegion,
        },
      },
      {
        address: '0x3b989d35931f39d6c7b5bdd41eac3cad5c903af9',
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('arbitrum', 1),
          region: s3BucketRegion,
        },
      },
      {
        address: '0x38566cc4ceb264dfcb0022d9857ffe6c9da33881',
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
        address: '0xcf2dcc3462c84420965501c1dda3d62dde08941d',
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('optimism', 0),
          region: s3BucketRegion,
        },
      },
      {
        address: '0x6dc8296b04206521afc57b868653203fa5585037',
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('optimism', 1),
          region: s3BucketRegion,
        },
      },
      {
        address: '0x95c27b4d029b11f7581f3f36b6575a14daba83d1',
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('optimism', 2),
          region: s3BucketRegion,
        },
      },
    ],
  },
};
