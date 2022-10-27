import { ChainMap, CoreConfig } from '@hyperlane-xyz/sdk';

import { TestnetChains } from './chains';

export const core: ChainMap<TestnetChains, CoreConfig> = {
  alfajores: {
    multisigModule: {
      validators: [
        '0x7716860b2be4079137dc21533ac6d26a99d76e83',
        '0xb476f4d55d640e9a9a43b9bdf471dc06e4508bbd',
        '0xda63918dd964c0d7c59a04062bffe0fba8edaf1c',
        '0xebb97602f6acd259ecec9f9fa811aed5b35981ab',
      ],
      threshold: 3,
    },
  },
  fuji: {
    multisigModule: {
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
    multisigModule: {
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
    multisigModule: {
      validators: [
        '0xa7959b2f03f6fc77c9592547bd0ca12fe2c7bf8f',
        '0xc78c1198d4224103dbb0e365286c3403c54fbbf6',
        '0x453da5c773e829aa4f61be9bad64aa5eaaef000a',
        '0x625027ffb9b9b9ba083d267e5b7756af33e636a0',
      ],
      threshold: 3,
    },
  },
  goerli: {
    multisigModule: {
      validators: [
        '0x89687c99ffb56f329915f80a858a45fccc2b7402',
        '0xca25781e7c0067a71d09b991bd7b37ab1168c76c',
        '0xcbf6cde516f43a7b5346f48319b016b0e05cb7af',
      ],
      threshold: 2,
    },
  },
  moonbasealpha: {
    multisigModule: {
      validators: [
        '0x0cc08084a0a7cc61102e800204851627732f8aa4',
        '0xd151f6ca08e632eb7abd5afcb49c47d6a9b67a54',
        '0x8d41c4cb699a408f9b5c69156eaa12ce76346b16',
      ],
      threshold: 2,
    },
  },
};
