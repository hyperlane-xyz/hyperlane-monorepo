import { ChainMap, CoreConfig } from '@hyperlane-xyz/sdk';

import { TestnetChains } from './chains';

export const core: ChainMap<TestnetChains, CoreConfig> = {
  alfajores: {
    multisigIsm: {
      validators: [
        '0xe6072396568e73ce6803b12b7e04164e839f1e54',
        '0x9f177f51289b22515f41f95872e1511391b8e105',
        '0x15f77400845eb1c971ad08de050861d5508cad6c',
      ],
      threshold: 2,
    },
  },
  fuji: {
    multisigIsm: {
      validators: [
        '0x9fa19ead5ec76e437948b35e227511b106293c40',
        '0x227e7d6507762ece0c94678f8c103eff9d682476',
        '0x2379e43740e4aa4fde48cf4f00a3106df1d8420d',
      ],
      threshold: 2,
    },
  },
  mumbai: {
    multisigIsm: {
      validators: [
        '0x0a664ea799447da6b15645cf8b9e82072a68343f',
        '0x6ae6f12929a960aba24ba74ea310e3d37d0ac045',
        '0x51f70c047cd73bc7873273707501568857a619c4',
      ],
      threshold: 2,
    },
  },
  bsctestnet: {
    multisigIsm: {
      validators: [
        '0x23338c8714976dd4a57eaeff17cbd26d7e275c08',
        '0x85a618d7450ebc37e0d682371f08dac94eec7a76',
        '0x95b76562e4ba1791a27ba4236801271c9115b141',
      ],
      threshold: 2,
    },
  },
  goerli: {
    multisigIsm: {
      validators: [
        '0x95b76562e4ba1791a27ba4236801271c9115b141',
        '0xa33020552a21f35e75bd385c6ab95c3dfa82d930',
        '0x0bba4043ff242f8bf3f39bafa8930a84d644d947',
      ],
      threshold: 2,
    },
  },
  moonbasealpha: {
    multisigIsm: {
      validators: [
        '0x890c2aeac157c3f067f3e42b8afc797939c59a32',
        '0x1b06d6fe69b972ed7420c83599d5a5c0fc185904',
        '0xe70b85206a968a99a597581f0fa09c99e7681093',
      ],
      threshold: 2,
    },
  },
  optimismgoerli: {
    multisigIsm: {
      validators: [
        '0xbb8d77eefbecc55db6e5a19b0fc3dc290776f189',
        '0x69792508b4ddaa3ca52241ccfcd1e0b119a1ee65',
        '0x11ddb46c6b653e0cdd7ad5bee32ae316e18f8453',
      ],
      threshold: 2,
    },
  },
  arbitrumgoerli: {
    multisigIsm: {
      validators: [
        '0xce798fa21e323f6b24d9838a10ffecdefdfc4f30',
        '0xa792d39dca4426927e0f00c1618d61c9cb41779d',
        '0xdf181fcc11dfac5d01467e4547101a856dd5aa04',
      ],
      threshold: 2,
    },
  },
  // Ignore for now
  // zksync2testnet: {
  //   multisigIsm: {
  //     validators: [
  //       '0x9476169618f6642413b77549c10dda7a253fb2be',
  //       '0x96f9782038cfb4e09c98fbb07627e7c5f7afabcb',
  //       '0xf08e3b66c34f101901e6a41cd6f36ce14653fe6b',
  //     ],
  //     threshold: 2,
  //   },
  // },
};
