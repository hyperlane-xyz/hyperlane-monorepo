import { ChainMap, CoreConfig } from '@abacus-network/sdk';

import { MainnetChains } from './chains';

export const core: ChainMap<MainnetChains, CoreConfig> = {
  celo: {
    owner: '0x1DE69322B55AC7E0999F8e7738a1428C8b130E4d',
    validatorManager: {
      validators: [
        '0x8784f09c2cfb70329b936a3b75eb61c41b467b65',
        '0x36daf0ac1f4feb22440ea0834308e0d3ae409139',
        '0x3fc9689d60e3fe78a624eeb5d9d3452b272cb1a4',
      ],
      threshold: 2,
    },
  },
  ethereum: {
    owner: '0x12C5AB61Fe17dF9c65739DBa73dF294708f78d23',
    validatorManager: {
      validators: [
        '0x7c1d96c9e72c41b84d74095dc2e72b979e933904',
        '0xd82ebbd1ef3d75b21f33a36a5c250865d97b9ca1',
        '0x333f37f29c6bca607084a75abbe66fd268f585cb',
      ],
      threshold: 2,
    },
  },
  avalanche: {
    owner: '0xDF9B28B76877f1b1B4B8a11526Eb7D8D7C49f4f3',
    validatorManager: {
      validators: [
        '0x1353b91e2b256ca0a283504b02ae3c69374fb105',
        '0x9c6028433b8a0af8530399e57433d2b3b5379b55',
        '0x5344d1cccaa4cb189ec7c2d30bdd9eb202aeb738',
      ],
      threshold: 2,
    },
  },
  polygon: {
    owner: '0x0D195469f76146F6ae3De8fc887e0f0DFBA691e7',
    validatorManager: {
      validators: [
        '0xff198cae21069d865b142f2b9e798d3b299b8df6',
        '0x577ae23f23a4b81c5c7e26ddd1ffa8c317937629',
        '0xc79c2e64c5051ac1c8df4a18df4f9ceb5a2ec767',
      ],
      threshold: 2,
    },
  },
  bsc: {
    owner: '0xA0d3dcB9d61Fba32cc02Ad63983e101b29E2f28a',
    validatorManager: {
      validators: [
        '0x013d01a570b5cfa19032c5176488b5824e225a6b',
        '0x507ee81c640daeed081ba013324e4e26bc893446',
        '0x27d47d7d5f14f76b5f800481499f4c1cb1eb54d9',
      ],
      threshold: 2,
    },
  },
  arbitrum: {
    owner: '0xbA47E1b575980B7D1b1508cc48bE1Df4EE508111',
    validatorManager: {
      validators: [
        '0x6289f913acc64c2e6baaa2b5175c7db35f98f62d',
        '0x3b989d35931f39d6c7b5bdd41eac3cad5c903af9',
        '0x38566cc4ceb264dfcb0022d9857ffe6c9da33881',
      ],
      threshold: 2,
    },
  },
  optimism: {
    owner: '0xb523CFAf45AACF472859f8B793CB0BFDB16bD257',
    validatorManager: {
      validators: [
        '0xcf2dcc3462c84420965501c1dda3d62dde08941d',
        '0x6dc8296b04206521afc57b868653203fa5585037',
        '0x95c27b4d029b11f7581f3f36b6575a14daba83d1',
      ],
      threshold: 2,
    },
  },
};
