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
    threshold: 2,
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
      {
        address: '0x573b59ee4c3a20132e5a710530d1c1589290f63a',
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
    threshold: 2,
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
      {
        address: '0xdbaa55951204f78c47dc5687783d624fd8d8426a',
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
    threshold: 2,
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
      {
        address: '0x37417806864e822b0f3df8310f53acd3bbd4294a',
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
    threshold: 2,
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
      {
        address: '0x6ec07957adecd7f95371040b54dfedcd57115825',
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
    threshold: 2,
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
      {
        address: '0x4baf7993f2ce2447b61384f5b8b90304913af4ea',
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
    threshold: 2,
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
      {
        address: '0x6413a166851cdf1501dcf5d23cddf0c9ad9bfe5b',
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
    threshold: 2,
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
      {
        address: '0x2ef8ad572738c3371e2e5652d34f7e66f3f47d8c',
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
      {
        address: '0x618599e44109068018ae5f06fa142a80721945e3',
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
