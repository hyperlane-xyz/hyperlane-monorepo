import { ChainName } from '@hyperlane-xyz/sdk';

import {
  ChainValidatorSets,
  CheckpointSyncerType,
} from '../../../src/config/agent';

import { MainnetChains, environment } from './chains';

interface S3BucketInfo {
  region: string;
  name: <Chain extends ChainName>(chainName: Chain, index?: number) => string;
}

const abacusS3BucketInfo: S3BucketInfo = {
  region: 'us-east-1',
  name: <Chain extends ChainName>(chainName: Chain, index?: number) =>
    `abacus-${environment}-${chainName}-validator-${index}`,
};

const zkvS3BucketInfo: S3BucketInfo = {
  region: 'eu-west-2',
  name: <Chain extends ChainName>(chainName: Chain, index?: number) =>
    `abacus-${environment}-zkv-${chainName}-signatures`,
};

const zplabsS3BucketInfo: S3BucketInfo = {
  region: 'eu-north-1',
  name: <Chain extends ChainName>(chainName: Chain, index?: number) =>
    `abacus-validator-signatures-zplabs-${chainName}`,
};

const fernS3BucketInfo: S3BucketInfo = {
  region: 'eu-north-1',
  name: <Chain extends ChainName>(chainName: Chain, index?: number) =>
    `fern-hyperlane-${chainName}-mainnet-${chainName}`,
};

