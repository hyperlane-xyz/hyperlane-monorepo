import { ChainMap, CoreConfig } from '@hyperlane-xyz/sdk';

import { MainnetChains } from './chains';

export const core: ChainMap<MainnetChains, CoreConfig> = {
  celo: {
    owner: '0x1DE69322B55AC7E0999F8e7738a1428C8b130E4d',
    multisigModule: {
      validators: [
        '0x8784f09c2cfb70329b936a3b75eb61c41b467b65',
        '0x36daf0ac1f4feb22440ea0834308e0d3ae409139',
        '0x3fc9689d60e3fe78a624eeb5d9d3452b272cb1a4',
        // zk validator
        '0xd8B404ad70A1682aaF457d4918F7b506035262D3',
        // zeeprime
        '0x1ba04e4df7DF9D736543cC9A8D6f61278EA140ec',
      ],
      threshold: 3,
    },
  },
  ethereum: {
    owner: '0x12C5AB61Fe17dF9c65739DBa73dF294708f78d23',
    multisigModule: {
      validators: [
        '0x7c1d96c9e72c41b84d74095dc2e72b979e933904',
        '0xd82ebbd1ef3d75b21f33a36a5c250865d97b9ca1',
        '0x333f37f29c6bca607084a75abbe66fd268f585cb',
        // zk validator
        '0x1946782598328C6D5e1CD1076d37Feab680ad9D2',
        // zeeprime
        '0xaDF418C044e857C174e70B3a1df7454B55ee258F',
      ],
      threshold: 3,
    },
  },
  avalanche: {
    owner: '0xDF9B28B76877f1b1B4B8a11526Eb7D8D7C49f4f3',
    multisigModule: {
      validators: [
        '0x1353b91e2b256ca0a283504b02ae3c69374fb105',
        '0x9c6028433b8a0af8530399e57433d2b3b5379b55',
        '0x5344d1cccaa4cb189ec7c2d30bdd9eb202aeb738',
        // zk validator
        '0x1E1086F3E6F2F5762AF54B8167cdE934186cbAf9',
        // zeeprime
        '0xd0b24bb03d2c244c3B1cA78c21A793c9e6ff4d87',
      ],
      threshold: 3,
    },
  },
  polygon: {
    owner: '0x0D195469f76146F6ae3De8fc887e0f0DFBA691e7',
    multisigModule: {
      validators: [
        '0xff198cae21069d865b142f2b9e798d3b299b8df6',
        '0x577ae23f23a4b81c5c7e26ddd1ffa8c317937629',
        '0xc79c2e64c5051ac1c8df4a18df4f9ceb5a2ec767',
        // zk validator
        '0x5201867Fc19c7104cA18B37d07C60bBfe8164197',
        // zeeprime
        '0x4c055065DdD22DC874B3494Eb81FcDC1cDe9F57e',
      ],
      threshold: 3,
    },
  },
  bsc: {
    owner: '0xA0d3dcB9d61Fba32cc02Ad63983e101b29E2f28a',
    multisigModule: {
      validators: [
        '0x013d01a570b5cfa19032c5176488b5824e225a6b',
        '0x507ee81c640daeed081ba013324e4e26bc893446',
        '0x27d47d7d5f14f76b5f800481499f4c1cb1eb54d9',
        // zk validator
        '0x24f9004c3e02C8c354881685B221cAd8FaF4d9B0',
        // zeeprime
        '0x7e303daC8b6b24cac10b6f032e0eF373A1D80299',
      ],
      threshold: 3,
    },
  },
  arbitrum: {
    owner: '0xbA47E1b575980B7D1b1508cc48bE1Df4EE508111',
    multisigModule: {
      validators: [
        '0x6289f913acc64c2e6baaa2b5175c7db35f98f62d',
        '0x3b989d35931f39d6c7b5bdd41eac3cad5c903af9',
        '0x38566cc4ceb264dfcb0022d9857ffe6c9da33881',
        // zk validator
        '0xFF20DFeEE355Ef5a6d3C6dEe25AAB697ad3915a4',
        // zeeprime
        '0xb2e9B58B63c8676E583c2C0050bD46cecd8Ac8F3',
      ],
      threshold: 3,
    },
  },
  optimism: {
    owner: '0xb523CFAf45AACF472859f8B793CB0BFDB16bD257',
    multisigModule: {
      validators: [
        '0xcf2dcc3462c84420965501c1dda3d62dde08941d',
        '0x6dc8296b04206521afc57b868653203fa5585037',
        '0x95c27b4d029b11f7581f3f36b6575a14daba83d1',
        // zk validator
        '0x8669a883652DBf8c47DECbC4ec8b137E54A5bEAF',
        // zeeprime
        '0x9D8a7F26B62fC4e481Be0F0736683d2822A8c354',
      ],
      threshold: 3,
    },
  },
  moonbeam: {
    owner: '0xF0cb1f968Df01fc789762fddBfA704AE0F952197',
    multisigModule: {
      validators: [
        '0x3da42c84aaf9d548feb219bfdf5fcb2217fbfb48',
        '0x65e94ffb6696403a5e6534cbfb6befebda6a0226',
        '0x1bf2f7e9fdfe832c5d05f94dd66dc8704ebdc581',
      ],
      threshold: 2,
    },
  },
};
