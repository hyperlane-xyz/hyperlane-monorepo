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
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('alfajores', 0),
          region: s3BucketRegion,
        },
      },
      {
        address: '0xb476f4d55d640e9a9a43b9bdf471dc06e4508bbd',
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('alfajores', 1),
          region: s3BucketRegion,
        },
      },
      {
        address: '0xda63918dd964c0d7c59a04062bffe0fba8edaf1c',
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('alfajores', 2),
          region: s3BucketRegion,
        },
      },
      {
        address: '0xebb97602f6acd259ecec9f9fa811aed5b35981ab',
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('alfajores', 3),
          region: s3BucketRegion,
        },
      },
    ],
  },
  kovan: {
    threshold: 3,
    validators: [
      {
        address: '0x1ee94e776cbe4bf74d2f80dae551758efbc21887',
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('kovan', 0),
          region: s3BucketRegion,
        },
      },
      {
        address: '0xf2af10d9fd08eead8c6724a7feb679b5c900a38c',
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('kovan', 1),
          region: s3BucketRegion,
        },
      },
      {
        address: '0xf3b7d58acfbff1fd64f173607101f611034e4f5f',
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('kovan', 2),
          region: s3BucketRegion,
        },
      },
      {
        address: '0xff94c7660e857ba3f35ee248ae461feea266a504',
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('kovan', 3),
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
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('fuji', 0),
          region: s3BucketRegion,
        },
      },
      {
        address: '0xefde1812fea378c645d8e7984ce985b228cd1beb',
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('fuji', 1),
          region: s3BucketRegion,
        },
      },
      {
        address: '0xb17f4f63e09c0a9207e2f008977e3f5b5584875d',
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('fuji', 2),
          region: s3BucketRegion,
        },
      },
      {
        address: '0x6f6a95ad0348454a5d4c3029cd3243acecd1cf8b',
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
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('mumbai', 0),
          region: s3BucketRegion,
        },
      },
      {
        address: '0x3e527087fc60752695d9a4f77a6324bbae3940b1',
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('mumbai', 1),
          region: s3BucketRegion,
        },
      },
      {
        address: '0x62afdaed75bdfd94e0d6103eb0333669d4f5d232',
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('mumbai', 2),
          region: s3BucketRegion,
        },
      },
      {
        address: '0xa12b4612d00f682276c994040a3f37d0d6f343c4',
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
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('bsctestnet', 0),
          region: s3BucketRegion,
        },
      },
      {
        address: '0xc78c1198d4224103dbb0e365286c3403c54fbbf6',
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('bsctestnet', 1),
          region: s3BucketRegion,
        },
      },
      {
        address: '0x453da5c773e829aa4f61be9bad64aa5eaaef000a',
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('bsctestnet', 2),
          region: s3BucketRegion,
        },
      },
      {
        address: '0x625027ffb9b9b9ba083d267e5b7756af33e636a0',
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('bsctestnet', 3),
          region: s3BucketRegion,
        },
      },
    ],
  },
  arbitrumrinkeby: {
    threshold: 3,
    validators: [
      {
        address: '0xf5a871bcb9d6dfa2d3519caf396e7ab3c5a7a2ee',
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('arbitrumrinkeby', 0),
          region: s3BucketRegion,
        },
      },
      {
        address: '0xa6773fc38b023a512106e104a4f2cad2e68d802d',
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('arbitrumrinkeby', 1),
          region: s3BucketRegion,
        },
      },
      {
        address: '0x42f7b994720463eff351186f83d683efa5e2ed49',
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('arbitrumrinkeby', 2),
          region: s3BucketRegion,
        },
      },
      {
        address: '0x49649a8708f45171f5439ec71dc83baafd98b01c',
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('arbitrumrinkeby', 3),
          region: s3BucketRegion,
        },
      },
    ],
  },
  optimismkovan: {
    threshold: 3,
    validators: [
      {
        address: '0xef0d7bbb9c71fef7dc148722060afd78d0ff09d8',
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('optimismkovan', 0),
          region: s3BucketRegion,
        },
      },
      {
        address: '0x8e64ff3936aeadacc23a76cf2c96466927ed758f',
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('optimismkovan', 1),
          region: s3BucketRegion,
        },
      },
      {
        address: '0x13a3cd962ce99d6a6509f8d5b63a4498db329323',
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('optimismkovan', 2),
          region: s3BucketRegion,
        },
      },
      {
        address: '0x85f8286a8ee13aecc227e99b75375826cdb512dd',
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('optimismkovan', 3),
          region: s3BucketRegion,
        },
      },
    ],
  },
};
