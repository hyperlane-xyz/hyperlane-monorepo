import { MultisigConfig, ValidatorConfig } from '../ism/types.js';
import { ChainMap } from '../types.js';

export const AW_VALIDATOR_ALIAS = 'Abacus Works';

const DEFAULT_AW_VALIDATOR: ValidatorConfig = {
  address: '0xa5962efa3ec138bf7ca8f7fde86b7ee32e24bf03',
  alias: AW_VALIDATOR_ALIAS,
};
const DEFAULT_AW_TESTNET_VALIDATOR: ValidatorConfig = {
  address: '0x3c659e0fe8d01b80d7828b421630085777346e7c',
  alias: AW_VALIDATOR_ALIAS,
};
const DEFAULT_MERKLY_VALIDATOR: ValidatorConfig = {
  address: '0xcf0211fafbb91fd9d06d7e306b30032dc3a1934f',
  alias: 'Merkly',
};
const DEFAULT_MITOSIS_VALIDATOR: ValidatorConfig = {
  address: '0x4f977a59fdc2d9e39f6d780a84d5b4add1495a36',
  alias: 'Mitosis',
};
const DEFAULT_ZEE_PRIME_VALIDATOR: ValidatorConfig = {
  address: '0x5450447aee7b544c462c9352bef7cad049b0c2dc',
  alias: 'Zee Prime',
};
const DEFAULT_STAKED_VALIDATOR: ValidatorConfig = {
  address: '0xb3ac35d3988bca8c2ffd195b1c6bee18536b317b',
  alias: 'Staked',
};
const DEFAULT_TESSELLATED_VALIDATOR: ValidatorConfig = {
  address: '0x0d4c1394a255568ec0ecd11795b28d1bda183ca4',
  alias: 'Tessellated',
};
const DEFAULT_ZKV_VALIDATOR: ValidatorConfig = {
  address: '0x761980c3debdc8ddb69a2713cf5126d4db900f0f',
  alias: 'ZKV',
};
const DEFAULT_BLOCKPI_VALIDATOR: ValidatorConfig = {
  address: '0x6d113ae51bfea7b63a8828f97e9dce393b25c189',
  alias: 'BlockPI',
};
const DEFAULT_POPS_VALIDATOR: ValidatorConfig = {
  address: '0xa6c998f0db2b56d7a63faf30a9b677c8b9b6faab',
  alias: 'P-OPS Team',
};

