import { ChainMap, CoreConfig } from '@hyperlane-xyz/sdk';

import { MainnetChains } from './chains';

export const core: ChainMap<MainnetChains, CoreConfig> = {
  celo: {
    owner: '0x1DE69322B55AC7E0999F8e7738a1428C8b130E4d',
    multisigIsm: {
      threshold: 2,
      validators: [
        '0x1f20274b1210046769d48174c2f0e7c25ca7d5c5',
        '0xef6db730fca69e1438c9ea19fefb3060901a8dfa',
        '0x573b59ee4c3a20132e5a710530d1c1589290f63a',
      ],
    },
  },
  ethereum: {
    owner: '0x12C5AB61Fe17dF9c65739DBa73dF294708f78d23',
    multisigIsm: {
      threshold: 2,
      validators: [
        '0x4c327ccb881a7542be77500b2833dc84c839e7b7',
        '0xf4db15933d204b38c17cc027c3f1c9f3c5da9a7c',
        '0xdbaa55951204f78c47dc5687783d624fd8d8426a',
      ],
    },
  },
  avalanche: {
    owner: '0xDF9B28B76877f1b1B4B8a11526Eb7D8D7C49f4f3',
    multisigIsm: {
      threshold: 2,
      validators: [
        '0xa7aa52623fe3d78c343008c95894be669e218b8d',
        '0x37a2c96f82dc6c7fa290d858d02ea5d1e0ce86ff',
        '0x37417806864e822b0f3df8310f53acd3bbd4294a',
      ],
    },
  },
  polygon: {
    owner: '0x0D195469f76146F6ae3De8fc887e0f0DFBA691e7',
    multisigIsm: {
      threshold: 2,
      validators: [
        '0x59a001c3451e7f9f3b4759ea215382c1e9aa5fc1',
        '0x3e549171d0954194442d6b16fa780d1ec83072fd',
        '0x6ec07957adecd7f95371040b54dfedcd57115825',
      ],
    },
  },
  bsc: {
    owner: '0xA0d3dcB9d61Fba32cc02Ad63983e101b29E2f28a',
    multisigIsm: {
      threshold: 2,
      validators: [
        '0xcc84b1eb711e5076b2755cf4ad1d2b42c458a45e',
        '0x62229ff38de88464fd49d79bea0cdc48ebdebd79',
        '0x4baf7993f2ce2447b61384f5b8b90304913af4ea',
      ],
    },
  },
  arbitrum: {
    owner: '0xbA47E1b575980B7D1b1508cc48bE1Df4EE508111',
    multisigIsm: {
      threshold: 2,
      validators: [
        '0xbcb815f38d481a5eba4d7ac4c9e74d9d0fc2a7e7',
        '0xa0d92ee2156f74b18c6d116527e3c9001f123dac',
        '0x6413a166851cdf1501dcf5d23cddf0c9ad9bfe5b',
      ],
    },
  },
  optimism: {
    owner: '0xb523CFAf45AACF472859f8B793CB0BFDB16bD257',
    multisigIsm: {
      threshold: 2,
      validators: [
        '0x9f2296d5cfc6b5176adc7716c7596898ded13d35',
        '0xd2d9baadd72d3a9983b06ba5f103856e5fea63cb',
        '0x2ef8ad572738c3371e2e5652d34f7e66f3f47d8c',
      ],
    },
  },
  moonbeam: {
    owner: '0xF0cb1f968Df01fc789762fddBfA704AE0F952197',
    multisigIsm: {
      threshold: 2,
      validators: [
        '0x237243d32d10e3bdbbf8dbcccc98ad44c1c172ea',
        '0x02424d4222f35c04da62a2f2dea8c778030bb324',
        '0x618599e44109068018ae5f06fa142a80721945e3',
      ],
    },
  },
};
