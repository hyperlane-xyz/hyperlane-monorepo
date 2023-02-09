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
        '0x6aea63b0be4679c1385c26a92a3ff8aa6a8379f2', // staked
        '0xc0085e1a49bcc69e534272adb82c74c0e007e1ca', // zkv
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
        '0x600c90404d5c9df885404d2cc5350c9b314ea3a2', // staked
        '0x892DC66F5B2f8C438E03f6323394e34A9C24F2D6', // zkv
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
        '0xbd2e136cda02ba627ca882e49b184cbe976081c8', // staked
        '0x1418126f944a44dad9edbab32294a8c890e7a9e3', // zkv
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
        '0x5ae9b0f833dfe09ef455562a1f603f1634504dd6', // staked
        '0x6a163d312f7352a95c9b81dca15078d5bf77a442', // zkv
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
        '0xdd2ff046ccd748a456b4757a73d47f165469669f', // staked
        '0x034c4924c30ec4aa1b7f3ad58548988f0971e1bf', // zkv
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
        '0x505dff4e0827aa5065f5e001db888e0569d46490', // staked
        '0x25c6779d4610f940bf2488732e10bcffb9d36f81', // ZKV
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
        '0xc64d1efeab8ae222bc889fe669f75d21b23005d9', // staked
        '0xfa174eb2b4921bb652bc1ada3e8b00e7e280bf3c', // ZKV
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
        '0x26725501597d47352a23cd26f122709f69ad53bc', // staked
      ],
    },
  },
  gnosis: {
    owner: '0x36b0AA0e7d04e7b825D7E409FEa3c9A3d57E4C22',
    multisigIsm: {
      threshold: 2,
      validators: [
        '0xd0529ec8df08d0d63c0f023786bfa81e4bb51fd6',
        '0x829d6ec129bc7187fb1ed161adcf7939fe0c515f',
        '0x00009f8935e94bfe52ab3441df3526ab7cc38db1',
      ],
    },
  },
};