// TODO: consider migrating these to the registry too
export const defaultMultisigConfigs: ChainMap<MultisigConfig> = {
  abstract: {
    threshold: 2,
    validators: [
      DEFAULT_AW_VALIDATOR,
      DEFAULT_MERKLY_VALIDATOR,
      DEFAULT_MITOSIS_VALIDATOR,
    ],
  },

  adichain: {
    threshold: 2,
    validators: [DEFAULT_AW_VALIDATOR, DEFAULT_MITOSIS_VALIDATOR],
  },

  aleo: {
    threshold: 3,
    validators: [
      DEFAULT_AW_VALIDATOR,
      DEFAULT_MITOSIS_VALIDATOR,
      {
        address: '0x98ea4149045841d5d0423198bc3ad754227e8185',
        alias: 'Enigma',
      },
      {
        address: '0x9a400971b5ae35bafb9d0bfaba49b45cdac6e8ef',
        alias: 'Luganodes',
      },
    ],
  },

  aleotestnet: {
    threshold: 1,
    validators: [DEFAULT_AW_TESTNET_VALIDATOR],
  },

  apechain: {
    threshold: 2,
    validators: [
      DEFAULT_AW_VALIDATOR,
      DEFAULT_MERKLY_VALIDATOR,
      DEFAULT_MITOSIS_VALIDATOR,
    ],
  },

  appchain: {
    threshold: 2,
    validators: [
      DEFAULT_AW_VALIDATOR,
      DEFAULT_MERKLY_VALIDATOR,
      DEFAULT_MITOSIS_VALIDATOR,
    ],
  },

  arbitrum: {
    threshold: 3,
    validators: [
      DEFAULT_AW_VALIDATOR,
      DEFAULT_ZEE_PRIME_VALIDATOR,
      DEFAULT_MITOSIS_VALIDATOR,
      {
        address: '0x57ddf0cd46f31ead8084069ce481507f4305c716',
        alias: 'Luganodes',
      },
      {
        address: '0xde6c50c3e49852dd9fe0388166ebc1ba39ad8505',
        alias: 'Enigma',
      },
    ],
  },

  arbitrumsepolia: {
    threshold: 1,
    validators: [DEFAULT_AW_TESTNET_VALIDATOR],
  },

  avalanche: {
    threshold: 3,
    validators: [
      DEFAULT_AW_VALIDATOR,
      DEFAULT_MITOSIS_VALIDATOR,
      {
        address: '0x74de235ace64fa8a3d5e3d5e414360888e655c62',
        alias: 'Substance Labs',
      },
      {
        address: '0x4488dbc191c39ae026b4a1fdb2aefe21960226d5',
        alias: 'Luganodes',
      },
    ],
  },

  base: {
    threshold: 3,
    validators: [
      DEFAULT_AW_VALIDATOR,
      DEFAULT_ZEE_PRIME_VALIDATOR,
      {
        address: '0xb8cf45d7bab79c965843206d5f4d83bb866d6e86',
        alias: 'Substance Labs',
      },
      {
        address: '0xe957310e17730f29862e896709cce62d24e4b773',
        alias: 'Luganodes',
      },
      {
        address: '0x34a14934d7c18a21440b59dfe9bf132ce601457d',
        alias: 'Enigma',
      },
    ],
  },

  basesepolia: {
    threshold: 1,
    validators: [DEFAULT_AW_TESTNET_VALIDATOR],
  },

  berachain: {
    threshold: 3,
    validators: [
      DEFAULT_AW_VALIDATOR,
      {
        address: '0xae09cb3febc4cad59ef5a56c1df741df4eb1f4b6',
        alias: 'Renzo',
      },
      DEFAULT_MERKLY_VALIDATOR,
      DEFAULT_MITOSIS_VALIDATOR,
    ],
  },

  blast: {
    threshold: 2,
    validators: [
      DEFAULT_AW_VALIDATOR,
      DEFAULT_MITOSIS_VALIDATOR,
      { address: '0x54bb0036f777202371429e062fe6aee0d59442f9', alias: 'Renzo' },
    ],
  },

  bob: {
    threshold: 3,
    validators: [
      DEFAULT_AW_VALIDATOR,
      DEFAULT_MERKLY_VALIDATOR,
      DEFAULT_MITOSIS_VALIDATOR,
      {
        address: '0x53d2738453c222e49c556d937bcef3f80f1c2eec',
        alias: 'Substance Labs',
      },
      {
        address: '0xb574b2b5822a8cb9ca071e7d43865694f23b0bde',
        alias: 'Enigma',
      },
    ],
  },

  bsc: {
    threshold: 4,
    validators: [
      DEFAULT_AW_VALIDATOR,
      DEFAULT_ZEE_PRIME_VALIDATOR,
      DEFAULT_TESSELLATED_VALIDATOR,
      {
        address: '0x24c1506142b2c859aee36474e59ace09784f71e8',
        alias: 'Substance Labs',
      },
      {
        address: '0xc67789546a7a983bf06453425231ab71c119153f',
        alias: 'Luganodes',
      },
      {
        address: '0x2d74f6edfd08261c927ddb6cb37af57ab89f0eff',
        alias: 'Enigma',
      },
    ],
  },

  bsctestnet: {
    threshold: 1,
    validators: [DEFAULT_AW_TESTNET_VALIDATOR],
  },

  carrchain: {
    threshold: 2,
    validators: [DEFAULT_AW_VALIDATOR, DEFAULT_MITOSIS_VALIDATOR],
  },

  celestia: {
    threshold: 3,
    validators: [
      DEFAULT_AW_VALIDATOR,
      DEFAULT_ZKV_VALIDATOR,
      DEFAULT_POPS_VALIDATOR,
      {
        address: '0x21e93a81920b73c0e98aed8e6b058dae409e4909',
        alias: 'Binary Builders',
      },
    ],
  },

  celestiatestnet: {
    threshold: 1,
    validators: [DEFAULT_AW_TESTNET_VALIDATOR],
  },

  celo: {
    threshold: 4,
    validators: [
      DEFAULT_AW_VALIDATOR,
      {
        address: '0xeb0c31e2f2671d724a2589d4a8eca91b97559148',
        alias: 'Imperator',
      },
      {
        address: '0x033e391e9fc57a7b5dd6c91b69be9a1ed11c4986',
        alias: 'Enigma',
      },
      {
        address: '0x4a2423ef982b186729e779b6e54b0e84efea7285',
        alias: 'Luganodes',
      },
      DEFAULT_TESSELLATED_VALIDATOR,
      DEFAULT_ZEE_PRIME_VALIDATOR,
    ],
  },

  celosepolia: {
    threshold: 1,
    validators: [DEFAULT_AW_TESTNET_VALIDATOR],
  },

  chiado: {
    threshold: 1,
    validators: [DEFAULT_AW_TESTNET_VALIDATOR],
  },

  citrea: {
    threshold: 2,
    validators: [
      DEFAULT_AW_VALIDATOR,
      DEFAULT_MITOSIS_VALIDATOR,
      {
        address: '0xd2e26f9089e9ff6a1ea9f7e90575e985cfea7f03',
        alias: 'Citrea',
      },
    ],
  },

  coti: {
    threshold: 2,
    validators: [
      DEFAULT_AW_VALIDATOR,
      DEFAULT_MERKLY_VALIDATOR,
      DEFAULT_MITOSIS_VALIDATOR,
    ],
  },

  cotitestnet: {
    threshold: 1,
    validators: [DEFAULT_AW_TESTNET_VALIDATOR],
  },

  eclipsemainnet: {
    threshold: 3,
    validators: [
      DEFAULT_AW_VALIDATOR,
      {
        address: '0x3571223e745dc0fcbdefa164c9b826b90c0d2dac',
        alias: 'Luganodes',
      },
      {
        address: '0x4d4629f5bfeabe66edc7a78da26ef5273c266f97',
        alias: 'Eclipse',
      },
      DEFAULT_ZEE_PRIME_VALIDATOR,
    ],
  },

  eclipsetestnet: {
    threshold: 1,
    validators: [DEFAULT_AW_TESTNET_VALIDATOR],
  },

  eden: {
    threshold: 3,
    validators: [
      DEFAULT_AW_VALIDATOR,
      DEFAULT_POPS_VALIDATOR,
      {
        address: '0xE95a08Ef009be3Fbc7FDfa4739AB2428910C285f',
        alias: 'Substance Labs',
      },
      {
        address: '0xa3f19CDFa6B684b44da3cF1e2D19d5Cb916cA0EF',
        alias: 'Qubelabs',
      },
    ],
  },

  electroneum: {
    threshold: 2,
    validators: [DEFAULT_AW_VALIDATOR, DEFAULT_MITOSIS_VALIDATOR],
  },

  eni: {
    threshold: 2,
    validators: [DEFAULT_AW_VALIDATOR, DEFAULT_MITOSIS_VALIDATOR],
  },

  ethereum: {
    threshold: 6,
    validators: [
      DEFAULT_AW_VALIDATOR,
      { address: '0x94438a7de38d4548ae54df5c6010c4ebc5239eae', alias: 'DSRV' },
      DEFAULT_ZEE_PRIME_VALIDATOR,
      DEFAULT_STAKED_VALIDATOR,
      {
        address: '0xb683b742b378632a5f73a2a5a45801b3489bba44',
        alias: 'AVS: Luganodes',
      },
      {
        address: '0x3786083ca59dc806d894104e65a13a70c2b39276',
        alias: 'Imperator',
      },
      DEFAULT_MITOSIS_VALIDATOR,
      {
        address: '0x29d783efb698f9a2d3045ef4314af1f5674f52c5',
        alias: 'Substance Labs',
      },
      {
        address: '0x36a669703ad0e11a0382b098574903d2084be22c',
        alias: 'Enigma',
      },
      {
        address: '0xef2e5bb2bc45dd092ff7f9d4d4485f022185aeae',
        alias: 'Citrea',
      },
    ],
  },

  flowmainnet: {
    threshold: 3,
    validators: [
      DEFAULT_AW_VALIDATOR,
      DEFAULT_MERKLY_VALIDATOR,
      DEFAULT_MITOSIS_VALIDATOR,
      {
        address: '0x14ADB9e3598c395Fe3290f3ba706C3816Aa78F59',
        alias: 'Flow Foundation',
      },
    ],
  },

  fluent: {
    threshold: 3,
    validators: [
      DEFAULT_AW_VALIDATOR,
      DEFAULT_MITOSIS_VALIDATOR,
      {
        address: '0x6a07e3406536d3a117f41850e69c70961d002efe',
        alias: 'Fluent',
      },
    ],
  },

  forma: {
    threshold: 3,
    validators: [
      {
        address: '0xE74c7632aF1De54D208f1b9e18B22988dDc8C4CE',
        alias: 'Imperator',
      },
      {
        address: '0x38c7a4ca1273ead2e867d096adbcdd0e2acb21d8',
        alias: 'Everstake',
      },
      {
        address: '0x1734abc14f0e68cdaf64f072831f6a6c8f622c37',
        alias: 'DSRV',
      },
      {
        address: '0xb6536d1b52969d6c66bb85533b9ab04d886b3401',
        alias: 'Engima',
      },
    ],
  },

  fraxtal: {
    threshold: 3,
    validators: [
      DEFAULT_AW_VALIDATOR,
      DEFAULT_TESSELLATED_VALIDATOR,
      {
        address: '0x1c3C3013B863Cf666499Da1A61949AE396E3Ab82',
        alias: 'Enigma',
      },
      {
        address: '0x573e960e07ad74ea2c5f1e3c31b2055994b12797',
        alias: 'Imperator',
      },
      DEFAULT_ZEE_PRIME_VALIDATOR,
    ],
  },

  fuji: {
    threshold: 1,
    validators: [DEFAULT_AW_TESTNET_VALIDATOR],
  },

  galactica: {
    threshold: 2,
    validators: [DEFAULT_AW_VALIDATOR, DEFAULT_MITOSIS_VALIDATOR],
  },

  gnosis: {
    threshold: 2,
    validators: [DEFAULT_AW_VALIDATOR, DEFAULT_ZEE_PRIME_VALIDATOR],
  },

  hyperevm: {
    threshold: 2,
    validators: [
      DEFAULT_AW_VALIDATOR,
      DEFAULT_MITOSIS_VALIDATOR,
      {
        address: '0x04d949c615c9976f89595ddcb9008c92f8ba7278',
        alias: 'Luganodes',
      },
    ],
  },

  hyperliquidevmtestnet: {
    threshold: 1,
    validators: [DEFAULT_AW_TESTNET_VALIDATOR],
  },

  igra: {
    threshold: 2,
    validators: [DEFAULT_AW_VALIDATOR, DEFAULT_MITOSIS_VALIDATOR],
  },

  immutablezkevmmainnet: {
    threshold: 2,
    validators: [
      DEFAULT_AW_VALIDATOR,
      DEFAULT_MERKLY_VALIDATOR,
      DEFAULT_MITOSIS_VALIDATOR,
    ],
  },

  ink: {
    threshold: 3,
    validators: [
      DEFAULT_AW_VALIDATOR,
      {
        address: '0xa40203b5301659f1e201848d92f5e81f64f206f5',
        alias: 'Enigma',
      },
      {
        address: '0xff9c1e7b266a36eda0d9177d4236994d94819dc0',
        alias: 'Luganodes',
      },
      DEFAULT_TESSELLATED_VALIDATOR,
      DEFAULT_ZEE_PRIME_VALIDATOR,
    ],
  },

  katana: {
    threshold: 2,
    validators: [DEFAULT_AW_VALIDATOR, DEFAULT_MITOSIS_VALIDATOR],
  },

  kiichain: {
    threshold: 2,
    validators: [DEFAULT_AW_VALIDATOR, DEFAULT_MITOSIS_VALIDATOR],
  },

  krown: {
    threshold: 2,
    validators: [DEFAULT_AW_VALIDATOR, DEFAULT_MITOSIS_VALIDATOR],
  },

  kyve: {
    threshold: 2,
    validators: [
      DEFAULT_AW_VALIDATOR,
      DEFAULT_MERKLY_VALIDATOR,
      DEFAULT_MITOSIS_VALIDATOR,
    ],
  },

  kyvetestnet: {
    threshold: 1,
    validators: [DEFAULT_AW_TESTNET_VALIDATOR],
  },

  lazai: {
    threshold: 2,
    validators: [DEFAULT_AW_VALIDATOR, DEFAULT_MITOSIS_VALIDATOR],
  },

  linea: {
    threshold: 4,
    validators: [
      DEFAULT_AW_VALIDATOR,
      DEFAULT_MERKLY_VALIDATOR,
      DEFAULT_MITOSIS_VALIDATOR,
      DEFAULT_ZEE_PRIME_VALIDATOR,
      {
        address: '0x0c760f4bcb508db9144b0579e26f5ff8d94daf4d',
        alias: 'Luganodes',
      },
      {
        address: '0x6fbceb2680c8181acf3d1b5f0189e3beaa985338',
        alias: 'Enigma',
      },
    ],
  },

  lisk: {
    threshold: 5,
    validators: [
      DEFAULT_AW_VALIDATOR,
      DEFAULT_TESSELLATED_VALIDATOR,
      {
        address: '0x3DA4ee2801Ec6CC5faD73DBb94B10A203ADb3d9e',
        alias: 'Enigma',
      },
      {
        address: '0x4df6e8878992c300e7bfe98cac6bf7d3408b9cbf',
        alias: 'Imperator',
      },
      {
        address: '0xf0da628f3fb71652d48260bad4691054045832ce',
        alias: 'Luganodes',
      },
      {
        address: '0xead4141b6ea149901ce4f4b556953f66d04b1d0c',
        alias: 'Lisk',
      },
      DEFAULT_ZEE_PRIME_VALIDATOR,
    ],
  },

  lukso: {
    threshold: 2,
    validators: [
      DEFAULT_AW_VALIDATOR,
      DEFAULT_MERKLY_VALIDATOR,
      {
        address: '0x101cE77261245140A0871f9407d6233C8230Ec47',
        alias: 'Blockhunters',
      },
    ],
  },

  mantle: {
    threshold: 4,
    validators: [
      DEFAULT_AW_VALIDATOR,
      DEFAULT_MERKLY_VALIDATOR,
      DEFAULT_MITOSIS_VALIDATOR,
      DEFAULT_ZEE_PRIME_VALIDATOR,
      {
        address: '0xcd3b3a2007aab3b00418fbac12bea19d04243497',
        alias: 'Luganodes',
      },
      {
        address: '0x332b3710e56b843027d4c6da7bca219ece7099b0',
        alias: 'Enigma',
      },
    ],
  },

  mantra: {
    threshold: 2,
    validators: [DEFAULT_AW_VALIDATOR, DEFAULT_MITOSIS_VALIDATOR],
  },

  megaeth: {
    threshold: 2,
    validators: [DEFAULT_AW_VALIDATOR, DEFAULT_MITOSIS_VALIDATOR],
  },

  modetestnet: {
    threshold: 1,
    validators: [DEFAULT_AW_TESTNET_VALIDATOR],
  },

  metal: {
    threshold: 4,
    validators: [
      DEFAULT_AW_VALIDATOR,
      {
        address: '0x01e3909133d20c05bbc94247769235d30101f748',
        alias: 'Imperator',
      },

      {
        address: '0xaba06266f47e3ef554d218b879bd86114a8dabd4',
        alias: 'Enigma',
      },
      {
        address: '0x05d91f80377ff5e9c6174025ffaf094c57a4766a',
        alias: 'Luganodes',
      },
      DEFAULT_TESSELLATED_VALIDATOR,
      DEFAULT_ZEE_PRIME_VALIDATOR,
    ],
  },

  metis: {
    threshold: 4,
    validators: [
      DEFAULT_AW_VALIDATOR,
      DEFAULT_MERKLY_VALIDATOR,
      DEFAULT_MITOSIS_VALIDATOR,
      DEFAULT_ZEE_PRIME_VALIDATOR,
      {
        address: '0xad1df94ae078631bfea1623520125e93a6085555',
        alias: 'Luganodes',
      },
      {
        address: '0x4272e7b93e127da5bc7cee617febf47bcad20def',
        alias: 'Enigma',
      },
    ],
  },

  mitosis: {
    threshold: 3,
    validators: [
      DEFAULT_AW_VALIDATOR,
      DEFAULT_MITOSIS_VALIDATOR,
      DEFAULT_ZEE_PRIME_VALIDATOR,
      {
        address: '0x401f25ff73769ed85bdb449a4347a4fd2678acfe',
        alias: 'Enigma',
      },
      {
        address: '0x340058f071e8376c2ecff219e1e6620deea8a3c7',
        alias: 'Substance Labs',
      },
    ],
  },

  mocachain: {
    threshold: 2,
    validators: [DEFAULT_AW_VALIDATOR, DEFAULT_MITOSIS_VALIDATOR],
  },

  mode: {
    threshold: 4,
    validators: [
      DEFAULT_AW_VALIDATOR,
      DEFAULT_TESSELLATED_VALIDATOR,
      {
        address: '0x65C140e3a05F33192384AffEF985696Fe3cDDE42',
        alias: 'Enigma',
      },
      {
        address: '0x20eade18ea2af6dfd54d72b3b5366b40fcb47f4b',
        alias: 'Imperator',
      },
      {
        address: '0x485a4f0009d9afbbf44521016f9b8cdd718e36ea',
        alias: 'Luganodes',
      },
      DEFAULT_ZEE_PRIME_VALIDATOR,
    ],
  },

  monad: {
    threshold: 2,
    validators: [DEFAULT_AW_VALIDATOR, DEFAULT_MITOSIS_VALIDATOR],
  },

  nesa: {
    threshold: 2,
    validators: [DEFAULT_AW_VALIDATOR, DEFAULT_MITOSIS_VALIDATOR],
  },

  nexus: {
    threshold: 2,
    validators: [DEFAULT_AW_VALIDATOR, DEFAULT_MITOSIS_VALIDATOR],
  },

  optimism: {
    threshold: 4,
    validators: [
      DEFAULT_AW_VALIDATOR,
      DEFAULT_TESSELLATED_VALIDATOR,
      {
        address: '0xd8c1cCbfF28413CE6c6ebe11A3e29B0D8384eDbB',
        alias: 'Enigma',
      },
      {
        address: '0x1b9e5f36c4bfdb0e3f0df525ef5c888a4459ef99',
        alias: 'Imperator',
      },
      {
        address: '0xf9dfaa5c20ae1d84da4b2696b8dc80c919e48b12',
        alias: 'Luganodes',
      },
      DEFAULT_ZEE_PRIME_VALIDATOR,
    ],
  },

  optimismsepolia: {
    threshold: 1,
    validators: [DEFAULT_AW_TESTNET_VALIDATOR],
  },

  paradex: {
    threshold: 2,
    validators: [
      DEFAULT_AW_VALIDATOR,
      DEFAULT_MITOSIS_VALIDATOR,
      {
        address: '0xc36fe08e2c06ca51f6c3523e54e33505b7aaba37',
        alias: 'Luganodes',
      },
    ],
  },

  paradexsepolia: {
    threshold: 1,
    validators: [DEFAULT_AW_TESTNET_VALIDATOR],
  },

  plasma: {
    threshold: 2,
    validators: [DEFAULT_AW_VALIDATOR, DEFAULT_MITOSIS_VALIDATOR],
  },

  plumetestnet: {
    threshold: 1,
    validators: [DEFAULT_AW_TESTNET_VALIDATOR],
  },

  polygon: {
    threshold: 2,
    validators: [
      DEFAULT_AW_VALIDATOR,
      { address: '0x008f24cbb1cc30ad0f19f2516ca75730e37efb5f', alias: 'DSRV' },
      DEFAULT_ZEE_PRIME_VALIDATOR,
    ],
  },

  polygonamoy: {
    threshold: 1,
    validators: [DEFAULT_AW_TESTNET_VALIDATOR],
  },

  pulsechain: {
    threshold: 2,
    validators: [DEFAULT_AW_VALIDATOR, DEFAULT_MITOSIS_VALIDATOR],
  },

  radix: {
    threshold: 2,
    validators: [
      DEFAULT_AW_VALIDATOR,
      DEFAULT_MITOSIS_VALIDATOR,
      {
        address: '0xc61209c6b133791c729d0cbe49d6da96c30a515f',
        alias: 'Luganodes',
      },
    ],
  },

  radixtestnet: {
    threshold: 1,
    validators: [DEFAULT_AW_TESTNET_VALIDATOR],
  },

  robinhood: {
    threshold: 2,
    validators: [DEFAULT_AW_VALIDATOR, DEFAULT_MITOSIS_VALIDATOR],
  },

  sei: {
    threshold: 2,
    validators: [
      DEFAULT_AW_VALIDATOR,
      DEFAULT_MERKLY_VALIDATOR,
      DEFAULT_MITOSIS_VALIDATOR,
    ],
  },

  seismictestnet: {
    threshold: 1,
    validators: [DEFAULT_AW_TESTNET_VALIDATOR],
  },

  sepolia: {
    threshold: 1,
    validators: [DEFAULT_AW_TESTNET_VALIDATOR],
  },

  solanadevnet: {
    threshold: 1,
    validators: [DEFAULT_AW_TESTNET_VALIDATOR],
  },

  solanamainnet: {
    threshold: 3,
    validators: [
      DEFAULT_AW_VALIDATOR,
      {
        address: '0xcb6bcbd0de155072a7ff486d9d7286b0f71dcc2d',
        alias: 'Eclipse',
      },
      DEFAULT_MITOSIS_VALIDATOR,
      {
        address: '0xd90ea26ff731d967c5ea660851f7d63cb04ab820',
        alias: 'DSRV',
      },
    ],
  },

  solanatestnet: {
    threshold: 1,
    validators: [DEFAULT_AW_TESTNET_VALIDATOR],
  },

  solaxy: {
    threshold: 2,
    validators: [DEFAULT_AW_VALIDATOR, DEFAULT_MITOSIS_VALIDATOR],
  },

  somnia: {
    threshold: 2,
    validators: [DEFAULT_AW_VALIDATOR, DEFAULT_MITOSIS_VALIDATOR],
  },

  somniatestnet: {
    threshold: 1,
    validators: [DEFAULT_AW_TESTNET_VALIDATOR],
  },

  soneium: {
    threshold: 4,
    validators: [
      DEFAULT_AW_VALIDATOR,
      {
        address: '0x9f4fa50ce49815b0932428a0eb1988382cef4a97',
        alias: 'Imperator',
      },
      {
        address: '0x8d2f8ebd61d055d58768cf3b07cb2fb565d87716',
        alias: 'Enigma',
      },
      {
        address: '0x6c5f6ab7a369222e6691218ad981fe08a5def094',
        alias: 'Luganodes',
      },
      DEFAULT_TESSELLATED_VALIDATOR,
      DEFAULT_ZEE_PRIME_VALIDATOR,
    ],
  },

  sonic: {
    threshold: 4,
    validators: [
      DEFAULT_AW_VALIDATOR,
      DEFAULT_MERKLY_VALIDATOR,
      DEFAULT_MITOSIS_VALIDATOR,
      DEFAULT_ZEE_PRIME_VALIDATOR,
      {
        address: '0x7f0e75c5151d0938eaa9ab8a30f9ddbd74c4ebef',
        alias: 'Luganodes',
      },
      {
        address: '0x4e3d1c926843dcc8ff47061bbd7143a2755899f3',
        alias: 'Enigma',
      },
    ],
  },

  sonicsvm: {
    threshold: 3,
    validators: [
      DEFAULT_AW_VALIDATOR,
      DEFAULT_MERKLY_VALIDATOR,
      DEFAULT_MITOSIS_VALIDATOR,
      {
        address: '0x85c7a16790cfd9dad6d4abdd4e2d3f1d550c7606',
        alias: 'Sonic SVM',
      },
    ],
  },

  sonicsvmtestnet: {
    threshold: 1,
    validators: [DEFAULT_AW_TESTNET_VALIDATOR],
  },

  soon: {
    threshold: 2,
    validators: [
      DEFAULT_AW_VALIDATOR,
      DEFAULT_MERKLY_VALIDATOR,
      DEFAULT_MITOSIS_VALIDATOR,
    ],
  },

  stable: {
    threshold: 2,
    validators: [DEFAULT_AW_VALIDATOR, DEFAULT_MITOSIS_VALIDATOR],
  },

  starknet: {
    threshold: 2,
    validators: [
      DEFAULT_AW_VALIDATOR,
      DEFAULT_ZEE_PRIME_VALIDATOR,
      DEFAULT_STAKED_VALIDATOR,
    ],
  },

  starknetsepolia: {
    threshold: 1,
    validators: [DEFAULT_AW_TESTNET_VALIDATOR],
  },

  subtensor: {
    threshold: 3,
    validators: [
      DEFAULT_AW_VALIDATOR,
      DEFAULT_MERKLY_VALIDATOR,
      DEFAULT_MITOSIS_VALIDATOR,
      DEFAULT_ZEE_PRIME_VALIDATOR,
    ],
  },

  superseed: {
    threshold: 4,
    validators: [
      DEFAULT_AW_VALIDATOR,
      {
        address: '0x68f3a3b244f6ddc135130200a6b8729e290b4240',
        alias: 'Imperator',
      },
      {
        address: '0x6ff4554cffbc2e4e4230b78e526eab255101d05a',
        alias: 'Enigma',
      },
      {
        address: '0x55880ac03fdf15fccff54ed6f8a83455033edd22',
        alias: 'Luganodes',
      },
      DEFAULT_TESSELLATED_VALIDATOR,
      DEFAULT_ZEE_PRIME_VALIDATOR,
    ],
  },

  tac: {
    threshold: 2,
    validators: [DEFAULT_AW_VALIDATOR, DEFAULT_MITOSIS_VALIDATOR],
  },

  taiko: {
    threshold: 3,
    validators: [
      DEFAULT_AW_VALIDATOR,
      DEFAULT_MERKLY_VALIDATOR,
      DEFAULT_MITOSIS_VALIDATOR,
      {
        address: '0x2F007c82672F2Bb97227D4e3F80Ac481bfB40A2a',
        alias: 'Luganodes',
      },
    ],
  },

  tea: {
    threshold: 2,
    validators: [DEFAULT_AW_VALIDATOR, DEFAULT_MITOSIS_VALIDATOR],
  },

  tron: {
    threshold: 3,
    validators: [
      DEFAULT_AW_VALIDATOR,
      DEFAULT_MITOSIS_VALIDATOR,
      {
        address: '0x28e00979336d4faef1eed9ac35ad3adc5e5ec5bd',
        alias: 'Enigma',
      },
      {
        address: '0x3c9a49f0e601c186e134aee2c75c482869dc0dc6',
        alias: 'Luganodes',
      },
    ],
  },

  tronshasta: {
    threshold: 1,
    validators: [DEFAULT_AW_TESTNET_VALIDATOR],
  },

  unichain: {
    threshold: 3,
    validators: [
      DEFAULT_AW_VALIDATOR,
      {
        address: '0xa2549be30fb852c210c2fe8e7639039dca779936',
        alias: 'Imperator',
      },
      {
        address: '0xbcbed4d11e946844162cd92c6d09d1cf146b4006',
        alias: 'Enigma',
      },
      DEFAULT_TESSELLATED_VALIDATOR,
      DEFAULT_ZEE_PRIME_VALIDATOR,
    ],
  },

  unichaintestnet: {
    threshold: 1,
    validators: [DEFAULT_AW_TESTNET_VALIDATOR],
  },

  viction: {
    threshold: 2,
    validators: [
      DEFAULT_BLOCKPI_VALIDATOR,
      { address: '0xa3f93fe365bf99f431d8fde740b140615e24f99b', alias: 'RockX' },
      DEFAULT_AW_VALIDATOR,
    ],
  },

  worldchain: {
    threshold: 4,
    validators: [
      DEFAULT_AW_VALIDATOR,
      {
        address: '0x11e2a683e83617f186614071e422b857256a9aae',
        alias: 'Imperator',
      },
      DEFAULT_MERKLY_VALIDATOR,
      DEFAULT_ZEE_PRIME_VALIDATOR,
      {
        address: '0xc1545f9fe903736b2e438b733740bd3516486da5',
        alias: 'Luganodes',
      },
      {
        address: '0x698810f8ae471f7e34860b465aeeb03df407be47',
        alias: 'Enigma',
      },
    ],
  },

  xlayer: {
    threshold: 2,
    validators: [
      DEFAULT_AW_VALIDATOR,
      DEFAULT_MERKLY_VALIDATOR,
      DEFAULT_MITOSIS_VALIDATOR,
    ],
  },

  zerogravity: {
    threshold: 4,
    validators: [
      DEFAULT_AW_VALIDATOR,
      DEFAULT_MITOSIS_VALIDATOR,
      DEFAULT_ZEE_PRIME_VALIDATOR,
      {
        address: '0x25c5fc524ac7ef5e7868644fbe68793e5eb179ea',
        alias: 'Luganodes',
      },
      {
        address: '0x782ac2b5244b69779bd7214a2d60212fb35c3ae7',
        alias: 'Enigma',
      },
      {
        address: '0xd3e6a4e61b5d902a63df6dac9db5585d9f319b09',
        alias: 'Substance Labs',
      },
    ],
  },

  zksync: {
    threshold: 2,
    validators: [
      DEFAULT_AW_VALIDATOR,
      DEFAULT_MERKLY_VALIDATOR,
      DEFAULT_MITOSIS_VALIDATOR,
    ],
  },
};
