import { ChainName } from '@abacus-network/sdk';
import {
  ChainValidatorSets,
  CheckpointSyncerType
} from '../../../src/config/agent';
import { TestnetNetworks } from './domains';



const s3BucketRegion = 'us-east-1';

const s3BucketName = (chainName: ChainName, index: number) =>
  `abacus-testnet-${chainName}-validator-${index}`;

export const validators: ChainValidatorSets<TestnetNetworks> = {
  alfajores: {
    threshold: 2,
    validators: [
      {
        address: '0x5274db49971f14457fb1b1743012e2527804dc73',
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('alfajores', 0),
          region: s3BucketRegion,
        },
      },
      {
        address: '0x636ca13eb829880539c0078ba9d53214b65603a2',
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('alfajores', 1),
          region: s3BucketRegion,
        },
      },
      {
        address: '0x2f5f8c4bb89dfc1c4e905f7e3cd35294b62a572b',
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('alfajores', 2),
          region: s3BucketRegion,
        },
      },
    ],
  },
  kovan: {
    threshold: 2,
    validators: [
      {
        address: '0x84b998a059719d4476959ffbe0a0402ec65a7c62',
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('kovan', 0),
          region: s3BucketRegion,
        },
      },
      {
        address: '0x5aaf0bbbc15f13bcb5f4b2bff5e2f935f4360bb5',
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('kovan', 1),
          region: s3BucketRegion,
        },
      },
      {
        address: '0x3d12f6d395a6532de3d45bd668de43685cb500c3',
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('kovan', 2),
          region: s3BucketRegion,
        },
      },
    ],
  },
  fuji: {
    threshold: 2,
    validators: [
      {
        address: '0x57d4976751978df23be86ec42e27a5749b1beeda',
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('fuji', 0),
          region: s3BucketRegion,
        },
      },
      {
        address: '0x5149b863416de4fae9e1cb63c9564414f4f0bb18',
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('fuji', 1),
          region: s3BucketRegion,
        },
      },
      {
        address: '0xd1ea680f4777eb31569aea1768eaf83bf5587a98',
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
        address: '0x962a63cf73c8beef63ecd753bc57c80241368818',
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('mumbai', 0),
          region: s3BucketRegion,
        },
      },
      {
        address: '0x636d98ed1cd8e5190900ed53a71e8da0076c2672',
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('mumbai', 1),
          region: s3BucketRegion,
        },
      },
      {
        address: '0xf9e86b19152cc8437794d01d4aec8c8a4eb34b20',
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
        address: '0x71a66da2ad833efca67b2257b45f6c6ba11e3816',
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('bsctestnet', 0),
          region: s3BucketRegion,
        },
      },
      {
        address: '0x7306663d18af55294dfd44782fa5c7e16d94485f',
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('bsctestnet', 1),
          region: s3BucketRegion,
        },
      },
      {
        address: '0x19cd5f316993ad15d1ac569cd4e70cbc5e1682ac',
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('bsctestnet', 2),
          region: s3BucketRegion,
        },
      },
    ],
  },
  arbitrumrinkeby: {
    threshold: 2,
    validators: [
      {
        address: '0x4f78b649646b50b1ff41984cde8b7f4f36e1071d',
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('arbitrumrinkeby', 0),
          region: s3BucketRegion,
        },
      },
      {
        address: '0xf71e75225daaf19135b316c76a9105fbdce4b70a',
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('arbitrumrinkeby', 1),
          region: s3BucketRegion,
        },
      },
      {
        address: '0xded3da1c63c37499c627272f46d66e0e46a5bd07',
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('arbitrumrinkeby', 2),
          region: s3BucketRegion,
        },
      },
    ],
  },
  optimismkovan: {
    threshold: 2,
    validators: [
      {
        address: '0x938b35471ff2e968a125f5f3fc02ede89f7b90c0',
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('optimismkovan', 0),
          region: s3BucketRegion,
        },
      },
      {
        address: '0x3b8f4217153e9bb9ae3aa8d314269dd06584081d',
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('optimismkovan', 1),
          region: s3BucketRegion,
        },
      },
      {
        address: '0x2a58a8982a06fbb3757d1c614c6f3ab733d93e6d',
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('optimismkovan', 2),
          region: s3BucketRegion,
        },
      },
    ],
  },
  auroratestnet: {
    threshold: 2,
    validators: [
      {
        address: '0x3dd10f59ec2f18441eb0a3feca489e6d74752260',
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('auroratestnet', 0),
          region: s3BucketRegion,
        },
      },
      {
        address: '0x10ac12f07488ea10371071fccc6a7a1e2733fe35',
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('auroratestnet', 1),
          region: s3BucketRegion,
        },
      },
      {
        address: '0xdf0154233855528a114b4bd640a3fde2020c3b3b',
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('auroratestnet', 2),
          region: s3BucketRegion,
        },
      },
    ],
  },
};