export const validators: ChainValidatorSets<MainnetChains> = {
  celo: {
    threshold: 3,
    validators: [
      {
        address: '0x8784f09c2cfb70329b936a3b75eb61c41b467b65',
        name: abacusS3BucketInfo.name('celo', 0),
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: abacusS3BucketInfo.name('celo', 0),
          region: abacusS3BucketInfo.region,
        },
      },
      {
        address: '0x36daf0ac1f4feb22440ea0834308e0d3ae409139',
        name: abacusS3BucketInfo.name('celo', 1),
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: abacusS3BucketInfo.name('celo', 1),
          region: abacusS3BucketInfo.region,
        },
      },
      {
        address: '0x3fc9689d60e3fe78a624eeb5d9d3452b272cb1a4',
        name: abacusS3BucketInfo.name('celo', 2),
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: abacusS3BucketInfo.name('celo', 2),
          region: abacusS3BucketInfo.region,
        },
      },
      {
        address: '0xd8B404ad70A1682aaF457d4918F7b506035262D3',
        readonly: true,
        name: 'ZKV-celo',
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: zkvS3BucketInfo.name('celo'),
          region: zkvS3BucketInfo.region,
        },
      },
      {
        address: '0x1ba04e4df7DF9D736543cC9A8D6f61278EA140ec',
        readonly: true,
        name: 'ZPLabs-celo',
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: zplabsS3BucketInfo.name('celo'),
          region: zplabsS3BucketInfo.region,
        },
      },
      {
        address: '0x9bdd262D6b02DF346FC4A9D40fBBA4E6E04212B2',
        readonly: true,
        name: 'Fern-celo',
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: fernS3BucketInfo.name('celo'),
          region: fernS3BucketInfo.region,
        },
      },
    ],
  },
  ethereum: {
    threshold: 3,
    validators: [
      {
        address: '0x7c1d96c9e72c41b84d74095dc2e72b979e933904',
        name: abacusS3BucketInfo.name('ethereum', 0),
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: abacusS3BucketInfo.name('ethereum', 0),
          region: abacusS3BucketInfo.region,
        },
      },
      {
        address: '0xd82ebbd1ef3d75b21f33a36a5c250865d97b9ca1',
        name: abacusS3BucketInfo.name('ethereum', 1),
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: abacusS3BucketInfo.name('ethereum', 1),
          region: abacusS3BucketInfo.region,
        },
      },
      {
        address: '0x333f37f29c6bca607084a75abbe66fd268f585cb',
        name: abacusS3BucketInfo.name('ethereum', 2),
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: abacusS3BucketInfo.name('ethereum', 2),
          region: abacusS3BucketInfo.region,
        },
      },
      {
        address: '0x1946782598328C6D5e1CD1076d37Feab680ad9D2',
        readonly: true,
        name: 'ZKV-ethereum',
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: zkvS3BucketInfo.name('ethereum'),
          region: zkvS3BucketInfo.region,
        },
      },
      {
        address: '0xaDF418C044e857C174e70B3a1df7454B55ee258F',
        readonly: true,
        name: 'ZPLabs-eth',
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: zplabsS3BucketInfo.name('ethereum'),
          region: zplabsS3BucketInfo.region,
        },
      },
      {
        address: '0x5B0c4A73004327673A8d86c20608320d21969C39',
        readonly: true,
        name: 'Fern-ethereum',
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: fernS3BucketInfo.name('ethereum'),
          region: fernS3BucketInfo.region,
        },
      },
    ],
  },
  avalanche: {
    threshold: 3,
    validators: [
      {
        address: '0x1353b91e2b256ca0a283504b02ae3c69374fb105',
        name: abacusS3BucketInfo.name('avalanche', 0),
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: abacusS3BucketInfo.name('avalanche', 0),
          region: abacusS3BucketInfo.region,
        },
      },
      {
        address: '0x9c6028433b8a0af8530399e57433d2b3b5379b55',
        name: abacusS3BucketInfo.name('avalanche', 1),
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: abacusS3BucketInfo.name('avalanche', 1),
          region: abacusS3BucketInfo.region,
        },
      },
      {
        address: '0x5344d1cccaa4cb189ec7c2d30bdd9eb202aeb738',
        name: abacusS3BucketInfo.name('avalanche', 2),
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: abacusS3BucketInfo.name('avalanche', 2),
          region: abacusS3BucketInfo.region,
        },
      },
      {
        address: '0x1E1086F3E6F2F5762AF54B8167cdE934186cbAf9',
        readonly: true,
        name: 'ZKV-avalanche',
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: zkvS3BucketInfo.name('avalanche'),
          region: zkvS3BucketInfo.region,
        },
      },
      {
        address: '0xd0b24bb03d2c244c3B1cA78c21A793c9e6ff4d87',
        readonly: true,
        name: 'ZPLabs-avax',
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: zplabsS3BucketInfo.name('avalanche'),
          region: zplabsS3BucketInfo.region,
        },
      },
      {
        address: '0x5fd1722741039C9Ed3a1f7946270d7c39e80A000',
        readonly: true,
        name: 'Fern-avax',
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: fernS3BucketInfo.name('avalanche'),
          region: fernS3BucketInfo.region,
        },
      },
    ],
  },
  polygon: {
    threshold: 3,
    validators: [
      {
        address: '0xff198cae21069d865b142f2b9e798d3b299b8df6',
        name: abacusS3BucketInfo.name('polygon', 0),
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: abacusS3BucketInfo.name('polygon', 0),
          region: abacusS3BucketInfo.region,
        },
      },
      {
        address: '0x577ae23f23a4b81c5c7e26ddd1ffa8c317937629',
        name: abacusS3BucketInfo.name('polygon', 1),
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: abacusS3BucketInfo.name('polygon', 1),
          region: abacusS3BucketInfo.region,
        },
      },
      {
        address: '0xc79c2e64c5051ac1c8df4a18df4f9ceb5a2ec767',
        name: abacusS3BucketInfo.name('polygon', 2),
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: abacusS3BucketInfo.name('polygon', 2),
          region: abacusS3BucketInfo.region,
        },
      },
      {
        address: '0x5201867Fc19c7104cA18B37d07C60bBfe8164197',
        readonly: true,
        name: 'ZKV-avalanche',
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: zkvS3BucketInfo.name('polygon'),
          region: zkvS3BucketInfo.region,
        },
      },
      {
        address: '0x4c055065DdD22DC874B3494Eb81FcDC1cDe9F57e',
        readonly: true,
        name: 'ZPLabs-pgon',
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: zplabsS3BucketInfo.name('pgon'),
          region: zplabsS3BucketInfo.region,
        },
      },
      {
        address: '0x7F20Ce70be969d763c2486Cf4AAe9f9a610FAb90',
        readonly: true,
        name: 'Fern-polygon',
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: fernS3BucketInfo.name('polygon'),
          region: fernS3BucketInfo.region,
        },
      },
    ],
  },
  bsc: {
    threshold: 3,
    validators: [
      {
        address: '0x013d01a570b5cfa19032c5176488b5824e225a6b',
        name: abacusS3BucketInfo.name('bsc', 0),
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: abacusS3BucketInfo.name('bsc', 0),
          region: abacusS3BucketInfo.region,
        },
      },
      {
        address: '0x507ee81c640daeed081ba013324e4e26bc893446',
        name: abacusS3BucketInfo.name('bsc', 1),
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: abacusS3BucketInfo.name('bsc', 1),
          region: abacusS3BucketInfo.region,
        },
      },
      {
        address: '0x27d47d7d5f14f76b5f800481499f4c1cb1eb54d9',
        name: abacusS3BucketInfo.name('bsc', 2),
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: abacusS3BucketInfo.name('bsc', 2),
          region: abacusS3BucketInfo.region,
        },
      },
      {
        address: '0x24f9004c3e02C8c354881685B221cAd8FaF4d9B0',
        readonly: true,
        name: 'ZKV-bsc',
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: zkvS3BucketInfo.name('bsc'),
          region: zkvS3BucketInfo.region,
        },
      },
      {
        address: '0x7e303daC8b6b24cac10b6f032e0eF373A1D80299',
        readonly: true,
        name: 'ZPLabs-bsc',
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: zplabsS3BucketInfo.name('bsc'),
          region: zplabsS3BucketInfo.region,
        },
      },
      {
        address: '0x3959Ba717d003326c280BFAd46516063eA653E03',
        readonly: true,
        name: 'Fern-bsc',
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: fernS3BucketInfo.name('bsc'),
          region: fernS3BucketInfo.region,
        },
      },
    ],
  },
  arbitrum: {
    threshold: 3,
    validators: [
      {
        address: '0x6289f913acc64c2e6baaa2b5175c7db35f98f62d',
        name: abacusS3BucketInfo.name('arbitrum', 0),
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: abacusS3BucketInfo.name('arbitrum', 0),
          region: abacusS3BucketInfo.region,
        },
      },
      {
        address: '0x3b989d35931f39d6c7b5bdd41eac3cad5c903af9',
        name: abacusS3BucketInfo.name('arbitrum', 1),
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: abacusS3BucketInfo.name('arbitrum', 1),
          region: abacusS3BucketInfo.region,
        },
      },
      {
        address: '0x38566cc4ceb264dfcb0022d9857ffe6c9da33881',
        name: abacusS3BucketInfo.name('arbitrum', 2),
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: abacusS3BucketInfo.name('arbitrum', 2),
          region: abacusS3BucketInfo.region,
        },
      },
      {
        address: '0xFF20DFeEE355Ef5a6d3C6dEe25AAB697ad3915a4',
        readonly: true,
        name: 'ZKV-arbitrum',
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: zkvS3BucketInfo.name('arbitrum'),
          region: zkvS3BucketInfo.region,
        },
      },
      {
        address: '0xb2e9B58B63c8676E583c2C0050bD46cecd8Ac8F3',
        readonly: true,
        name: 'ZPLabs-arbitrum',
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: zplabsS3BucketInfo.name('arbitrum'),
          region: zplabsS3BucketInfo.region,
        },
      },
      {
        address: '0xbE2A74888A9B4A2ef13826cD77747AB87aA4cBea',
        readonly: true,
        name: 'Fern-arbitrum',
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: fernS3BucketInfo.name('arbitrum'),
          region: fernS3BucketInfo.region,
        },
      },
    ],
  },
  optimism: {
    threshold: 3,
    validators: [
      {
        address: '0xcf2dcc3462c84420965501c1dda3d62dde08941d',
        name: abacusS3BucketInfo.name('optimism', 0),
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: abacusS3BucketInfo.name('optimism', 0),
          region: abacusS3BucketInfo.region,
        },
      },
      {
        address: '0x6dc8296b04206521afc57b868653203fa5585037',
        name: abacusS3BucketInfo.name('optimism', 1),
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: abacusS3BucketInfo.name('optimism', 1),
          region: abacusS3BucketInfo.region,
        },
      },
      {
        address: '0x95c27b4d029b11f7581f3f36b6575a14daba83d1',
        name: abacusS3BucketInfo.name('optimism', 2),
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: abacusS3BucketInfo.name('optimism', 2),
          region: abacusS3BucketInfo.region,
        },
      },
      {
        address: '0x8669a883652DBf8c47DECbC4ec8b137E54A5bEAF',
        readonly: true,
        name: 'ZKV-optimism',
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: zkvS3BucketInfo.name('optimism'),
          region: zkvS3BucketInfo.region,
        },
      },
      {
        address: '0x9D8a7F26B62fC4e481Be0F0736683d2822A8c354',
        readonly: true,
        name: 'ZPLabs-optimism',
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: zplabsS3BucketInfo.name('optimism'),
          region: zplabsS3BucketInfo.region,
        },
      },
      {
        address: '0x2DbFB54b2664C5f7D1Ca1935ff9AE360F1C45Bf5',
        readonly: true,
        name: 'Fern-optimism',
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: fernS3BucketInfo.name('optimism'),
          region: fernS3BucketInfo.region,
        },
      },
    ],
  },
  moonbeam: {
    threshold: 2,
    validators: [
      {
        address: '0x3da42c84aaf9d548feb219bfdf5fcb2217fbfb48',
        name: abacusS3BucketInfo.name('moonbeam', 0),
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: abacusS3BucketInfo.name('moonbeam', 0),
          region: abacusS3BucketInfo.region,
        },
      },
      {
        address: '0x65e94ffb6696403a5e6534cbfb6befebda6a0226',
        name: abacusS3BucketInfo.name('moonbeam', 1),
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: abacusS3BucketInfo.name('moonbeam', 1),
          region: abacusS3BucketInfo.region,
        },
      },
      {
        address: '0x1bf2f7e9fdfe832c5d05f94dd66dc8704ebdc581',
        name: abacusS3BucketInfo.name('moonbeam', 2),
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: abacusS3BucketInfo.name('moonbeam', 2),
          region: abacusS3BucketInfo.region,
        },
      },
      {
        address: '0xb17F9168dAa96dd5509919785FB03647ffcd5b5A',
        readonly: true,
        name: 'Fern-moonbeam',
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: fernS3BucketInfo.name('moonbeam'),
          region: fernS3BucketInfo.region,
        },
      },
    ],
  },
};
