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
    threshold: 3,
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
        address: '0x3bc014bafa43f93d534aed34f750997cdffcf007',
        name: 'dsrv-celo-v2',
        readonly: true,
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: 'dsrv-hyperlane-v2-validator-signatures-validator4-celo',
          region: 'eu-central-1',
        },
      },
      {
        address: '0xd79d506d741fa735938f7b7847a926e34a6fe6b0',
        name: 'everstake-celo-v2',
        readonly: true,
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: 'hyperlane-v2-validator-signatures-everstake-celo',
          region: 'us-east-2',
        },
      },
      {
        address: '0xe4a258bc61e65914c2a477b2a8a433ab4ebdf44b',
        name: 'ZPLabs-celo-v2',
        readonly: true,
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: 'hyperlane-validator-signatures-zplabs-celo',
          region: 'eu-central-1',
        },
      },
    ],
  },
  ethereum: {
    threshold: 3,
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
        address: '0x84cb373148ef9112b277e68acf676fefa9a9a9a0',
        name: 'dsrv-ethereum-v2',
        readonly: true,
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: 'dsrv-hyperlane-v2-validator-signatures-validator1-ethereum',
          region: 'eu-central-1',
        },
      },
      {
        address: '0x0d860c2b28bec3af4fd3a5997283e460ff6f2789',
        name: 'everstake-ethereum-v2',
        readonly: true,
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: 'hyperlane-v2-validator-signatures-everstake-ethereum',
          region: 'us-east-2',
        },
      },
      {
        address: '0xd4c1211f0eefb97a846c4e6d6589832e52fc03db',
        name: 'ZPLabs-ethereum-v2',
        readonly: true,
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: 'hyperlane-validator-signatures-zplabs-eth',
          region: 'eu-central-1',
        },
      },
    ],
  },
  avalanche: {
    threshold: 3,
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
        address: '0xb6004433fb04f643e2d48ae765c0e7f890f0bc0c',
        name: 'dsrv-avalanche-v2',
        readonly: true,
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: 'dsrv-hyperlane-v2-validator-signatures-validator2-avalanche',
          region: 'eu-central-1',
        },
      },
      {
        address: '0xa07e213e0985b21a6128e6c22ab5fb73948b0cc2',
        name: 'everstake-avalanche-v2',
        readonly: true,
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: 'hyperlane-v2-validator-signatures-everstake-avalanche',
          region: 'us-east-2',
        },
      },
      {
        address: '0x73853ed9a5f6f2e4c521970a94d43469e3cdaea6',
        name: 'ZPLabs-avalanche-v2',
        readonly: true,
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: 'hyperlane-validator-signatures-zplabs-avax',
          region: 'eu-central-1',
        },
      },
    ],
  },
  polygon: {
    threshold: 3,
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
        address: '0x009fb042d28944017177920c1d40da02bfebf474',
        name: 'dsrv-polygon-v2',
        readonly: true,
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: 'dsrv-hyperlane-v2-validator-signatures-validator6-polygon',
          region: 'eu-central-1',
        },
      },
      {
        address: '0xba4b13e23705a5919c1901150d9697e8ffb3ea71',
        name: 'everstake-polygon-v2',
        readonly: true,
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: 'hyperlane-v2-validator-signatures-everstake-polygon',
          region: 'us-east-2',
        },
      },
      {
        address: '0x2faa4071b718972f9b4beec1d8cbaa4eb6cca6c6',
        name: 'ZPLabs-polygon-v2',
        readonly: true,
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: 'hyperlane-validator-signatures-zplabs-pgon',
          region: 'eu-central-1',
        },
      },
    ],
  },
  bsc: {
    threshold: 3,
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
        address: '0xefe34eae2bca1846b895d2d0762ec21796aa196a',
        name: 'dsrv-bsc-v2',
        readonly: true,
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: 'dsrv-hyperlane-v2-validator-signatures-validator3-bsc',
          region: 'eu-central-1',
        },
      },
      {
        address: '0x662674e80e189b0861d6835c287693f50ee0c2ff',
        name: 'everstake-bsc-v2',
        readonly: true,
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: 'hyperlane-v2-validator-signatures-everstake-bsc',
          region: 'us-east-2',
        },
      },
      {
        address: '0x8a0f59075af466841808c529624807656309c9da',
        name: 'ZPLabs-bsc-v2',
        readonly: true,
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: 'hyperlane-validator-signatures-zplabs-bsc',
          region: 'eu-central-1',
        },
      },
    ],
  },
  arbitrum: {
    threshold: 3,
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
        address: '0xd839424e2e5ace0a81152298dc2b1e3bb3c7fb20',
        name: 'dsrv-arbitrum-v2',
        readonly: true,
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: 'dsrv-hyperlane-v2-validator-signatures-validator7-arbitrum',
          region: 'eu-central-1',
        },
      },
      {
        address: '0xb8085c954b75b7088bcce69e61d12fcef797cd8d',
        name: 'everstake-arbitrum-v2',
        readonly: true,
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: 'hyperlane-v2-validator-signatures-everstake-arbitrum',
          region: 'us-east-2',
        },
      },
      {
        address: '0x9856dcb10fd6e5407fa74b5ab1d3b96cc193e9b7',
        name: 'ZPLabs-arbitrum-v2',
        readonly: true,
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: 'hyperlane-validator-signatures-zplabs-arbitrum',
          region: 'eu-central-1',
        },
      },
    ],
  },
  optimism: {
    threshold: 3,
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
        address: '0x9c10bbe8efa03a8f49dfdb5c549258e3a8dca097',
        name: 'dsrv-optimism-v2',
        readonly: true,
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: 'dsrv-hyperlane-v2-validator-signatures-validator8-optimism',
          region: 'eu-central-1',
        },
      },
      {
        address: '0x62144d4a52a0a0335ea5bb84392ef9912461d9dd',
        name: 'everstake-optimism-v2',
        readonly: true,
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: 'hyperlane-v2-validator-signatures-everstake-optimism',
          region: 'us-east-2',
        },
      },
      {
        address: '0xaff4718d5d637466ad07441ee3b7c4af8e328dbd',
        name: 'ZPLabs-optimism-v2',
        readonly: true,
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: 'hyperlane-validator-signatures-zplabs-optimism',
          region: 'eu-central-1',
        },
      },
    ],
  },
  moonbeam: {
    threshold: 3,
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
        address: '0x9509c8cf0a06955f27342262af501b74874e98fb',
        name: 'dsrv-moonbeam-v2',
        readonly: true,
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: 'dsrv-hyperlane-v2-validator-signatures-validator5-moonbeam',
          region: 'eu-central-1',
        },
      },
      {
        address: '0xb7113c999e4d587b162dd1a28c73f3f51c6bdcdc',
        name: 'everstake-moonbeam-v2',
        readonly: true,
        checkpointSyncer: {
          type: CheckpointSyncerType.S3,
          bucket: 'hyperlane-v2-validator-signatures-everstake-moonbeam',
          region: 'us-east-2',
        },
      },
    ],
  },
};
