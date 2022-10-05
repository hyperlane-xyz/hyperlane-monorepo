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
) => `abacus-${environment}-${chainName}-validator-${index}`;

export const validators: ChainValidatorSets<TestnetChains> = {
  alfajores: {
    threshold: 3,
    validators: [
      {
        address: '0x7716860b2be4079137dc21533ac6d26a99d76e83',
        name: s3BucketName('alfajores', 0),
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('alfajores', 0),
          region: s3BucketRegion,
        },
      },
      {
        address: '0xb476f4d55d640e9a9a43b9bdf471dc06e4508bbd',
        name: s3BucketName('alfajores', 1),
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('alfajores', 1),
          region: s3BucketRegion,
        },
      },
      {
        address: '0xda63918dd964c0d7c59a04062bffe0fba8edaf1c',
        name: s3BucketName('alfajores', 2),
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('alfajores', 2),
          region: s3BucketRegion,
        },
      },
      {
        address: '0xebb97602f6acd259ecec9f9fa811aed5b35981ab',
        name: s3BucketName('alfajores', 3),
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('alfajores', 3),
          region: s3BucketRegion,
        },
      },
    ],
  },
  fuji: {
    threshold: 3,
    validators: [
      {
        address: '0xc0ab1f3e3317521a92462927849b8844cf408b09',
        name: s3BucketName('fuji', 0),
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('fuji', 0),
          region: s3BucketRegion,
        },
      },
      {
        address: '0xefde1812fea378c645d8e7984ce985b228cd1beb',
        name: s3BucketName('fuji', 1),
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('fuji', 1),
          region: s3BucketRegion,
        },
      },
      {
        address: '0xb17f4f63e09c0a9207e2f008977e3f5b5584875d',
        name: s3BucketName('fuji', 2),
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('fuji', 2),
          region: s3BucketRegion,
        },
      },
      {
        address: '0x6f6a95ad0348454a5d4c3029cd3243acecd1cf8b',
        name: s3BucketName('fuji', 3),
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('fuji', 3),
          region: s3BucketRegion,
        },
      },
    ],
  },
  mumbai: {
    threshold: 3,
    validators: [
      {
        address: '0x0f1a231cb2ecc5f26696c433d76fe59521a227e0',
        name: s3BucketName('mumbai', 0),
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('mumbai', 0),
          region: s3BucketRegion,
        },
      },
      {
        address: '0x3e527087fc60752695d9a4f77a6324bbae3940b1',
        name: s3BucketName('mumbai', 1),
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('mumbai', 1),
          region: s3BucketRegion,
        },
      },
      {
        address: '0x62afdaed75bdfd94e0d6103eb0333669d4f5d232',
        name: s3BucketName('mumbai', 2),
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('mumbai', 2),
          region: s3BucketRegion,
        },
      },
      {
        address: '0xa12b4612d00f682276c994040a3f37d0d6f343c4',
        name: s3BucketName('mumbai', 3),
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('mumbai', 3),
          region: s3BucketRegion,
        },
      },
    ],
  },
  bsctestnet: {
    threshold: 3,
    validators: [
      {
        address: '0xa7959b2f03f6fc77c9592547bd0ca12fe2c7bf8f',
        name: s3BucketName('bsctestnet', 0),
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('bsctestnet', 0),
          region: s3BucketRegion,
        },
      },
      {
        address: '0xc78c1198d4224103dbb0e365286c3403c54fbbf6',
        name: s3BucketName('bsctestnet', 1),
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('bsctestnet', 1),
          region: s3BucketRegion,
        },
      },
      {
        address: '0x453da5c773e829aa4f61be9bad64aa5eaaef000a',
        name: s3BucketName('bsctestnet', 2),
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('bsctestnet', 2),
          region: s3BucketRegion,
        },
      },
      {
        address: '0x625027ffb9b9b9ba083d267e5b7756af33e636a0',
        name: s3BucketName('bsctestnet', 3),
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('bsctestnet', 3),
          region: s3BucketRegion,
        },
      },
    ],
  },
  goerli: {
    threshold: 2,
    validators: [
      {
        address: '0x89687c99ffb56f329915f80a858a45fccc2b7402',
        name: s3BucketName('goerli', 0),
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('goerli', 0),
          region: s3BucketRegion,
        },
      },
      {
        address: '0xca25781e7c0067a71d09b991bd7b37ab1168c76c',
        name: s3BucketName('goerli', 1),
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('goerli', 1),
          region: s3BucketRegion,
        },
      },
      {
        address: '0xcbf6cde516f43a7b5346f48319b016b0e05cb7af',
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
        address: '0x0cc08084a0a7cc61102e800204851627732f8aa4',
        name: s3BucketName('moonbasealpha', 0),
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('moonbasealpha', 0),
          region: s3BucketRegion,
        },
      },
      {
        address: '0xd151f6ca08e632eb7abd5afcb49c47d6a9b67a54',
        name: s3BucketName('moonbasealpha', 1),
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('moonbasealpha', 1),
          region: s3BucketRegion,
        },
      },
      {
        address: '0x8d41c4cb699a408f9b5c69156eaa12ce76346b16',
        name: s3BucketName('moonbasealpha', 2),
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('moonbasealpha', 2),
          region: s3BucketRegion,
        },
      },
    ],
  },
};
