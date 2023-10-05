import { ChainMap, MultisigConfig } from '@hyperlane-xyz/sdk';

export const rcMultisigIsmConfigs: ChainMap<MultisigConfig> = {
  // ----------------- Mainnets -----------------
  celo: {
    threshold: 1,
    validators: [
      '0xe7a82e210f512f8e9900d6bc2acbf7981c63e66e', // abacus
    ],
  },
  ethereum: {
    threshold: 1,
    validators: [
      '0xaea1adb1c687b061e5b60b9da84cb69e7b5fab44', // abacus
    ],
  },
  avalanche: {
    threshold: 1,
    validators: [
      '0x706976391e23dea28152e0207936bd942aba01ce', // abacus
    ],
  },
  polygon: {
    threshold: 1,
    validators: [
      '0xef372f6ff7775989b3ac884506ee31c79638c989', // abacus
    ],
  },
  bsc: {
    threshold: 1,
    validators: [
      '0x0823081031a4a6f97c6083775c191d17ca96d0ab', // abacus
    ],
  },
  arbitrum: {
    threshold: 1,
    validators: [
      '0x1a95b35fb809d57faf1117c1cc29a6c5df289df1', // abacus
    ],
  },
  optimism: {
    threshold: 1,
    validators: [
      '0x60e938bf280bbc21bacfd8bf435459d9003a8f98', // abacus
    ],
  },
  moonbeam: {
    threshold: 1,
    validators: [
      '0x0df7140811e309dc69638352545151ebb9d5e0fd', // abacus
    ],
  },
  gnosis: {
    threshold: 1,
    validators: [
      '0x15f48e78092a4f79febface509cfd76467c6cdbb', // abacus
    ],
  },
  // ----------------- Testnets -----------------
  alfajores: {
    threshold: 1,
    validators: ['0xace978aaa61d9ee44fe3ab147fd227e0e66b8909'],
  },
  basegoerli: {
    threshold: 1,
    validators: ['0x81983e03363351b63848867bd76687cc80b9ff37'],
  },
  fuji: {
    threshold: 1,
    validators: ['0xfc419f9ba3c56c55e28844ade491d428f5a77d55'],
  },
  chiado: {
    threshold: 1,
    validators: ['0x7572ffd8af1abc02cc1d234ac750d387fd6768a0'],
  },
  lineagoerli: {
    threshold: 1,
    validators: ['0x52e2c6db923124e646011d172dea644e1cafe583'],
  },
  mumbai: {
    threshold: 1,
    validators: ['0x7fc2981964427f09e317eda559f506bfd37f1ccb'],
  },
  bsctestnet: {
    threshold: 1,
    validators: ['0x6353c7402626054c824bd0eca721f82b725e2b4d'],
  },
  goerli: {
    threshold: 1,
    validators: ['0x6b32af7592948cbec6893363f77c08252d0ce0d7'],
  },
  scrollsepolia: {
    threshold: 1,
    validators: ['0x50d939d66f114350f322eb8b2e9f01fbc401d4c9'],
  },
  sepolia: {
    threshold: 1,
    validators: ['0x49f253c0dab33be1573d6c2769b3d9e584d91f82'],
  },
  moonbasealpha: {
    threshold: 1,
    validators: ['0x376260b40b2ba2100890f27de1eb18a2774f54d1'],
  },
  optimismgoerli: {
    threshold: 1,
    validators: ['0xed4cf9bf144457c927d7a39613c812c53f296283'],
  },
  arbitrumgoerli: {
    threshold: 1,
    validators: ['0x869f67e89b5c0826a3c2f2ba72e6ae1d8a1952ff'],
  },
  polygonzkevmtestnet: {
    threshold: 1,
    validators: ['0x2d0214068e5d8e49c638b5a4c70c75080204be21'],
  },
};
