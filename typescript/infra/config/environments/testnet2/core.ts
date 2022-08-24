import { ChainMap, CoreConfig } from '@abacus-network/sdk';

import { TestnetChains } from './chains';

export const core: ChainMap<TestnetChains, CoreConfig> = {
  alfajores: {
    validatorManager: {
      validators: [
        '0x7716860b2be4079137dc21533ac6d26a99d76e83',
        '0xb476f4d55d640e9a9a43b9bdf471dc06e4508bbd',
        '0xda63918dd964c0d7c59a04062bffe0fba8edaf1c',
        '0xebb97602f6acd259ecec9f9fa811aed5b35981ab',
      ],
      threshold: 3,
    },
  },
  kovan: {
    validatorManager: {
      validators: [
        '0x1ee94e776cbe4bf74d2f80dae551758efbc21887',
        '0xf2af10d9fd08eead8c6724a7feb679b5c900a38c',
        '0xf3b7d58acfbff1fd64f173607101f611034e4f5f',
        '0xff94c7660e857ba3f35ee248ae461feea266a504',
      ],
      threshold: 3,
    },
  },
  fuji: {
    validatorManager: {
      validators: [
        '0xc0ab1f3e3317521a92462927849b8844cf408b09',
        '0xefde1812fea378c645d8e7984ce985b228cd1beb',
        '0xb17f4f63e09c0a9207e2f008977e3f5b5584875d',
        '0x6f6a95ad0348454a5d4c3029cd3243acecd1cf8b',
      ],
      threshold: 3,
    },
  },
  mumbai: {
    validatorManager: {
      validators: [
        '0x0f1a231cb2ecc5f26696c433d76fe59521a227e0',
        '0x3e527087fc60752695d9a4f77a6324bbae3940b1',
        '0x62afdaed75bdfd94e0d6103eb0333669d4f5d232',
        '0xa12b4612d00f682276c994040a3f37d0d6f343c4',
      ],
      threshold: 3,
    },
  },
  bsctestnet: {
    validatorManager: {
      validators: [
        '0xa7959b2f03f6fc77c9592547bd0ca12fe2c7bf8f',
        '0xc78c1198d4224103dbb0e365286c3403c54fbbf6',
        '0x453da5c773e829aa4f61be9bad64aa5eaaef000a',
        '0x625027ffb9b9b9ba083d267e5b7756af33e636a0',
      ],
      threshold: 3,
    },
  },
  arbitrumrinkeby: {
    validatorManager: {
      validators: [
        '0xf5a871bcb9d6dfa2d3519caf396e7ab3c5a7a2ee',
        '0xa6773fc38b023a512106e104a4f2cad2e68d802d',
        '0x42f7b994720463eff351186f83d683efa5e2ed49',
        '0x49649a8708f45171f5439ec71dc83baafd98b01c',
      ],
      threshold: 3,
    },
  },
  optimismkovan: {
    validatorManager: {
      validators: [
        '0xef0d7bbb9c71fef7dc148722060afd78d0ff09d8',
        '0x8e64ff3936aeadacc23a76cf2c96466927ed758f',
        '0x13a3cd962ce99d6a6509f8d5b63a4498db329323',
        '0x85f8286a8ee13aecc227e99b75375826cdb512dd',
      ],
      threshold: 3,
    },
  },
};
