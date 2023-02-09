import { ChainName } from '@hyperlane-xyz/sdk';

import {
  ChainValidatorConfigs,
  CheckpointSyncerType,
} from '../../../src/config/agent';

import { MainnetChains, environment } from './chains';

const s3BucketRegion = 'us-east-1';

const s3BucketName = <Chain extends ChainName>(
  chainName: Chain,
  index: number,
) => `hyperlane-${environment}-${chainName}-validator-${index}`;

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
      {
        address: '0xef6db730fca69e1438c9ea19fefb3060901a8dfa',
        name: s3BucketName('celo', 1),
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('celo', 1),
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
      {
        address: '0xf4db15933d204b38c17cc027c3f1c9f3c5da9a7c',
        name: s3BucketName('ethereum', 1),
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('ethereum', 1),
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
      {
        address: '0x37a2c96f82dc6c7fa290d858d02ea5d1e0ce86ff',
        name: s3BucketName('avalanche', 1),
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('avalanche', 1),
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
      {
        address: '0x3e549171d0954194442d6b16fa780d1ec83072fd',
        name: s3BucketName('polygon', 1),
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('polygon', 1),
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
      {
        address: '0x62229ff38de88464fd49d79bea0cdc48ebdebd79',
        name: s3BucketName('bsc', 1),
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('bsc', 1),
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
      {
        address: '0xa0d92ee2156f74b18c6d116527e3c9001f123dac',
        name: s3BucketName('arbitrum', 1),
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('arbitrum', 1),
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
      {
        address: '0xd2d9baadd72d3a9983b06ba5f103856e5fea63cb',
        name: s3BucketName('optimism', 1),
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('optimism', 1),
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
      {
        address: '0x02424d4222f35c04da62a2f2dea8c778030bb324',
        name: s3BucketName('moonbeam', 1),
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('moonbeam', 1),
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
