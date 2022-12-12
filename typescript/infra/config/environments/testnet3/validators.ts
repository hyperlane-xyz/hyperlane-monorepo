import { ChainName } from '@hyperlane-xyz/sdk';

import {
  ChainValidatorSets,
  CheckpointSyncerType,
} from '../../../src/config/agent';

import { TestnetChains, environment } from './chains';

const s3BucketRegion = 'us-east-1';

const s3BucketName = <Chain extends ChainName>(
  chainName: Chain,
  index: number,
) => `hyperlane-${environment}-${chainName}-validator-${index}`;

export const validators: ChainValidatorSets<TestnetChains> = {
  alfajores: {
    threshold: 2,
    validators: [
      {
        address: '0xe6072396568e73ce6803b12b7e04164e839f1e54',
        name: s3BucketName('alfajores', 0),
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('alfajores', 0),
          region: s3BucketRegion,
        },
      },
      {
        address: '0x9f177f51289b22515f41f95872e1511391b8e105',
        name: s3BucketName('alfajores', 1),
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('alfajores', 1),
          region: s3BucketRegion,
        },
      },
      {
        address: '0x15f77400845eb1c971ad08de050861d5508cad6c',
        name: s3BucketName('alfajores', 2),
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('alfajores', 2),
          region: s3BucketRegion,
        },
      },
    ],
  },
  fuji: {
    threshold: 2,
    validators: [
      {
        address: '0x9fa19ead5ec76e437948b35e227511b106293c40',
        name: s3BucketName('fuji', 0),
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('fuji', 0),
          region: s3BucketRegion,
        },
      },
      {
        address: '0x227e7d6507762ece0c94678f8c103eff9d682476',
        name: s3BucketName('fuji', 1),
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('fuji', 1),
          region: s3BucketRegion,
        },
      },
      {
        address: '0x2379e43740e4aa4fde48cf4f00a3106df1d8420d',
        name: s3BucketName('fuji', 2),
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('fuji', 2),
          region: s3BucketRegion,
        },
      },
    ],
  },
  mumbai: {
    threshold: 2,
    validators: [
      {
        address: '0x0a664ea799447da6b15645cf8b9e82072a68343f',
        name: s3BucketName('mumbai', 0),
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('mumbai', 0),
          region: s3BucketRegion,
        },
      },
      {
        address: '0x6ae6f12929a960aba24ba74ea310e3d37d0ac045',
        name: s3BucketName('mumbai', 1),
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('mumbai', 1),
          region: s3BucketRegion,
        },
      },
      {
        address: '0x51f70c047cd73bc7873273707501568857a619c4',
        name: s3BucketName('mumbai', 2),
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('mumbai', 2),
          region: s3BucketRegion,
        },
      },
    ],
  },
  bsctestnet: {
    threshold: 2,
    validators: [
      {
        address: '0x23338c8714976dd4a57eaeff17cbd26d7e275c08',
        name: s3BucketName('bsctestnet', 0),
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('bsctestnet', 0),
          region: s3BucketRegion,
        },
      },
      {
        address: '0x85a618d7450ebc37e0d682371f08dac94eec7a76',
        name: s3BucketName('bsctestnet', 1),
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('bsctestnet', 1),
          region: s3BucketRegion,
        },
      },
      {
        address: '0x95b76562e4ba1791a27ba4236801271c9115b141',
        name: s3BucketName('bsctestnet', 2),
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('bsctestnet', 2),
          region: s3BucketRegion,
        },
      },
    ],
  },
  goerli: {
    threshold: 2,
    validators: [
      {
        address: '0xf43fbd072fd38e1121d4b3b0b8a35116bbb01ea9',
        name: s3BucketName('goerli', 0),
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('goerli', 0),
          region: s3BucketRegion,
        },
      },
      {
        address: '0xa33020552a21f35e75bd385c6ab95c3dfa82d930',
        name: s3BucketName('goerli', 1),
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('goerli', 1),
          region: s3BucketRegion,
        },
      },
      {
        address: '0x0bba4043ff242f8bf3f39bafa8930a84d644d947',
        name: s3BucketName('goerli', 2),
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('goerli', 2),
          region: s3BucketRegion,
        },
      },
    ],
  },
  moonbasealpha: {
    threshold: 2,
    validators: [
      {
        address: '0x890c2aeac157c3f067f3e42b8afc797939c59a32',
        name: s3BucketName('moonbasealpha', 0),
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('moonbasealpha', 0),
          region: s3BucketRegion,
        },
      },
      {
        address: '0x1b06d6fe69b972ed7420c83599d5a5c0fc185904',
        name: s3BucketName('moonbasealpha', 1),
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('moonbasealpha', 1),
          region: s3BucketRegion,
        },
      },
      {
        address: '0xe70b85206a968a99a597581f0fa09c99e7681093',
        name: s3BucketName('moonbasealpha', 2),
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('moonbasealpha', 2),
          region: s3BucketRegion,
        },
      },
    ],
  },
  optimismgoerli: {
    threshold: 2,
    validators: [
      {
        address: '0xbb8d77eefbecc55db6e5a19b0fc3dc290776f189',
        name: s3BucketName('optimismgoerli', 0),
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('optimismgoerli', 0),
          region: s3BucketRegion,
        },
      },
      {
        address: '0x69792508b4ddaa3ca52241ccfcd1e0b119a1ee65',
        name: s3BucketName('optimismgoerli', 1),
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('optimismgoerli', 1),
          region: s3BucketRegion,
        },
      },
      {
        address: '0x11ddb46c6b653e0cdd7ad5bee32ae316e18f8453',
        name: s3BucketName('optimismgoerli', 2),
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('optimismgoerli', 2),
          region: s3BucketRegion,
        },
      },
    ],
  },
  arbitrumgoerli: {
    threshold: 2,
    validators: [
      {
        address: '0xce798fa21e323f6b24d9838a10ffecdefdfc4f30',
        name: s3BucketName('arbitrumgoerli', 0),
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('arbitrumgoerli', 0),
          region: s3BucketRegion,
        },
      },
      {
        address: '0xa792d39dca4426927e0f00c1618d61c9cb41779d',
        name: s3BucketName('arbitrumgoerli', 1),
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('arbitrumgoerli', 1),
          region: s3BucketRegion,
        },
      },
      {
        address: '0xdf181fcc11dfac5d01467e4547101a856dd5aa04',
        name: s3BucketName('arbitrumgoerli', 2),
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('arbitrumgoerli', 2),
          region: s3BucketRegion,
        },
      },
    ],
  },
  wallaby: {
    threshold: 2,
    validators: [],
  },
};
