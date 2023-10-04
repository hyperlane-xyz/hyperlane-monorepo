import { ChainMap, ModuleType, MultisigIsmConfig } from '@hyperlane-xyz/sdk';

export const rcMultisigIsmConfigs: ChainMap<MultisigIsmConfig> = {
  // ----------------- Mainnets -----------------
  celo: {
    type: ModuleType.LEGACY_MULTISIG,
    threshold: 1,
    validators: [
      '0xe7a82e210f512f8e9900d6bc2acbf7981c63e66e', // abacus
    ],
  },
  ethereum: {
    type: ModuleType.LEGACY_MULTISIG,
    threshold: 1,
    validators: [
      '0xaea1adb1c687b061e5b60b9da84cb69e7b5fab44', // abacus
    ],
  },
  avalanche: {
    type: ModuleType.LEGACY_MULTISIG,
    threshold: 1,
    validators: [
      '0x706976391e23dea28152e0207936bd942aba01ce', // abacus
    ],
  },
  polygon: {
    type: ModuleType.LEGACY_MULTISIG,
    threshold: 1,
    validators: [
      '0xef372f6ff7775989b3ac884506ee31c79638c989', // abacus
    ],
  },
  bsc: {
    type: ModuleType.LEGACY_MULTISIG,
    threshold: 1,
    validators: [
      '0x0823081031a4a6f97c6083775c191d17ca96d0ab', // abacus
    ],
  },
  arbitrum: {
    type: ModuleType.LEGACY_MULTISIG,
    threshold: 1,
    validators: [
      '0x1a95b35fb809d57faf1117c1cc29a6c5df289df1', // abacus
    ],
  },
  optimism: {
    type: ModuleType.LEGACY_MULTISIG,
    threshold: 1,
    validators: [
      '0x60e938bf280bbc21bacfd8bf435459d9003a8f98', // abacus
    ],
  },
  moonbeam: {
    type: ModuleType.LEGACY_MULTISIG,
    threshold: 1,
    validators: [
      '0x0df7140811e309dc69638352545151ebb9d5e0fd', // abacus
    ],
  },
  gnosis: {
    type: ModuleType.LEGACY_MULTISIG,
    threshold: 1,
    validators: [
      '0x15f48e78092a4f79febface509cfd76467c6cdbb', // abacus
    ],
  },
  solana: {
    type: ModuleType.LEGACY_MULTISIG,
    threshold: 1,
    validators: [
      '0x8cc7dbfb5de339e4133f3af059c927ec383ace38', // abacus
    ],
  },
  // ----------------- Testnets -----------------
  alfajores: {
    type: ModuleType.LEGACY_MULTISIG,
    threshold: 1,
    validators: ['0x45e5c228b38e1cf09e9a3423ed0cf4862c4bf3de'],
  },
  fuji: {
    type: ModuleType.LEGACY_MULTISIG,
    threshold: 1,
    validators: ['0xd81ba169170a9b582812cf0e152d2c168572e21f'],
  },
  mumbai: {
    type: ModuleType.LEGACY_MULTISIG,
    threshold: 1,
    validators: ['0xb537c4ce34e1cad718be52aa30b095e416eae46a'],
  },
  bsctestnet: {
    type: ModuleType.LEGACY_MULTISIG,
    threshold: 1,
    validators: ['0x77f80ef5b18977e15d81aea8dd3a88e7df4bc0eb'],
  },
  goerli: {
    type: ModuleType.LEGACY_MULTISIG,
    threshold: 1,
    validators: ['0x9597ddb4ad2af237665559574b820596bb77ae7a'],
  },
  sepolia: {
    type: ModuleType.LEGACY_MULTISIG,
    threshold: 1,
    validators: ['0x183f15924f3a464c54c9393e8d268eb44d2b208c'],
  },
  moonbasealpha: {
    type: ModuleType.LEGACY_MULTISIG,
    threshold: 1,
    validators: ['0xbeaf158f85d7b64ced36b8aea0bbc4cd0f2d1a5d'],
  },
  optimismgoerli: {
    type: ModuleType.LEGACY_MULTISIG,
    threshold: 1,
    validators: ['0x1d6798671ac532f2bf30c3a5230697a4695705e4'],
  },
  arbitrumgoerli: {
    type: ModuleType.LEGACY_MULTISIG,
    threshold: 1,
    validators: ['0x6d13367c7cd713a4ea79a2552adf824bf1ecdd5e'],
  },
  solanadevnet: {
    type: ModuleType.LEGACY_MULTISIG,
    threshold: 1,
    validators: ['0x21b9eff4d1a6d3122596c7fb80315bf094b6e5c2'],
  },
};
