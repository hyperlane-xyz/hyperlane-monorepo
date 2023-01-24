import { ChainMap, CoreConfig } from '@hyperlane-xyz/sdk';

import { MainnetChains } from './chains';

export const core: ChainMap<MainnetChains, CoreConfig> = {
  celo: {
    owner: '0x1DE69322B55AC7E0999F8e7738a1428C8b130E4d',
    multisigIsm: {
      threshold: 3,
      validators: [
        '0x1f20274b1210046769d48174c2f0e7c25ca7d5c5',
        '0xef6db730fca69e1438c9ea19fefb3060901a8dfa',
        '0x3bc014bafa43f93d534aed34f750997cdffcf007',
        '0xd79d506d741fa735938f7b7847a926e34a6fe6b0',
        '0xe4a258bc61e65914c2a477b2a8a433ab4ebdf44b',
      ],
    },
  },
  ethereum: {
    owner: '0x12C5AB61Fe17dF9c65739DBa73dF294708f78d23',
    multisigIsm: {
      threshold: 3,
      validators: [
        '0x4c327ccb881a7542be77500b2833dc84c839e7b7',
        '0xf4db15933d204b38c17cc027c3f1c9f3c5da9a7c',
        '0x84cb373148ef9112b277e68acf676fefa9a9a9a0',
        '0x0d860c2b28bec3af4fd3a5997283e460ff6f2789',
        '0xd4c1211f0eefb97a846c4e6d6589832e52fc03db',
      ],
    },
  },
  avalanche: {
    owner: '0xDF9B28B76877f1b1B4B8a11526Eb7D8D7C49f4f3',
    multisigIsm: {
      threshold: 3,
      validators: [
        '0xa7aa52623fe3d78c343008c95894be669e218b8d',
        '0x37a2c96f82dc6c7fa290d858d02ea5d1e0ce86ff',
        '0xb6004433fb04f643e2d48ae765c0e7f890f0bc0c',
        '0xa07e213e0985b21a6128e6c22ab5fb73948b0cc2',
        '0x73853ed9a5f6f2e4c521970a94d43469e3cdaea6',
      ],
    },
  },
  polygon: {
    owner: '0x0D195469f76146F6ae3De8fc887e0f0DFBA691e7',
    multisigIsm: {
      threshold: 3,
      validators: [
        '0x59a001c3451e7f9f3b4759ea215382c1e9aa5fc1',
        '0x3e549171d0954194442d6b16fa780d1ec83072fd',
        '0x009fb042d28944017177920c1d40da02bfebf474',
        '0xba4b13e23705a5919c1901150d9697e8ffb3ea71',
        '0x2faa4071b718972f9b4beec1d8cbaa4eb6cca6c6',
      ],
    },
  },
  bsc: {
    owner: '0xA0d3dcB9d61Fba32cc02Ad63983e101b29E2f28a',
    multisigIsm: {
      threshold: 3,
      validators: [
        '0xcc84b1eb711e5076b2755cf4ad1d2b42c458a45e',
        '0x62229ff38de88464fd49d79bea0cdc48ebdebd79',
        '0xefe34eae2bca1846b895d2d0762ec21796aa196a',
        '0x662674e80e189b0861d6835c287693f50ee0c2ff',
        '0x8a0f59075af466841808c529624807656309c9da',
      ],
    },
  },
  arbitrum: {
    owner: '0xbA47E1b575980B7D1b1508cc48bE1Df4EE508111',
    multisigIsm: {
      threshold: 3,
      validators: [
        '0xbcb815f38d481a5eba4d7ac4c9e74d9d0fc2a7e7',
        '0xa0d92ee2156f74b18c6d116527e3c9001f123dac',
        '0xd839424e2e5ace0a81152298dc2b1e3bb3c7fb20',
        '0xb8085c954b75b7088bcce69e61d12fcef797cd8d',
        '0x9856dcb10fd6e5407fa74b5ab1d3b96cc193e9b7',
      ],
    },
  },
  optimism: {
    owner: '0xb523CFAf45AACF472859f8B793CB0BFDB16bD257',
    multisigIsm: {
      threshold: 3,
      validators: [
        '0x9f2296d5cfc6b5176adc7716c7596898ded13d35',
        '0xd2d9baadd72d3a9983b06ba5f103856e5fea63cb',
        '0x9c10bbe8efa03a8f49dfdb5c549258e3a8dca097',
        '0x62144d4a52a0a0335ea5bb84392ef9912461d9dd',
        '0xaff4718d5d637466ad07441ee3b7c4af8e328dbd',
      ],
    },
  },
  moonbeam: {
    owner: '0xF0cb1f968Df01fc789762fddBfA704AE0F952197',
    multisigIsm: {
      threshold: 3,
      validators: [
        '0x237243d32d10e3bdbbf8dbcccc98ad44c1c172ea',
        '0x02424d4222f35c04da62a2f2dea8c778030bb324',
        '0x9509c8cf0a06955f27342262af501b74874e98fb',
        '0xb7113c999e4d587b162dd1a28c73f3f51c6bdcdc',
      ],
    },
  },
};
