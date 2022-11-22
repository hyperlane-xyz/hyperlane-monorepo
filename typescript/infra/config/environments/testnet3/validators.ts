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
        address: '',
        name: s3BucketName('alfajores', 0),
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('alfajores', 0),
          region: s3BucketRegion,
        },
      },
      {
        address: '',
        name: s3BucketName('alfajores', 1),
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('alfajores', 1),
          region: s3BucketRegion,
        },
      },
      {
        address: '',
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
        address: '',
        name: s3BucketName('fuji', 0),
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('fuji', 0),
          region: s3BucketRegion,
        },
      },
      {
        address: '',
        name: s3BucketName('fuji', 1),
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('fuji', 1),
          region: s3BucketRegion,
        },
      },
      {
        address: '',
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
        address: '',
        name: s3BucketName('mumbai', 0),
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('mumbai', 0),
          region: s3BucketRegion,
        },
      },
      {
        address: '',
        name: s3BucketName('mumbai', 1),
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('mumbai', 1),
          region: s3BucketRegion,
        },
      },
      {
        address: '',
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
        address: '',
        name: s3BucketName('bsctestnet', 0),
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('bsctestnet', 0),
          region: s3BucketRegion,
        },
      },
      {
        address: '',
        name: s3BucketName('bsctestnet', 1),
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('bsctestnet', 1),
          region: s3BucketRegion,
        },
      },
      {
        address: '',
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
        address: '',
        name: s3BucketName('goerli', 0),
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('goerli', 0),
          region: s3BucketRegion,
        },
      },
      {
        address: '',
        name: s3BucketName('goerli', 1),
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('goerli', 1),
          region: s3BucketRegion,
        },
      },
      {
        address: '',
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
        address: '',
        name: s3BucketName('moonbasealpha', 0),
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('moonbasealpha', 0),
          region: s3BucketRegion,
        },
      },
      {
        address: '',
        name: s3BucketName('moonbasealpha', 1),
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('moonbasealpha', 1),
          region: s3BucketRegion,
        },
      },
      {
        address: '',
        name: s3BucketName('moonbasealpha', 2),
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('moonbasealpha', 2),
          region: s3BucketRegion,
        },
      },
    ],
  },
  arbitrumgoerli: {
    threshold: 2,
    validators: [
      {
        address: '',
        name: s3BucketName('arbitrumgoerli', 0),
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('arbitrumgoerli', 0),
          region: s3BucketRegion,
        },
      },
      {
        address: '',
        name: s3BucketName('arbitrumgoerli', 1),
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('arbitrumgoerli', 1),
          region: s3BucketRegion,
        },
      },
      {
        address: '',
        name: s3BucketName('arbitrumgoerli', 2),
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('arbitrumgoerli', 2),
          region: s3BucketRegion,
        },
      },
    ],
  },
  optimismgoerli: {
    threshold: 2,
    validators: [
      {
        address: '',
        name: s3BucketName('optimismgoerli', 0),
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('optimismgoerli', 0),
          region: s3BucketRegion,
        },
      },
      {
        address: '',
        name: s3BucketName('optimismgoerli', 1),
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('optimismgoerli', 1),
          region: s3BucketRegion,
        },
      },
      {
        address: '',
        name: s3BucketName('optimismgoerli', 2),
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('optimismgoerli', 2),
          region: s3BucketRegion,
        },
      },
    ],
  },
  // Ignore for now
  // zksync2testnet: {
  //   threshold: 2,
  //   validators: [
  //     {
  //       address: '0x9476169618f6642413b77549c10dda7a253fb2be',
  //       name: s3BucketName('zksync2testnet', 0),
  //       checkpointSyncer: {
  //         type: CheckpointSyncerType.S3,
  //         bucket: s3BucketName('zksync2testnet', 0),
  //         region: s3BucketRegion,
  //       },
  //     },
  //     {
  //       address: '0x96f9782038cfb4e09c98fbb07627e7c5f7afabcb',
  //       name: s3BucketName('zksync2testnet', 1),
  //       checkpointSyncer: {
  //         type: CheckpointSyncerType.S3,
  //         bucket: s3BucketName('zksync2testnet', 1),
  //         region: s3BucketRegion,
  //       },
  //     },
  //     {
  //       address: '0xf08e3b66c34f101901e6a41cd6f36ce14653fe6b',
  //       name: s3BucketName('zksync2testnet', 2),
  //       checkpointSyncer: {
  //         type: CheckpointSyncerType.S3,
  //         bucket: s3BucketName('zksync2testnet', 2),
  //         region: s3BucketRegion,
  //       },
  //     },
  //   ],
  // },
};
