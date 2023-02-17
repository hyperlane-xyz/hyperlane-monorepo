import {
  ChainValidatorConfigs,
  CheckpointSyncerType,
} from '../../../src/config/agent';

import { MainnetChains, environment } from './chains';

const s3BucketRegion = 'us-east-1';

const s3BucketName = (chainName: Chain, index: number) =>
  `hyperlane-${environment}-${chainName}-validator-${index}`;

export const validators: ChainValidatorConfigs<MainnetChains> = {
  celo: {
    interval: 5,
    reorgPeriod: 0,
    validators: [
      {
        address: '0x1f20274b1210046769d48174c2f0e7c25ca7d5c5',
        name: s3BucketName('celo', 0),
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('celo', 0),
          region: s3BucketRegion,
        },
      },
    ],
  },
  ethereum: {
    interval: 5,
    reorgPeriod: 20,
    validators: [
      {
        address: '0x4c327ccb881a7542be77500b2833dc84c839e7b7',
        name: s3BucketName('ethereum', 0),
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('ethereum', 0),
          region: s3BucketRegion,
        },
      },
    ],
  },
  avalanche: {
    interval: 5,
    reorgPeriod: 3,
    validators: [
      {
        address: '0xa7aa52623fe3d78c343008c95894be669e218b8d',
        name: s3BucketName('avalanche', 0),
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('avalanche', 0),
          region: s3BucketRegion,
        },
      },
    ],
  },
  polygon: {
    interval: 5,
    reorgPeriod: 256,
    validators: [
      {
        address: '0x59a001c3451e7f9f3b4759ea215382c1e9aa5fc1',
        name: s3BucketName('polygon', 0),
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('polygon', 0),
          region: s3BucketRegion,
        },
      },
    ],
  },
  bsc: {
    interval: 5,
    reorgPeriod: 15,
    validators: [
      {
        address: '0xcc84b1eb711e5076b2755cf4ad1d2b42c458a45e',
        name: s3BucketName('bsc', 0),
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('bsc', 0),
          region: s3BucketRegion,
        },
      },
    ],
  },
  arbitrum: {
    interval: 5,
    reorgPeriod: 0,
    validators: [
      {
        address: '0xbcb815f38d481a5eba4d7ac4c9e74d9d0fc2a7e7',
        name: s3BucketName('arbitrum', 0),
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('arbitrum', 0),
          region: s3BucketRegion,
        },
      },
    ],
  },
  optimism: {
    interval: 5,
    reorgPeriod: 0,
    validators: [
      {
        address: '0x9f2296d5cfc6b5176adc7716c7596898ded13d35',
        name: s3BucketName('optimism', 0),
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('optimism', 0),
          region: s3BucketRegion,
        },
      },
    ],
  },
  moonbeam: {
    interval: 5,
    reorgPeriod: 0,
    validators: [
      {
        address: '0x237243d32d10e3bdbbf8dbcccc98ad44c1c172ea',
        name: s3BucketName('moonbeam', 0),
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('moonbeam', 0),
          region: s3BucketRegion,
        },
      },
    ],
  },
  gnosis: {
    interval: 5,
    reorgPeriod: 14,
    validators: [
      {
        address: '0xd0529ec8df08d0d63c0f023786bfa81e4bb51fd6',
        name: s3BucketName('gnosis', 0),
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('gnosis', 0),
          region: s3BucketRegion,
        },
      },
      {
        address: '0x829d6ec129bc7187fb1ed161adcf7939fe0c515f',
        name: s3BucketName('gnosis', 1),
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('gnosis', 1),
          region: s3BucketRegion,
        },
      },
      {
        address: '0x00009f8935e94bfe52ab3441df3526ab7cc38db1',
        name: s3BucketName('gnosis', 2),
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('gnosis', 2),
          region: s3BucketRegion,
        },
      },
    ],
  },
};
