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
    threshold: 4,
    validators: [
      {
        address: '0x8784f09c2cfb70329b936a3b75eb61c41b467b65',
        name: s3BucketName('celo', 0),
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('celo', 0),
          region: s3BucketRegion,
        },
      },
      {
        address: '0xd8B404ad70A1682aaF457d4918F7b506035262D3',
        readonly: true,
        name: 'ZKV-celo',
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: 'abacus-mainnet-zkv-celo-signatures',
          region: 'eu-west-2',
        },
      },
      {
        address: '0x1ba04e4df7DF9D736543cC9A8D6f61278EA140ec',
        readonly: true,
        name: 'ZPLabs-celo',
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: 'abacus-validator-signatures-zplabs-celo',
          region: 'eu-central-1',
        },
      },
      {
        address: '0x54e2f79e458fa17e2a5b90cf74ace79fe98cc8d0',
        readonly: true,
        name: 'everstake-celo',
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: 'hyperlane-validator-signatures-everstake-celo',
          region: 'eu-central-1',
        },
      },
      /*
      {
        address: '0x97d91c1d5157338d3d53d452da5e94621a028873',
        readonly: true,
        name: 'staked-celo',
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: 'hyperlane-validator-signatures-production-eu-west-1-celo',
          region: 'eu-west-1',
        },
      },
      {
        address: '0x82e6b73ee3c67032ead7f7022ebc81fb7902199b',
        readonly: true,
        name: 'dsrv-celo',
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: 'dsrv-hyperlane-validator-signatures-validator4-celo',
          region: 'eu-central-1',
        },
      },
      */
    ],
  },
  ethereum: {
    threshold: 4,
    validators: [
      {
        address: '0x7c1d96c9e72c41b84d74095dc2e72b979e933904',
        name: s3BucketName('ethereum', 0),
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('ethereum', 0),
          region: s3BucketRegion,
        },
      },
      {
        address: '0x1946782598328C6D5e1CD1076d37Feab680ad9D2',
        readonly: true,
        name: 'ZKV-ethereum',
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: 'abacus-mainnet-zkv-ethereum-signatures',
          region: 'eu-west-2',
        },
      },
      {
        address: '0xaDF418C044e857C174e70B3a1df7454B55ee258F',
        readonly: true,
        name: 'ZPLabs-eth',
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: 'abacus-validator-signatures-zplabs-eth',
          region: 'eu-central-1',
        },
      },
      {
        address: '0x7a8974723a559d71d16af3f13663cf5bffea0b5e',
        readonly: true,
        name: 'everstake-ethereum',
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: 'hyperlane-validator-signatures-everstake-ethereum',
          region: 'eu-central-1',
        },
      },
      /*
      {
        address: '0x4ed6a1249f4ade53a831def7dd5a44a74e488939',
        readonly: true,
        name: 'staked-ethereum',
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket:
            'hyperlane-validator-signatures-production-eu-west-1-ethereum',
          region: 'eu-west-1',
        },
      },
      {
        address: '0xff88fad084041bc46664d81955327621878b4ed4',
        readonly: true,
        name: 'dsrv-ethereum',
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: 'dsrv-hyperlane-validator-signatures-validator1-ethereum',
          region: 'eu-central-1',
        },
      },
      */
    ],
  },
  avalanche: {
    threshold: 4,
    validators: [
      {
        address: '0x1353b91e2b256ca0a283504b02ae3c69374fb105',
        name: s3BucketName('avalanche', 0),
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('avalanche', 0),
          region: s3BucketRegion,
        },
      },
      {
        address: '0x1E1086F3E6F2F5762AF54B8167cdE934186cbAf9',
        readonly: true,
        name: 'ZKV-avalanche',
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: 'abacus-mainnet-zkv-avalanche-signatures',
          region: 'eu-west-2',
        },
      },
      {
        address: '0xd0b24bb03d2c244c3B1cA78c21A793c9e6ff4d87',
        readonly: true,
        name: 'ZPLabs-avax',
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: 'abacus-validator-signatures-zplabs-avax',
          region: 'eu-central-1',
        },
      },
      {
        address: '0x39b505266aff2d52602f05ceaa7d4261e9494a50',
        readonly: true,
        name: 'everstake-avalanche',
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: 'hyperlane-validator-signatures-everstake-avalanche',
          region: 'eu-central-1',
        },
      },
      /*
      {
        address: '0x46b1023a1d936a4ce1908810f5a3cfabf0e36c15',
        readonly: true,
        name: 'staked-avalanche',
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket:
            'hyperlane-validator-signatures-production-eu-west-1-avalanche',
          region: 'eu-west-1',
        },
      },
      {
        address: '0x47528d65d30299f0edfc2331b13bf41ee3a7d378',
        readonly: true,
        name: 'dsrv-avalanche',
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: 'dsrv-hyperlane-validator-signatures-validator2-avalanche',
          region: 'eu-central-1',
        },
      },
      */
    ],
  },
  polygon: {
    threshold: 4,
    validators: [
      {
        address: '0xff198cae21069d865b142f2b9e798d3b299b8df6',
        name: s3BucketName('polygon', 0),
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('polygon', 0),
          region: s3BucketRegion,
        },
      },
      {
        address: '0x5201867Fc19c7104cA18B37d07C60bBfe8164197',
        readonly: true,
        name: 'ZKV-avalanche',
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: 'abacus-mainnet-zkv-polygon-signatures',
          region: 'eu-west-2',
        },
      },
      {
        address: '0x4c055065DdD22DC874B3494Eb81FcDC1cDe9F57e',
        readonly: true,
        name: 'ZPLabs-pgon',
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: 'abacus-validator-signatures-zplabs-pgon',
          region: 'eu-central-1',
        },
      },
      {
        address: '0x860979ccaee9e432d3684e580987bed3e8f04846',
        readonly: true,
        name: 'everstake-polygon',
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: 'hyperlane-validator-signatures-everstake-polygon',
          region: 'eu-central-1',
        },
      },
      /*
      {
        address: '0x55b74e07f240d28dd3a72d52a01f3b703322b185',
        readonly: true,
        name: 'staked-polygon',
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: 'hyperlane-validator-signatures-production-eu-west-1-polygon',
          region: 'eu-west-1',
        },
      },
      {
        address: '0xf5e112c875c6822930464b997ef5b284bfa9a8d1',
        readonly: true,
        name: 'dsrv-polygon',
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: 'dsrv-hyperlane-validator-signatures-validator6-polygon',
          region: 'eu-central-1',
        },
      },
      */
    ],
  },
  bsc: {
    threshold: 4,
    validators: [
      {
        address: '0x013d01a570b5cfa19032c5176488b5824e225a6b',
        name: s3BucketName('bsc', 0),
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('bsc', 0),
          region: s3BucketRegion,
        },
      },
      {
        address: '0x24f9004c3e02C8c354881685B221cAd8FaF4d9B0',
        readonly: true,
        name: 'ZKV-bsc',
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: 'abacus-mainnet-zkv-bsc-signatures',
          region: 'eu-west-2',
        },
      },
      {
        address: '0x7e303daC8b6b24cac10b6f032e0eF373A1D80299',
        readonly: true,
        name: 'ZPLabs-bsc',
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: 'abacus-validator-signatures-zplabs-bsc',
          region: 'eu-central-1',
        },
      },
      {
        address: '0x73c7d898546a6c595ca7c32d52aa45d75f428a7d',
        readonly: true,
        name: 'everstake-bsc',
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: 'hyperlane-validator-signatures-everstake-bsc',
          region: 'eu-central-1',
        },
      },
      /*
      {
        address: '0x417fe403198c7d817a4fcd8cd59d8d7421626296',
        readonly: true,
        name: 'staked-bsc',
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: 'hyperlane-validator-signatures-production-eu-west-1-bsc',
          region: 'eu-west-1',
        },
      },
      {
        address: '0x15328b90afd81f27799808fe33c6c7245163e74b',
        readonly: true,
        name: 'dsrv-bsc',
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: 'dsrv-hyperlane-validator-signatures-validator3-bsc',
          region: 'eu-central-1',
        },
      },
      */
    ],
  },
  arbitrum: {
    threshold: 4,
    validators: [
      {
        address: '0x6289f913acc64c2e6baaa2b5175c7db35f98f62d',
        name: s3BucketName('arbitrum', 0),
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('arbitrum', 0),
          region: s3BucketRegion,
        },
      },
      {
        address: '0xFF20DFeEE355Ef5a6d3C6dEe25AAB697ad3915a4',
        readonly: true,
        name: 'ZKV-arbitrum',
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: 'abacus-mainnet-zkv-arbitrum-signatures',
          region: 'eu-west-2',
        },
      },
      {
        address: '0xb2e9B58B63c8676E583c2C0050bD46cecd8Ac8F3',
        readonly: true,
        name: 'ZPLabs-arbitrum',
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: 'abacus-validator-signatures-zplabs-arbitrum',
          region: 'eu-central-1',
        },
      },
      {
        address: '0x5acbfc1493252110b698534bca12ec65bf3b5f1f',
        readonly: true,
        name: 'everstake-arbitrum',
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: 'hyperlane-validator-signatures-everstake-arbitrum',
          region: 'eu-central-1',
        },
      },
      /*
      {
        address: '0xee699d14bb61e3931bad94e09668be5524bae350',
        readonly: true,
        name: 'staked-arbitrum',
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket:
            'hyperlane-validator-signatures-production-eu-west-1-arbitrum',
          region: 'eu-west-1',
        },
      },
      {
        address: '0xdebd62c57346c38a9cf2990210de021caaa20470',
        readonly: true,
        name: 'dsrv-arbitrum',
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: 'dsrv-hyperlane-validator-signatures-validator7-arbitrum',
          region: 'eu-central-1',
        },
      },
      */
    ],
  },
  optimism: {
    threshold: 4,
    validators: [
      {
        address: '0xcf2dcc3462c84420965501c1dda3d62dde08941d',
        name: s3BucketName('optimism', 0),
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('optimism', 0),
          region: s3BucketRegion,
        },
      },
      {
        address: '0x8669a883652DBf8c47DECbC4ec8b137E54A5bEAF',
        readonly: true,
        name: 'ZKV-optimism',
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: 'abacus-mainnet-zkv-optimism-signatures',
          region: 'eu-west-2',
        },
      },
      {
        address: '0x9D8a7F26B62fC4e481Be0F0736683d2822A8c354',
        readonly: true,
        name: 'ZPLabs-optimism',
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: 'abacus-validator-signatures-zplabs-optimism',
          region: 'eu-central-1',
        },
      },
      {
        address: '0xbae7166acd15d8f0ab1d432c5d874bb24718edb8',
        readonly: true,
        name: 'everstake-optimism',
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: 'hyperlane-validator-signatures-everstake-optimism',
          region: 'eu-central-1',
        },
      },
      /*
      {
        address: '0x8d96ffabd6b2283092ec08ae5cf65e06fd4dbaa1',
        readonly: true,
        name: 'staked-optimism',
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket:
            'hyperlane-validator-signatures-production-eu-west-1-optimism',
          region: 'eu-west-1',
        },
      },
      {
        address: '0x7f6a8e8d15c6582ea2267e5acdde068f4b26fd91',
        readonly: true,
        name: 'dsrv-optimism',
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: 'dsrv-hyperlane-validator-signatures-validator8-optimism',
          region: 'eu-central-1',
        },
      },
      */
    ],
  },
  moonbeam: {
    threshold: 3,
    validators: [
      {
        address: '0x3da42c84aaf9d548feb219bfdf5fcb2217fbfb48',
        name: s3BucketName('moonbeam', 0),
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('moonbeam', 0),
          region: s3BucketRegion,
        },
      },
      {
        address: '0x65e94ffb6696403a5e6534cbfb6befebda6a0226',
        name: s3BucketName('moonbeam', 1),
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: s3BucketName('moonbeam', 1),
          region: s3BucketRegion,
        },
      },
      {
        address: '0x2b3c6844a3968bb613c46bda43223f0700f91917',
        readonly: true,
        name: 'everstake-moonbeam',
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: 'hyperlane-validator-signatures-everstake-moonbeam',
          region: 'eu-central-1',
        },
      },
      /*
      {
        address: '0x12c31e401ef4a5c494f76ae4c8ed065e3fa0a898',
        readonly: true,
        name: 'staked-moonbeam',
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket:
            'hyperlane-validator-signatures-production-eu-west-1-moonbeam',
          region: 'eu-west-1',
        },
      },
      {
        address: '0xba101c924f76eb48915aaab1a2a28ace24f19b36',
        readonly: true,
        name: 'dsrv-moonbeam',
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: 'dsrv-hyperlane-validator-signatures-validator5-moonbeam',
          region: 'eu-central-1',
        },
      },
      */
    ],
  },
};
