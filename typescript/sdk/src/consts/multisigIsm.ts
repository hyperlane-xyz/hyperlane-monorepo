import { MultisigConfig, ValidatorConfig } from '../ism/types.js';
import { ChainMap } from '../types.js';

export const AW_VALIDATOR_ALIAS = 'Abacus Works';

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
const DEFAULT_EVERSTAKE_VALIDATOR: ValidatorConfig = {
  address: '0x38c7a4ca1273ead2e867d096adbcdd0e2acb21d8',
  alias: 'Everstake',
};
const DEFAULT_STAKED_VALIDATOR: ValidatorConfig = {
  address: '0xb3ac35d3988bca8c2ffd195b1c6bee18536b317b',
  alias: 'Staked',
};
const DEFAULT_TESSELLATED_VALIDATOR: ValidatorConfig = {
  address: '0x0d4c1394a255568ec0ecd11795b28d1bda183ca4',
  alias: 'Tessellated',
};
const DEFAULT_BWARE_LABS_VALIDATOR: ValidatorConfig = {
  address: '0x14d0B24d3a8F3aAD17DB4b62cBcEC12821c98Cb3',
  alias: 'Bware Labs',
};
const DEFAULT_ZKV_VALIDATOR: ValidatorConfig = {
  address: '0x761980c3debdc8ddb69a2713cf5126d4db900f0f',
  alias: 'ZKV',
};
const DEFAULT_BLOCKPI_VALIDATOR: ValidatorConfig = {
  address: '0x6d113ae51bfea7b63a8828f97e9dce393b25c189',
  alias: 'BlockPI',
};
const DEFAULT_HASHKEY_CLOUD_VALIDATOR: ValidatorConfig = {
  address: '0x5aed2fd5cc5f9749c455646c86b0db6126cafcbb',
  alias: 'Hashkey Cloud',
};

// TODO: consider migrating these to the registry too
export const defaultMultisigConfigs: ChainMap<MultisigConfig> = {
  abstract: {
    threshold: 2,
    validators: [
      {
        address: '0x2ef8ece5b51562e65970c7d36007baa43a1de685',
        alias: AW_VALIDATOR_ALIAS,
      },
      DEFAULT_MERKLY_VALIDATOR,
      DEFAULT_MITOSIS_VALIDATOR,
    ],
  },

  abstracttestnet: {
    threshold: 1,
    validators: [
      {
        address: '0x7655bc4c9802bfcb3132b8822155b60a4fbbce3e',
        alias: AW_VALIDATOR_ALIAS,
      },
    ],
  },

  // acala: {
  //   threshold: 1,
  //   validators: [
  //     {
  //       address: '0x3229bbeeab163c102d0b1fa15119b9ae0ed37cfa',
  //       alias: AW_VALIDATOR_ALIAS,
  //     },
  //   ],
  // },

  alephzeroevmmainnet: {
    threshold: 3,
    validators: [
      {
        address: '0x33f20e6e775747d60301c6ea1c50e51f0389740c',
        alias: AW_VALIDATOR_ALIAS,
      },
      DEFAULT_MERKLY_VALIDATOR,
      DEFAULT_MITOSIS_VALIDATOR,
      {
        address: '0xCbf382214825F8c2f347dd4f23F0aDFaFad55dAa',
        alias: 'Aleph Zero',
      },
    ],
  },

  alephzeroevmtestnet: {
    threshold: 1,
    validators: [
      {
        address: '0x556cd94bcb6e5773e8df75e7eb3f91909d266a26',
        alias: AW_VALIDATOR_ALIAS,
      },
    ],
  },

  alfajores: {
    threshold: 2,
    validators: [
      {
        address: '0x2233a5ce12f814bd64c9cdd73410bb8693124d40',
        alias: AW_VALIDATOR_ALIAS,
      },
      {
        address: '0xba279f965489d90f90490e3c49e860e0b43c2ae6',
        alias: AW_VALIDATOR_ALIAS,
      },
      {
        address: '0x86485dcec5f7bb8478dd251676372d054dea6653',
        alias: AW_VALIDATOR_ALIAS,
      },
    ],
  },

  ancient8: {
    threshold: 2,
    validators: [
      {
        address: '0xbb5842ae0e05215b53df4787a29144efb7e67551',
        alias: AW_VALIDATOR_ALIAS,
      },
      {
        address: '0xa5a56e97fb46f0ac3a3d261e404acb998d9a6969',
        alias: 'Coin98',
      },
      {
        address: '0x95c7bf235837cb5a609fe6c95870410b9f68bcff',
        alias: 'Ancient8',
      },
    ],
  },

  apechain: {
    threshold: 2,
    validators: [
      {
        address: '0x773d7fe6ffb1ba4de814c28044ff9a2d83a48221',
        alias: AW_VALIDATOR_ALIAS,
      },
      DEFAULT_MERKLY_VALIDATOR,
      DEFAULT_MITOSIS_VALIDATOR,
    ],
  },

  appchain: {
    threshold: 2,
    validators: [
      {
        address: '0x0531251bbadc1f9f19ccce3ca6b3f79f08eae1be',
        alias: AW_VALIDATOR_ALIAS,
      },
      DEFAULT_MERKLY_VALIDATOR,
      DEFAULT_MITOSIS_VALIDATOR,
    ],
  },

  arbitrum: {
    threshold: 3,
    validators: [
      {
        address: '0x4d966438fe9e2b1e7124c87bbb90cb4f0f6c59a1',
        alias: AW_VALIDATOR_ALIAS,
      },
      { address: '0xec68258a7c882ac2fc46b81ce80380054ffb4ef2', alias: 'DSRV' },
      DEFAULT_ZEE_PRIME_VALIDATOR,
      DEFAULT_EVERSTAKE_VALIDATOR,
      DEFAULT_STAKED_VALIDATOR,
    ],
  },

  arbitrumnova: {
    threshold: 2,
    validators: [
      {
        address: '0xd2a5e9123308d187383c87053811a2c21bd8af1f',
        alias: AW_VALIDATOR_ALIAS,
      },
      DEFAULT_MERKLY_VALIDATOR,
      DEFAULT_MITOSIS_VALIDATOR,
    ],
  },

  arbitrumsepolia: {
    threshold: 1,
    validators: [
      {
        address: '0x09fabfbca0b8bf042e2a1161ee5010d147b0f603',
        alias: AW_VALIDATOR_ALIAS,
      },
    ],
  },

  arcadia: {
    threshold: 2,
    validators: [
      {
        address: '0xe16ee9618f138cc2dcf9f9a95462099a8bf33a38',
        alias: AW_VALIDATOR_ALIAS,
      },
      DEFAULT_MERKLY_VALIDATOR,
      DEFAULT_MITOSIS_VALIDATOR,
    ],
  },

  arcadiatestnet2: {
    threshold: 1,
    validators: [
      {
        address: '0xd39cd388ce3f616bc81be6dd3ec9348d7cdf4dff',
        alias: AW_VALIDATOR_ALIAS,
      },
    ],
  },

  artela: {
    threshold: 2,
    validators: [
      {
        address: '0x8fcc1ebd4c0b463618db13f83e4565af3e166b00',
        alias: AW_VALIDATOR_ALIAS,
      },
      DEFAULT_MERKLY_VALIDATOR,
      DEFAULT_MITOSIS_VALIDATOR,
    ],
  },

  arthera: {
    threshold: 2,
    validators: [
      {
        address: '0x13710ac11c36c169f62fba95767ae59a1e57098d',
        alias: AW_VALIDATOR_ALIAS,
      },
      DEFAULT_MERKLY_VALIDATOR,
      DEFAULT_MITOSIS_VALIDATOR,
    ],
  },

  astar: {
    threshold: 2,
    validators: [
      {
        address: '0x4d1b2cade01ee3493f44304653d8e352c66ec3e7',
        alias: AW_VALIDATOR_ALIAS,
      },
      DEFAULT_MERKLY_VALIDATOR,
      DEFAULT_MITOSIS_VALIDATOR,
    ],
  },

  aurora: {
    threshold: 2,
    validators: [
      {
        address: '0x37105aec3ff37c7bb0abdb0b1d75112e1e69fa86',
        alias: AW_VALIDATOR_ALIAS,
      },
      DEFAULT_MERKLY_VALIDATOR,
      DEFAULT_MITOSIS_VALIDATOR,
    ],
  },

  auroratestnet: {
    threshold: 1,
    validators: [
      {
        address: '0xab1a2c76bf4cced43fde7bc1b5b57b9be3e7f937',
        alias: AW_VALIDATOR_ALIAS,
      },
    ],
  },

  avalanche: {
    threshold: 2,
    validators: [
      {
        address: '0x3fb8263859843bffb02950c492d492cae169f4cf',
        alias: AW_VALIDATOR_ALIAS,
      },
      { address: '0x402e0f8c6e4210d408b6ac00d197d4a099fcd25a', alias: 'DSRV' },
      DEFAULT_EVERSTAKE_VALIDATOR,
    ],
  },

  b3: {
    threshold: 2,
    validators: [
      {
        address: '0xd77b516730a836fc41934e7d5864e72c165b934e',
        alias: AW_VALIDATOR_ALIAS,
      },
      DEFAULT_MERKLY_VALIDATOR,
      DEFAULT_MITOSIS_VALIDATOR,
    ],
  },

  base: {
    threshold: 4,
    validators: [
      {
        address: '0xb9453d675e0fa3c178a17b4ce1ad5b1a279b3af9',
        alias: AW_VALIDATOR_ALIAS,
      },
      DEFAULT_STAKED_VALIDATOR,
      DEFAULT_EVERSTAKE_VALIDATOR,
      { address: '0xcff391b4e516452d424db66beb9052b041a9ed79', alias: 'DSRV' },
      DEFAULT_ZEE_PRIME_VALIDATOR,
      DEFAULT_ZKV_VALIDATOR,
    ],
  },

  basecamptestnet: {
    threshold: 1,
    validators: [
      {
        address: '0x84441e39ed5251410aa2baa72e7747c46d1e5e9d',
        alias: AW_VALIDATOR_ALIAS,
      },
    ],
  },

  basesepolia: {
    threshold: 1,
    validators: [
      {
        address: '0x82e3b437a2944e3ff00258c93e72cd1ba5e0e921',
        alias: AW_VALIDATOR_ALIAS,
      },
    ],
  },

  bepolia: {
    threshold: 1,
    validators: [
      {
        address: '0xdb0128bb3d3f204eb18de7e8268e94fde0382daf',
        alias: AW_VALIDATOR_ALIAS,
      },
    ],
  },

  berachain: {
    threshold: 3,
    validators: [
      {
        address: '0x0190915c55d9c7555e6d2cb838f04d18b5e2260e',
        alias: AW_VALIDATOR_ALIAS,
      },
      {
        address: '0xa7341aa60faad0ce728aa9aeb67bb880f55e4392',
        alias: 'Luganodes',
      },
      {
        address: '0xae09cb3febc4cad59ef5a56c1df741df4eb1f4b6',
        alias: 'Renzo',
      },
      DEFAULT_MERKLY_VALIDATOR,
      DEFAULT_MITOSIS_VALIDATOR,
    ],
  },

  bitlayer: {
    threshold: 4,
    validators: [
      {
        address: '0x1d9b0f4ea80dbfc71cb7d64d8005eccf7c41e75f',
        alias: AW_VALIDATOR_ALIAS,
      },
      DEFAULT_MERKLY_VALIDATOR,
      DEFAULT_MITOSIS_VALIDATOR,
      DEFAULT_BLOCKPI_VALIDATOR,
      DEFAULT_ZKV_VALIDATOR,
      DEFAULT_HASHKEY_CLOUD_VALIDATOR,
    ],
  },

  blast: {
    threshold: 3,
    validators: [
      {
        address: '0xf20c0b09f597597c8d2430d3d72dfddaf09177d1',
        alias: AW_VALIDATOR_ALIAS,
      },
      DEFAULT_MITOSIS_VALIDATOR,
      {
        address: '0x1652d8ba766821cf01aeea34306dfc1cab964a32',
        alias: 'Everclear',
      },
      { address: '0x54bb0036f777202371429e062fe6aee0d59442f9', alias: 'Renzo' },
    ],
  },

  bob: {
    threshold: 2,
    validators: [
      {
        address: '0x20f283be1eb0e81e22f51705dcb79883cfdd34aa',
        alias: AW_VALIDATOR_ALIAS,
      },
      DEFAULT_MERKLY_VALIDATOR,
      DEFAULT_MITOSIS_VALIDATOR,
    ],
  },

  boba: {
    threshold: 2,
    validators: [
      {
        address: '0xebeb92c94ca8408e73aa16fd554cb3a7df075c59',
        alias: AW_VALIDATOR_ALIAS,
      },
      DEFAULT_MERKLY_VALIDATOR,
      DEFAULT_MITOSIS_VALIDATOR,
    ],
  },

  bouncebit: {
    threshold: 2,
    validators: [
      {
        address: '0xaf38612d1e79ec67320d21c5f7e92419427cd154',
        alias: AW_VALIDATOR_ALIAS,
      },
      DEFAULT_MERKLY_VALIDATOR,
      DEFAULT_MITOSIS_VALIDATOR,
    ],
  },

  bsc: {
    threshold: 4,
    validators: [
      {
        address: '0x570af9b7b36568c8877eebba6c6727aa9dab7268',
        alias: AW_VALIDATOR_ALIAS,
      },
      { address: '0x8292b1a53907ece0f76af8a50724e9492bcdc8a3', alias: 'DSRV' },
      DEFAULT_EVERSTAKE_VALIDATOR,
      DEFAULT_ZEE_PRIME_VALIDATOR,
      DEFAULT_BLOCKPI_VALIDATOR,
      DEFAULT_TESSELLATED_VALIDATOR,
    ],
  },

  bsctestnet: {
    threshold: 2,
    validators: [
      {
        address: '0x242d8a855a8c932dec51f7999ae7d1e48b10c95e',
        alias: AW_VALIDATOR_ALIAS,
      },
      {
        address: '0xf620f5e3d25a3ae848fec74bccae5de3edcd8796',
        alias: AW_VALIDATOR_ALIAS,
      },
      {
        address: '0x1f030345963c54ff8229720dd3a711c15c554aeb',
        alias: AW_VALIDATOR_ALIAS,
      },
    ],
  },

  bsquared: {
    threshold: 2,
    validators: [
      {
        address: '0xcadc90933c9fbe843358a4e70e46ad2db78e28aa',
        alias: AW_VALIDATOR_ALIAS,
      },
      DEFAULT_MERKLY_VALIDATOR,
      DEFAULT_MITOSIS_VALIDATOR,
    ],
  },

  carrchaintestnet: {
    threshold: 1,
    validators: [
      {
        address: '0xa96dfc4d8c6cabb510701732ee01e52a75776205',
        alias: AW_VALIDATOR_ALIAS,
      },
    ],
  },

  celo: {
    threshold: 4,
    validators: [
      {
        address: '0x63478422679303c3e4fc611b771fa4a707ef7f4a',
        alias: AW_VALIDATOR_ALIAS,
      },
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
      DEFAULT_BWARE_LABS_VALIDATOR,
      DEFAULT_TESSELLATED_VALIDATOR,
    ],
  },

  cheesechain: {
    threshold: 2,
    validators: [
      {
        address: '0x478fb53c6860ae8fc35235ba0d38d49b13128226',
        alias: AW_VALIDATOR_ALIAS,
      },
      DEFAULT_MERKLY_VALIDATOR,
      {
        address: '0x101cE77261245140A0871f9407d6233C8230Ec47',
        alias: 'Blockhunters',
      },
    ],
  },

  chiado: {
    threshold: 2,
    validators: [
      {
        address: '0x06c3757a4b7a912828e523bb8a5f980ddc297356',
        alias: AW_VALIDATOR_ALIAS,
      },
      {
        address: '0x0874967a145d70b799ebe9ed861ab7c93faef95a',
        alias: AW_VALIDATOR_ALIAS,
      },
      {
        address: '0xd767ea1206b8295d7e1267ddd00e56d34f278db6',
        alias: AW_VALIDATOR_ALIAS,
      },
    ],
  },

  chilizmainnet: {
    threshold: 2,
    validators: [
      {
        address: '0x7403e5d58b48b0f5f715d9c78fbc581f01a625cb',
        alias: AW_VALIDATOR_ALIAS,
      },
      DEFAULT_MERKLY_VALIDATOR,
      DEFAULT_MITOSIS_VALIDATOR,
    ],
  },

  chronicleyellowstone: {
    threshold: 1,
    validators: [
      {
        address: '0xf11cfeb2b6db66ec14c2ef7b685b36390cd648b4',
        alias: AW_VALIDATOR_ALIAS,
      },
    ],
  },

  citreatestnet: {
    threshold: 1,
    validators: [
      {
        address: '0x60d7380a41eb95c49be18f141efd2fde5e3dba20',
        alias: AW_VALIDATOR_ALIAS,
      },
    ],
  },

  conflux: {
    threshold: 2,
    validators: [
      {
        address: '0x113dfa1dc9b0a2efb6ad01981e2aad86d3658490',
        alias: AW_VALIDATOR_ALIAS,
      },
      DEFAULT_MERKLY_VALIDATOR,
      DEFAULT_MITOSIS_VALIDATOR,
    ],
  },

  connextsepolia: {
    threshold: 1,
    validators: [
      {
        address: '0xffbbec8c499585d80ef69eb613db624d27e089ab',
        alias: AW_VALIDATOR_ALIAS,
      },
    ],
  },

  conwai: {
    threshold: 2,
    validators: [
      {
        address: '0x949e2cdd7e79f99ee9bbe549540370cdc62e73c3',
        alias: AW_VALIDATOR_ALIAS,
      },
      DEFAULT_MERKLY_VALIDATOR,
      DEFAULT_MITOSIS_VALIDATOR,
    ],
  },

  coredao: {
    threshold: 2,
    validators: [
      {
        address: '0xbd6e158a3f5830d99d7d2bce192695bc4a148de2',
        alias: AW_VALIDATOR_ALIAS,
      },
      DEFAULT_MERKLY_VALIDATOR,
      DEFAULT_MITOSIS_VALIDATOR,
    ],
  },

  corn: {
    threshold: 2,
    validators: [
      {
        address: '0xc80b2e3e38220e02d194a0effa9d5bfe89894c07',
        alias: AW_VALIDATOR_ALIAS,
      },
      DEFAULT_MERKLY_VALIDATOR,
      DEFAULT_MITOSIS_VALIDATOR,
    ],
  },

  coti: {
    threshold: 2,
    validators: [
      {
        address: '0x3c89379537f8beafc54e7e8ab4f8a1cf7974b9f0',
        alias: AW_VALIDATOR_ALIAS,
      },
      DEFAULT_MERKLY_VALIDATOR,
      DEFAULT_MITOSIS_VALIDATOR,
    ],
  },

  cotitestnet: {
    threshold: 1,
    validators: [
      {
        address: '0x5c535dff16237a2cae97c97f9556404cd230c9c0',
        alias: AW_VALIDATOR_ALIAS,
      },
    ],
  },

  cyber: {
    threshold: 2,
    validators: [
      {
        address: '0x94d7119ceeb802173b6924e6cc8c4cd731089a27',
        alias: AW_VALIDATOR_ALIAS,
      },
      DEFAULT_MERKLY_VALIDATOR,
      DEFAULT_MITOSIS_VALIDATOR,
    ],
  },

  deepbrainchain: {
    threshold: 2,
    validators: [
      {
        address: '0x3825ea1e0591b58461cc4aa34867668260c0e6a8',
        alias: AW_VALIDATOR_ALIAS,
      },
      DEFAULT_MERKLY_VALIDATOR,
      DEFAULT_MITOSIS_VALIDATOR,
    ],
  },

  degenchain: {
    threshold: 2,
    validators: [
      {
        address: '0x433e311f19524cd64fb2123ad0aa1579a4e1fc83',
        alias: AW_VALIDATOR_ALIAS,
      },
      DEFAULT_MERKLY_VALIDATOR,
      DEFAULT_MITOSIS_VALIDATOR,
    ],
  },

  dogechain: {
    threshold: 2,
    validators: [
      {
        address: '0xe43f742c37858746e6d7e458bc591180d0cba440',
        alias: AW_VALIDATOR_ALIAS,
      },
      DEFAULT_MERKLY_VALIDATOR,
      DEFAULT_MITOSIS_VALIDATOR,
    ],
  },

  duckchain: {
    threshold: 2,
    validators: [
      {
        address: '0x91d55fe6dac596a6735d96365e21ce4bca21d83c',
        alias: AW_VALIDATOR_ALIAS,
      },
      DEFAULT_MERKLY_VALIDATOR,
      DEFAULT_MITOSIS_VALIDATOR,
    ],
  },

  eclipsemainnet: {
    threshold: 3,
    validators: [
      {
        address: '0xebb52d7eaa3ff7a5a6260bfe5111ce52d57401d0',
        alias: AW_VALIDATOR_ALIAS,
      },
      {
        address: '0x3571223e745dc0fcbdefa164c9b826b90c0d2dac',
        alias: 'Luganodes',
      },
      {
        address: '0xea83086a62617a7228ce4206fae2ea8b0ab23513',
        alias: 'Imperator',
      },
      {
        address: '0x4d4629f5bfeabe66edc7a78da26ef5273c266f97',
        alias: 'Eclipse',
      },
    ],
  },

  eclipsetestnet: {
    threshold: 1,
    validators: [
      {
        address: '0xf344f34abca9a444545b5295066348a0ae22dda3',
        alias: AW_VALIDATOR_ALIAS,
      },
    ],
  },

  ecotestnet: {
    threshold: 1,
    validators: [
      {
        address: '0xb3191420d463c2af8bd9b4a395e100ec5c05915a',
        alias: AW_VALIDATOR_ALIAS,
      },
    ],
  },

  endurance: {
    threshold: 2,
    validators: [
      {
        address: '0x28c5b322da06f184ebf68693c5d19df4d4af13e5',
        alias: AW_VALIDATOR_ALIAS,
      },
      DEFAULT_MERKLY_VALIDATOR,
      {
        address: '0x7419021c0de2772b763e554480158a82a291c1f2',
        alias: 'Fusionist',
      },
    ],
  },

  ethereum: {
    threshold: 6,
    validators: [
      {
        address: '0x03c842db86a6a3e524d4a6615390c1ea8e2b9541',
        alias: AW_VALIDATOR_ALIAS,
      },
      { address: '0x94438a7de38d4548ae54df5c6010c4ebc5239eae', alias: 'DSRV' },
      DEFAULT_ZEE_PRIME_VALIDATOR,
      DEFAULT_EVERSTAKE_VALIDATOR,
      DEFAULT_STAKED_VALIDATOR,
      {
        address: '0xb683b742b378632a5f73a2a5a45801b3489bba44',
        alias: 'AVS: Luganodes',
      },
      {
        address: '0xbf1023eff3dba21263bf2db2add67a0d6bcda2de',
        alias: 'AVS: Pier Two',
      },
      {
        address: '0x5d7442439959af11172bf92d9a8d21cf88d136e3',
        alias: 'P2P',
      },
      DEFAULT_ZKV_VALIDATOR,
    ],
  },

  everclear: {
    threshold: 2,
    validators: [
      {
        address: '0xeff20ae3d5ab90abb11e882cfce4b92ea6c74837',
        alias: AW_VALIDATOR_ALIAS,
      },
      DEFAULT_MERKLY_VALIDATOR,
      {
        address: '0xD79DFbF56ee2268f061cc613027a44A880f61Ba2',
        alias: 'Everclear',
      },
    ],
  },

  evmos: {
    threshold: 2,
    validators: [
      {
        address: '0x8f82387ad8b7b13aa9e06ed3f77f78a77713afe0',
        alias: AW_VALIDATOR_ALIAS,
      },
      DEFAULT_MERKLY_VALIDATOR,
      DEFAULT_MITOSIS_VALIDATOR,
    ],
  },

  fantom: {
    threshold: 2,
    validators: [
      {
        address: '0xa779572028e634e16f26af5dfd4fa685f619457d',
        alias: AW_VALIDATOR_ALIAS,
      },
      DEFAULT_MERKLY_VALIDATOR,
      DEFAULT_MITOSIS_VALIDATOR,
    ],
  },

  flame: {
    threshold: 3,
    validators: [
      {
        address: '0x1fa928ce884fa16357d4b8866e096392d4d81f43',
        alias: AW_VALIDATOR_ALIAS,
      },
      {
        address: '0xa6c998f0db2b56d7a63faf30a9b677c8b9b6faab',
        alias: 'P-OPS',
      },
      {
        address: '0x09f9de08f7570c4146caa708dc9f75b56958957f',
        alias: 'Luganodes',
      },
      {
        address: '0xf1f4ae9959490380ad7863e79c3faf118c1fbf77',
        alias: 'DSRV',
      },
      DEFAULT_TESSELLATED_VALIDATOR,
    ],
  },

  flametestnet: {
    threshold: 1,
    validators: [
      {
        address: '0x0272625243bf2377f87538031fed54e21853cc2d',
        alias: AW_VALIDATOR_ALIAS,
      },
    ],
  },

  flare: {
    threshold: 2,
    validators: [
      {
        address: '0xb65e52be342dba3ab2c088ceeb4290c744809134',
        alias: AW_VALIDATOR_ALIAS,
      },
      DEFAULT_MERKLY_VALIDATOR,
      DEFAULT_MITOSIS_VALIDATOR,
    ],
  },

  flowmainnet: {
    threshold: 3,
    validators: [
      {
        address: '0xe132235c958ca1f3f24d772e5970dd58da4c0f6e',
        alias: AW_VALIDATOR_ALIAS,
      },
      DEFAULT_MERKLY_VALIDATOR,
      DEFAULT_MITOSIS_VALIDATOR,
      {
        address: '0x14ADB9e3598c395Fe3290f3ba706C3816Aa78F59',
        alias: 'Flow Foundation',
      },
    ],
  },

  fluence: {
    threshold: 1,
    validators: [
      {
        address: '0xabc8dd7594783c90a3c0fb760943f78c37ea6d75',
        alias: AW_VALIDATOR_ALIAS,
      },
    ],
  },

  form: {
    threshold: 2,
    validators: [
      {
        address: '0x58554b2e76167993b5fc000d0070a2f883cd333a',
        alias: AW_VALIDATOR_ALIAS,
      },
      DEFAULT_MERKLY_VALIDATOR,
      DEFAULT_MITOSIS_VALIDATOR,
    ],
  },

  formtestnet: {
    threshold: 1,
    validators: [
      {
        address: '0x72ad7fddf16d17ff902d788441151982fa31a7bc',
        alias: AW_VALIDATOR_ALIAS,
      },
    ],
  },

  fractal: {
    threshold: 1,
    validators: [
      {
        address: '0x3476c9652d3371bb01bbb4962516fffee5e73754',
        alias: AW_VALIDATOR_ALIAS,
      },
    ],
  },

  fraxtal: {
    threshold: 4,
    validators: [
      {
        address: '0x4bce180dac6da60d0f3a2bdf036ffe9004f944c1',
        alias: AW_VALIDATOR_ALIAS,
      },
      DEFAULT_TESSELLATED_VALIDATOR,
      {
        address: '0x1c3C3013B863Cf666499Da1A61949AE396E3Ab82',
        alias: 'Enigma',
      },
      {
        address: '0x573e960e07ad74ea2c5f1e3c31b2055994b12797',
        alias: 'Imperator',
      },
      DEFAULT_BWARE_LABS_VALIDATOR,
      {
        address: '0x25b3a88f7cfd3c9f7d7e32b295673a16a6ddbd91',
        alias: 'Luganodes',
      },
    ],
  },

  fuji: {
    threshold: 2,
    validators: [
      {
        address: '0xd8154f73d04cc7f7f0c332793692e6e6f6b2402e',
        alias: AW_VALIDATOR_ALIAS,
      },
      {
        address: '0x895ae30bc83ff1493b9cf7781b0b813d23659857',
        alias: AW_VALIDATOR_ALIAS,
      },
      {
        address: '0x43e915573d9f1383cbf482049e4a012290759e7f',
        alias: AW_VALIDATOR_ALIAS,
      },
    ],
  },

  fusemainnet: {
    threshold: 2,
    validators: [
      {
        address: '0x770c8ec9aac8cec4b2ead583b49acfbc5a1cf8a9',
        alias: AW_VALIDATOR_ALIAS,
      },
      { address: '0x1FE988A1A20cE4141B2081fF8446DA99e11D61d7', alias: 'Fuse' },
      DEFAULT_MERKLY_VALIDATOR,
    ],
  },

  game7: {
    threshold: 1,
    validators: [
      {
        address: '0x691dc4e763514df883155df0952f847b539454c0',
        alias: AW_VALIDATOR_ALIAS,
      },
    ],
  },

  glue: {
    threshold: 2,
    validators: [
      {
        address: '0xbe2ded12f7b023916584836506677ea89a0b6924',
        alias: AW_VALIDATOR_ALIAS,
      },
      DEFAULT_MERKLY_VALIDATOR,
      DEFAULT_MITOSIS_VALIDATOR,
    ],
  },

  gnosis: {
    threshold: 3,
    validators: [
      {
        address: '0xd4df66a859585678f2ea8357161d896be19cc1ca',
        alias: AW_VALIDATOR_ALIAS,
      },
      { address: '0x19fb7e04a1be6b39b6966a0b0c60b929a93ed672', alias: 'DSRV' },
      DEFAULT_EVERSTAKE_VALIDATOR,
      DEFAULT_ZEE_PRIME_VALIDATOR,
    ],
  },

  gravity: {
    threshold: 2,
    validators: [
      {
        address: '0x23d549bf757a02a6f6068e9363196ecd958c974e',
        alias: AW_VALIDATOR_ALIAS,
      },
      DEFAULT_MERKLY_VALIDATOR,
      DEFAULT_MITOSIS_VALIDATOR,
    ],
  },

  guru: {
    threshold: 2,
    validators: [
      {
        address: '0x0d756d9051f12c4de6aee2ee972193a2adfe00ef',
        alias: AW_VALIDATOR_ALIAS,
      },
      DEFAULT_MERKLY_VALIDATOR,
      DEFAULT_MITOSIS_VALIDATOR,
    ],
  },

  harmony: {
    threshold: 2,
    validators: [
      {
        address: '0xd677803a67651974b1c264171b5d7ca8838db8d5',
        alias: AW_VALIDATOR_ALIAS,
      },
      DEFAULT_MERKLY_VALIDATOR,
      DEFAULT_MITOSIS_VALIDATOR,
    ],
  },

  hashkey: {
    threshold: 1,
    validators: [
      {
        address: '0x55007cab8788cdba22844e7a2499cf43347f487a',
        alias: AW_VALIDATOR_ALIAS,
      },
    ],
  },

  hemi: {
    threshold: 2,
    validators: [
      {
        address: '0x312dc72c17d01f3fd0abd31dd9b569bc473266dd',
        alias: AW_VALIDATOR_ALIAS,
      },
      DEFAULT_MERKLY_VALIDATOR,
      DEFAULT_MITOSIS_VALIDATOR,
    ],
  },

  holesky: {
    threshold: 1,
    validators: [
      {
        address: '0x7ab28ad88bb45867137ea823af88e2cb02359c03',
        alias: AW_VALIDATOR_ALIAS,
      },
    ],
  },

  hyperevm: {
    threshold: 3,
    validators: [
      {
        address: '0x01be14a9eceeca36c9c1d46c056ca8c87f77c26f',
        alias: AW_VALIDATOR_ALIAS,
      },
      DEFAULT_MERKLY_VALIDATOR,
      DEFAULT_MITOSIS_VALIDATOR,
      {
        address: '0x36f2bd8200ede5f969d63a0a28e654392c51a193',
        alias: 'Imperator',
      },
    ],
  },

  hyperliquidevmtestnet: {
    threshold: 1,
    validators: [
      {
        address: '0xea673a92a23ca319b9d85cc16b248645cd5158da',
        alias: AW_VALIDATOR_ALIAS,
      },
    ],
  },

  immutablezkevmmainnet: {
    threshold: 2,
    validators: [
      {
        address: '0xbdda85b19a5efbe09e52a32db1a072f043dd66da',
        alias: AW_VALIDATOR_ALIAS,
      },
      DEFAULT_MERKLY_VALIDATOR,
      DEFAULT_MITOSIS_VALIDATOR,
    ],
  },

  inevm: {
    threshold: 2,
    validators: [
      {
        address: '0xf9e35ee88e4448a3673b4676a4e153e3584a08eb',
        alias: AW_VALIDATOR_ALIAS,
      },
      {
        address: '0x0d4e7e64f3a032db30b75fe7acae4d2c877883bc',
        alias: 'Decentrio',
      },
      {
        address: '0x9ab11f38a609940153850df611c9a2175dcffe0f',
        alias: 'Imperator',
      },
    ],
  },

  infinityvmmainnet: {
    threshold: 1,
    validators: [
      {
        address: '0x777c19c87aaa625486dff5aab0a479100f4249ad',
        alias: AW_VALIDATOR_ALIAS,
      },
    ],
  },

  infinityvmmonza: {
    threshold: 1,
    validators: [
      {
        address: '0x635e1ad8646f80ac7bdcd0be9bb69b6f229a31bb',
        alias: AW_VALIDATOR_ALIAS,
      },
    ],
  },

  injective: {
    threshold: 2,
    validators: [
      {
        address: '0xbfb8911b72cfb138c7ce517c57d9c691535dc517',
        alias: AW_VALIDATOR_ALIAS,
      },
      {
        address: '0xd6f6dee54443632490eddc82680d8917544bcb5a',
        alias: 'Decentrio',
      },
      {
        address: '0x9e551b6694bbd295d7d6e6a2540c7d41ce70a3b9',
        alias: 'Imperator',
      },
    ],
  },

  ink: {
    threshold: 4,
    validators: [
      {
        address: '0xb533b8b104522958b984fb258e0684dec0f1a6a5',
        alias: AW_VALIDATOR_ALIAS,
      },
      {
        address: '0xd207a6dfd887d91648b672727ff1aef6223cb15a',
        alias: 'Imperator',
      },

      {
        address: '0xa40203b5301659f1e201848d92f5e81f64f206f5',
        alias: 'Enigma',
      },
      {
        address: '0xff9c1e7b266a36eda0d9177d4236994d94819dc0',
        alias: 'Luganodes',
      },
      DEFAULT_BWARE_LABS_VALIDATOR,
      DEFAULT_TESSELLATED_VALIDATOR,
    ],
  },

  inksepolia: {
    threshold: 1,
    validators: [
      {
        address: '0xe61c846aee275070207fcbf43674eb254f06097a',
        alias: AW_VALIDATOR_ALIAS,
      },
    ],
  },

  kaia: {
    threshold: 2,
    validators: [
      {
        address: '0x9de0b3abb221d19719882fa4d61f769fdc2be9a4',
        alias: AW_VALIDATOR_ALIAS,
      },
      DEFAULT_MERKLY_VALIDATOR,
      DEFAULT_MITOSIS_VALIDATOR,
    ],
  },

  kroma: {
    threshold: 2,
    validators: [
      {
        address: '0x71b83c21342787d758199e4b8634d3a15f02dc6e',
        alias: AW_VALIDATOR_ALIAS,
      },
      DEFAULT_MERKLY_VALIDATOR,
      DEFAULT_MITOSIS_VALIDATOR,
    ],
  },

  kyve: {
    threshold: 1,
    validators: [
      {
        address: '0x8576ddc0cd96325f85528e53f333357afb8bf044',
        alias: AW_VALIDATOR_ALIAS,
      },
    ],
  },

  kyvetestnet: {
    threshold: 1,
    validators: [
      {
        address: '0x3c470ad2640bc0bcb6a790e8cf85e54d34ca92f5',
        alias: AW_VALIDATOR_ALIAS,
      },
    ],
  },

  linea: {
    threshold: 4,
    validators: [
      {
        address: '0xf2d5409a59e0f5ae7635aff73685624904a77d94',
        alias: AW_VALIDATOR_ALIAS,
      },
      DEFAULT_MERKLY_VALIDATOR,
      DEFAULT_MITOSIS_VALIDATOR,
      DEFAULT_BLOCKPI_VALIDATOR,
      DEFAULT_ZKV_VALIDATOR,
      DEFAULT_HASHKEY_CLOUD_VALIDATOR,
    ],
  },

  lisk: {
    threshold: 4,
    validators: [
      {
        address: '0xc0b282aa5bac43fee83cf71dc3dd1797c1090ea5',
        alias: AW_VALIDATOR_ALIAS,
      },
      DEFAULT_TESSELLATED_VALIDATOR,
      {
        address: '0x3DA4ee2801Ec6CC5faD73DBb94B10A203ADb3d9e',
        alias: 'Enigma',
      },
      {
        address: '0x4df6e8878992c300e7bfe98cac6bf7d3408b9cbf',
        alias: 'Imperator',
      },
      DEFAULT_BWARE_LABS_VALIDATOR,
      {
        address: '0xf0da628f3fb71652d48260bad4691054045832ce',
        alias: 'Luganodes',
      },
      {
        address: '0xead4141b6ea149901ce4f4b556953f66d04b1d0c',
        alias: 'Lisk',
      },
    ],
  },

  lukso: {
    threshold: 2,
    validators: [
      {
        address: '0xa5e953701dcddc5b958b5defb677a829d908df6d',
        alias: AW_VALIDATOR_ALIAS,
      },
      DEFAULT_MERKLY_VALIDATOR,
      {
        address: '0x101cE77261245140A0871f9407d6233C8230Ec47',
        alias: 'Blockhunters',
      },
    ],
  },

  lumia: {
    threshold: 2,
    validators: [
      {
        address: '0x9e283254ed2cd2c80f007348c2822fc8e5c2fa5f',
        alias: AW_VALIDATOR_ALIAS,
      },
      DEFAULT_MERKLY_VALIDATOR,
      DEFAULT_MITOSIS_VALIDATOR,
    ],
  },

  lumiaprism: {
    threshold: 2,
    validators: [
      {
        address: '0xb69731640ffd4338a2c9358a935b0274c6463f85',
        alias: AW_VALIDATOR_ALIAS,
      },
      DEFAULT_MERKLY_VALIDATOR,
      DEFAULT_MITOSIS_VALIDATOR,
    ],
  },

  mantapacific: {
    threshold: 5,
    validators: [
      {
        address: '0x8e668c97ad76d0e28375275c41ece4972ab8a5bc',
        alias: AW_VALIDATOR_ALIAS,
      },
      {
        address: '0x521a3e6bf8d24809fde1c1fd3494a859a16f132c',
        alias: 'Cosmostation',
      },
      { address: '0x14025fe092f5f8a401dd9819704d9072196d2125', alias: 'P2P' },
      {
        address: '0x25b9a0961c51e74fd83295293bc029131bf1e05a',
        alias: 'Neutron',
      },
      {
        address: '0xa0eE95e280D46C14921e524B075d0C341e7ad1C8',
        alias: 'Cosmos Spaces',
      },
      { address: '0xcc9a0b6de7fe314bd99223687d784730a75bb957', alias: 'DSRV' },
      { address: '0x42b6de2edbaa62c2ea2309ad85d20b3e37d38acf', alias: 'SG-1' },
    ],
  },

  mantle: {
    threshold: 4,
    validators: [
      {
        address: '0xf930636c5a1a8bf9302405f72e3af3c96ebe4a52',
        alias: AW_VALIDATOR_ALIAS,
      },
      DEFAULT_MERKLY_VALIDATOR,
      DEFAULT_MITOSIS_VALIDATOR,
      DEFAULT_ZKV_VALIDATOR,
      DEFAULT_HASHKEY_CLOUD_VALIDATOR,
      DEFAULT_BLOCKPI_VALIDATOR,
    ],
  },

  matchain: {
    threshold: 2,
    validators: [
      {
        address: '0x8a052f7934b0626105f34f980c875ec03aaf82e8',
        alias: AW_VALIDATOR_ALIAS,
      },
      DEFAULT_MERKLY_VALIDATOR,
      DEFAULT_MITOSIS_VALIDATOR,
    ],
  },

  megaethtestnet: {
    threshold: 1,
    validators: [
      {
        address: '0xf5c8a82f966d2ec8563a2012ccf556ee3f4b25ef',
        alias: AW_VALIDATOR_ALIAS,
      },
    ],
  },

  merlin: {
    threshold: 2,
    validators: [
      {
        address: '0xc1d6600cb9326ed2198cc8c4ba8d6668e8671247',
        alias: AW_VALIDATOR_ALIAS,
      },
      DEFAULT_MERKLY_VALIDATOR,
      DEFAULT_MITOSIS_VALIDATOR,
    ],
  },

  metal: {
    threshold: 4,
    validators: [
      {
        address: '0xd9f7f1a05826197a93df51e86cefb41dfbfb896a',
        alias: AW_VALIDATOR_ALIAS,
      },
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
      DEFAULT_BWARE_LABS_VALIDATOR,
      DEFAULT_TESSELLATED_VALIDATOR,
    ],
  },

  metis: {
    threshold: 4,
    validators: [
      {
        address: '0xc4a3d25107060e800a43842964546db508092260',
        alias: AW_VALIDATOR_ALIAS,
      },
      DEFAULT_MERKLY_VALIDATOR,
      DEFAULT_MITOSIS_VALIDATOR,
      DEFAULT_BLOCKPI_VALIDATOR,
      DEFAULT_ZKV_VALIDATOR,
      DEFAULT_HASHKEY_CLOUD_VALIDATOR,
    ],
  },

  miraclechain: {
    threshold: 1,
    validators: [
      {
        address: '0x8fc655174e99194399822ce2d3a0f71d9fc2de7b',
        alias: AW_VALIDATOR_ALIAS,
      },
    ],
  },

  milkyway: {
    threshold: 1,
    validators: [
      {
        address: '0x9985e0c6df8e25b655b46a317af422f5e7756875',
        alias: AW_VALIDATOR_ALIAS,
      },
    ],
  },

  milkywaytestnet: {
    threshold: 1,
    validators: [
      {
        address: '0x65c7581e14efdf4d9c5320882170f022835bd742',
        alias: AW_VALIDATOR_ALIAS,
      },
    ],
  },

  mint: {
    threshold: 2,
    validators: [
      {
        address: '0xfed01ccdd7a65e8a6ad867b7fb03b9eb47777ac9',
        alias: AW_VALIDATOR_ALIAS,
      },
      DEFAULT_MERKLY_VALIDATOR,
      { address: '0x0230505530b80186f8cdccfaf9993eb97aebe98a', alias: 'Mint' },
    ],
  },

  mode: {
    threshold: 4,
    validators: [
      {
        address: '0x7eb2e1920a4166c19d6884c1cec3d2cf356fc9b7',
        alias: AW_VALIDATOR_ALIAS,
      },
      DEFAULT_TESSELLATED_VALIDATOR,
      {
        address: '0x65C140e3a05F33192384AffEF985696Fe3cDDE42',
        alias: 'Enigma',
      },
      {
        address: '0x20eade18ea2af6dfd54d72b3b5366b40fcb47f4b',
        alias: 'Imperator',
      },
      DEFAULT_BWARE_LABS_VALIDATOR,
      {
        address: '0x485a4f0009d9afbbf44521016f9b8cdd718e36ea',
        alias: 'Luganodes',
      },
    ],
  },

  modetestnet: {
    threshold: 1,
    validators: [
      {
        address: '0x9a9de3e406ab3e4ff12aa03ca9b868b48dc40402',
        alias: AW_VALIDATOR_ALIAS,
      },
    ],
  },

  molten: {
    threshold: 2,
    validators: [
      {
        address: '0xad5aa33f0d67f6fa258abbe75458ea4908f1dc9f',
        alias: AW_VALIDATOR_ALIAS,
      },
      DEFAULT_MERKLY_VALIDATOR,
      DEFAULT_MITOSIS_VALIDATOR,
    ],
  },

  monadtestnet: {
    threshold: 1,
    validators: [
      {
        address: '0x734628f55694d2a5f4de3e755ccb40ecd72b16d9',
        alias: AW_VALIDATOR_ALIAS,
      },
    ],
  },

  moonbeam: {
    threshold: 3,
    validators: [
      {
        address: '0x2225e2f4e9221049456da93b71d2de41f3b6b2a8',
        alias: AW_VALIDATOR_ALIAS,
      },
      { address: '0x645428d198d2e76cbd9c1647f5c80740bb750b97', alias: 'DSRV' },
      DEFAULT_EVERSTAKE_VALIDATOR,
      DEFAULT_STAKED_VALIDATOR,
    ],
  },

  morph: {
    threshold: 2,
    validators: [
      {
        address: '0x4884535f393151ec419add872100d352f71af380',
        alias: AW_VALIDATOR_ALIAS,
      },
      DEFAULT_MERKLY_VALIDATOR,
      DEFAULT_MITOSIS_VALIDATOR,
    ],
  },

  nero: {
    threshold: 2,
    validators: [
      {
        address: '0xb86f872df37f11f33acbe75b6ed208b872b57183',
        alias: AW_VALIDATOR_ALIAS,
      },
      DEFAULT_MERKLY_VALIDATOR,
      DEFAULT_MITOSIS_VALIDATOR,
    ],
  },

  neuratestnet: {
    threshold: 1,
    validators: [
      {
        address: '0xc14514a91d0ee90ba3070abb6bfb45a10e6d341d',
        alias: AW_VALIDATOR_ALIAS,
      },
    ],
  },

  neutron: {
    threshold: 4,
    validators: [
      {
        address: '0xa9b8c1f4998f781f958c63cfcd1708d02f004ff0',
        alias: AW_VALIDATOR_ALIAS,
      },
      {
        address: '0xb65438a014fb05fbadcfe35bc6e25d372b6ba460',
        alias: 'Cosmostation',
      },
      { address: '0x42fa752defe92459370a052b6387a87f7de9b80c', alias: 'P2P' },
      {
        address: '0xc79503a3e3011535a9c60f6d21f76f59823a38bd',
        alias: 'Neutron',
      },
      { address: '0x47aa126e05933b95c5eb90b26e6b668d84f4b25a', alias: 'DSRV' },
      {
        address: '0x54b2cca5091b098a1a993dec03c4d1ee9af65999',
        alias: 'Cosmos Spaces',
      },
      { address: '0x42b6de2edbaa62c2ea2309ad85d20b3e37d38acf', alias: 'SG-1' },
    ],
  },

  nibiru: {
    threshold: 2,
    validators: [
      {
        address: '0xba9779d84a8efba1c6bc66326d875c3611a24b24',
        alias: AW_VALIDATOR_ALIAS,
      },
      DEFAULT_MERKLY_VALIDATOR,
      DEFAULT_MITOSIS_VALIDATOR,
    ],
  },

  nobletestnet: {
    threshold: 1,
    validators: [
      {
        address: '0xc30427bd74fdcf179a15b9a6e3c4e1d66104726a',
        alias: AW_VALIDATOR_ALIAS,
      },
    ],
  },

  odysseytestnet: {
    threshold: 1,
    validators: [
      {
        address: '0xcc0a6e2d6aa8560b45b384ced7aa049870b66ea3',
        alias: AW_VALIDATOR_ALIAS,
      },
    ],
  },

  ontology: {
    threshold: 1,
    validators: [
      {
        address: '0x2578b0a330c492e1a1682684e27e6a93649befd5',
        alias: AW_VALIDATOR_ALIAS,
      },
    ],
  },

  oortmainnet: {
    threshold: 2,
    validators: [
      {
        address: '0x9b7ff56cd9aa69006f73f1c5b8c63390c706a5d7',
        alias: AW_VALIDATOR_ALIAS,
      },
      DEFAULT_MITOSIS_VALIDATOR,
      { address: '0xfa94a494f01d1034b8cea025ca4c2a7e31ca39a1', alias: 'Oort' },
    ],
  },

  opbnb: {
    threshold: 2,
    validators: [
      {
        address: '0x1bdf52749ef2411ab9c28742dea92f209e96c9c4',
        alias: AW_VALIDATOR_ALIAS,
      },
      DEFAULT_MERKLY_VALIDATOR,
      DEFAULT_MITOSIS_VALIDATOR,
    ],
  },

  optimism: {
    threshold: 4,
    validators: [
      {
        address: '0x20349eadc6c72e94ce38268b96692b1a5c20de4f',
        alias: AW_VALIDATOR_ALIAS,
      },
      DEFAULT_TESSELLATED_VALIDATOR,
      {
        address: '0xd8c1cCbfF28413CE6c6ebe11A3e29B0D8384eDbB',
        alias: 'Enigma',
      },
      {
        address: '0x1b9e5f36c4bfdb0e3f0df525ef5c888a4459ef99',
        alias: 'Imperator',
      },
      DEFAULT_BWARE_LABS_VALIDATOR,
      {
        address: '0xf9dfaa5c20ae1d84da4b2696b8dc80c919e48b12',
        alias: 'Luganodes',
      },
    ],
  },

  optimismsepolia: {
    threshold: 1,
    validators: [
      {
        address: '0x03efe4d0632ee15685d7e8f46dea0a874304aa29',
        alias: AW_VALIDATOR_ALIAS,
      },
    ],
  },

  orderly: {
    threshold: 2,
    validators: [
      {
        address: '0xec3dc91f9fa2ad35edf5842aa764d5573b778bb6',
        alias: AW_VALIDATOR_ALIAS,
      },
      DEFAULT_MERKLY_VALIDATOR,
      DEFAULT_MITOSIS_VALIDATOR,
    ],
  },

  osmosis: {
    threshold: 1,
    validators: [
      {
        address: '0xea483af11c19fa41b16c31d1534c2a486a92bcac',
        alias: AW_VALIDATOR_ALIAS,
      },
    ],
  },

  peaq: {
    threshold: 1,
    validators: [
      {
        address: '0x7f7fe70b676f65097e2a1e2683d0fc96ea8fea49',
        alias: AW_VALIDATOR_ALIAS,
      },
    ],
  },

  plume: {
    threshold: 2,
    validators: [
      {
        address: '0x63c9b5ea28710d956a51f0f746ee8df81215663f',
        alias: AW_VALIDATOR_ALIAS,
      },
      DEFAULT_MERKLY_VALIDATOR,
      DEFAULT_MITOSIS_VALIDATOR,
    ],
  },

  plumetestnet: {
    threshold: 1,
    validators: [
      {
        address: '0xe765a214849f3ecdf00793b97d00422f2d408ea6',
        alias: AW_VALIDATOR_ALIAS,
      },
    ],
  },

  plumetestnet2: {
    threshold: 1,
    validators: [
      {
        address: '0x16637c78e1ea169132efcf4df8ebd03de349e740',
        alias: AW_VALIDATOR_ALIAS,
      },
    ],
  },

  polygon: {
    threshold: 3,
    validators: [
      {
        address: '0x12ecb319c7f4e8ac5eb5226662aeb8528c5cefac',
        alias: AW_VALIDATOR_ALIAS,
      },
      { address: '0x008f24cbb1cc30ad0f19f2516ca75730e37efb5f', alias: 'DSRV' },
      DEFAULT_EVERSTAKE_VALIDATOR,
      DEFAULT_ZEE_PRIME_VALIDATOR,
    ],
  },

  polygonamoy: {
    threshold: 1,
    validators: [
      {
        address: '0xf0290b06e446b320bd4e9c4a519420354d7ddccd',
        alias: AW_VALIDATOR_ALIAS,
      },
    ],
  },

  polygonzkevm: {
    threshold: 2,
    validators: [
      {
        address: '0x86f2a44592bb98da766e880cfd70d3bbb295e61a',
        alias: AW_VALIDATOR_ALIAS,
      },
      { address: '0x865818fe1db986036d5fd0466dcd462562436d1a', alias: 'DSRV' },
      DEFAULT_EVERSTAKE_VALIDATOR,
    ],
  },

  polynomialfi: {
    threshold: 2,
    validators: [
      {
        address: '0x23d348c2d365040e56f3fee07e6897122915f513',
        alias: AW_VALIDATOR_ALIAS,
      },
      DEFAULT_MERKLY_VALIDATOR,
      DEFAULT_MITOSIS_VALIDATOR,
    ],
  },

  prom: {
    threshold: 2,
    validators: [
      {
        address: '0xb0c4042b7c9a95345be8913f4cdbf4043b923d98',
        alias: AW_VALIDATOR_ALIAS,
      },
      DEFAULT_MERKLY_VALIDATOR,
      DEFAULT_MITOSIS_VALIDATOR,
    ],
  },

  proofofplay: {
    threshold: 2,
    validators: [
      {
        address: '0xcda40baa71970a06e5f55e306474de5ca4e21c3b',
        alias: AW_VALIDATOR_ALIAS,
      },
      DEFAULT_MERKLY_VALIDATOR,
      DEFAULT_MITOSIS_VALIDATOR,
    ],
  },

  rarichain: {
    threshold: 2,
    validators: [
      {
        address: '0xeac012df7530720dd7d6f9b727e4fe39807d1516',
        alias: AW_VALIDATOR_ALIAS,
      },
      DEFAULT_MERKLY_VALIDATOR,
      DEFAULT_MITOSIS_VALIDATOR,
    ],
  },

  reactive: {
    threshold: 2,
    validators: [
      {
        address: '0x45768525f6c5ca2e4e7cc50d405370eadee2d624',
        alias: AW_VALIDATOR_ALIAS,
      },
      DEFAULT_MERKLY_VALIDATOR,
      DEFAULT_MITOSIS_VALIDATOR,
    ],
  },

  real: {
    threshold: 2,
    validators: [
      {
        address: '0xaebadd4998c70b05ce8715cf0c3cb8862fe0beec',
        alias: AW_VALIDATOR_ALIAS,
      },
      DEFAULT_MERKLY_VALIDATOR,
      DEFAULT_MITOSIS_VALIDATOR,
    ],
  },

  redstone: {
    threshold: 3,
    validators: [
      {
        address: '0x1400b9737007f7978d8b4bbafb4a69c83f0641a7',
        alias: AW_VALIDATOR_ALIAS,
      },
      DEFAULT_MERKLY_VALIDATOR,
      DEFAULT_MITOSIS_VALIDATOR,
      {
        address: '0x101cE77261245140A0871f9407d6233C8230Ec47',
        alias: 'Blockhunters',
      },
    ],
  },

  rivalz: {
    threshold: 2,
    validators: [
      {
        address: '0xf87c3eb3dde972257b0d6d110bdadcda951c0dc1',
        alias: AW_VALIDATOR_ALIAS,
      },
      DEFAULT_MERKLY_VALIDATOR,
      DEFAULT_MITOSIS_VALIDATOR,
    ],
  },

  rometestnet: {
    threshold: 1,
    validators: [
      {
        address: '0x259eec09dd54c34043bc991f1aae014294235b8e',
        alias: AW_VALIDATOR_ALIAS,
      },
    ],
  },

  ronin: {
    threshold: 4,
    validators: [
      {
        address: '0xa3e11929317e4a871c3d47445ea7bb8c4976fd8a',
        alias: AW_VALIDATOR_ALIAS,
      },
      DEFAULT_MERKLY_VALIDATOR,
      DEFAULT_MITOSIS_VALIDATOR,
      DEFAULT_BLOCKPI_VALIDATOR,
      DEFAULT_ZKV_VALIDATOR,
      DEFAULT_HASHKEY_CLOUD_VALIDATOR,
    ],
  },

  rootstockmainnet: {
    threshold: 2,
    validators: [
      {
        address: '0x8675eb603d62ab64e3efe90df914e555966e04ac',
        alias: AW_VALIDATOR_ALIAS,
      },
      DEFAULT_MERKLY_VALIDATOR,
      DEFAULT_MITOSIS_VALIDATOR,
    ],
  },

  sanko: {
    threshold: 2,
    validators: [
      {
        address: '0x795c37d5babbc44094b084b0c89ed9db9b5fae39',
        alias: AW_VALIDATOR_ALIAS,
      },
      DEFAULT_MERKLY_VALIDATOR,
      DEFAULT_MITOSIS_VALIDATOR,
    ],
  },

  scroll: {
    threshold: 3,
    validators: [
      {
        address: '0xad557170a9f2f21c35e03de07cb30dcbcc3dff63',
        alias: AW_VALIDATOR_ALIAS,
      },
      DEFAULT_STAKED_VALIDATOR,
      DEFAULT_EVERSTAKE_VALIDATOR,
      { address: '0xbac4ac39f1d8b5ef15f26fdb1294a7c9aba3f948', alias: 'DSRV' },
    ],
  },

  scrollsepolia: {
    threshold: 2,
    validators: [
      {
        address: '0xbe18dbd758afb367180260b524e6d4bcd1cb6d05',
        alias: AW_VALIDATOR_ALIAS,
      },
      {
        address: '0x9a11ed23ae962974018ab45bc133caabff7b3271',
        alias: AW_VALIDATOR_ALIAS,
      },
      {
        address: '0x7867bea3c9761fe64e6d124b171f91fd5dd79644',
        alias: AW_VALIDATOR_ALIAS,
      },
    ],
  },

  sei: {
    threshold: 3,
    validators: [
      {
        address: '0x9920d2dbf6c85ffc228fdc2e810bf895732c6aa5',
        alias: AW_VALIDATOR_ALIAS,
      },
      DEFAULT_MERKLY_VALIDATOR,
      {
        address: '0x101cE77261245140A0871f9407d6233C8230Ec47',
        alias: 'Blockhunters',
      },
      DEFAULT_MITOSIS_VALIDATOR,
    ],
  },

  sepolia: {
    threshold: 2,
    validators: [
      {
        address: '0xb22b65f202558adf86a8bb2847b76ae1036686a5',
        alias: AW_VALIDATOR_ALIAS,
      },
      {
        address: '0x469f0940684d147defc44f3647146cb90dd0bc8e',
        alias: AW_VALIDATOR_ALIAS,
      },
      {
        address: '0xd3c75dcf15056012a4d74c483a0c6ea11d8c2b83',
        alias: AW_VALIDATOR_ALIAS,
      },
    ],
  },

  shibarium: {
    threshold: 2,
    validators: [
      {
        address: '0xfa33391ee38597cbeef72ccde8c9e13e01e78521',
        alias: AW_VALIDATOR_ALIAS,
      },
      DEFAULT_MERKLY_VALIDATOR,
      DEFAULT_MITOSIS_VALIDATOR,
    ],
  },

  snaxchain: {
    threshold: 2,
    validators: [
      {
        address: '0x2c25829ae32a772d2a49f6c4b34f8b01fd03ef9e',
        alias: AW_VALIDATOR_ALIAS,
      },
      DEFAULT_MERKLY_VALIDATOR,
      DEFAULT_MITOSIS_VALIDATOR,
    ],
  },

  solanadevnet: {
    threshold: 2,
    validators: [
      {
        address: '0xec0f73dbc5b1962a20f7dcbe07c98414025b0c43',
        alias: AW_VALIDATOR_ALIAS,
      },
      {
        address: '0x9c20a149dfa09ea9f77f5a7ca09ed44f9c025133',
        alias: AW_VALIDATOR_ALIAS,
      },
      {
        address: '0x967c5ecdf2625ae86580bd203b630abaaf85cd62',
        alias: AW_VALIDATOR_ALIAS,
      },
    ],
  },

  solanamainnet: {
    threshold: 3,
    validators: [
      {
        address: '0x28464752829b3ea59a497fca0bdff575c534c3ff',
        alias: AW_VALIDATOR_ALIAS,
      },
      {
        address: '0x2b7514a2f77bd86bbf093fe6bb67d8611f51c659',
        alias: 'Luganodes',
      },
      { address: '0xd90ea26ff731d967c5ea660851f7d63cb04ab820', alias: 'DSRV' },
      DEFAULT_EVERSTAKE_VALIDATOR,
      {
        address: '0xcb6bcbd0de155072a7ff486d9d7286b0f71dcc2d',
        alias: 'Eclipse',
      },
    ],
  },

  solanatestnet: {
    threshold: 1,
    validators: [
      {
        address: '0xd4ce8fa138d4e083fc0e480cca0dbfa4f5f30bd5',
        alias: AW_VALIDATOR_ALIAS,
      },
    ],
  },

  somniatestnet: {
    threshold: 1,
    validators: [
      {
        address: '0xb3b27a27bfa94002d344e9cf5217a0e3502e018b',
        alias: AW_VALIDATOR_ALIAS,
      },
    ],
  },

  soneium: {
    threshold: 4,
    validators: [
      {
        address: '0xd4b7af853ed6a2bfc329ecef545df90c959cbee8',
        alias: AW_VALIDATOR_ALIAS,
      },
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
      DEFAULT_BWARE_LABS_VALIDATOR,
      DEFAULT_TESSELLATED_VALIDATOR,
    ],
  },

  soneiumtestnet: {
    threshold: 1,
    validators: [
      {
        address: '0x2e2101020ccdbe76aeda1c27823b0150f43d0c63',
        alias: AW_VALIDATOR_ALIAS,
      },
    ],
  },

  sonic: {
    threshold: 4,
    validators: [
      {
        address: '0xa313d72dbbd3fa51a2ed1611ea50c37946fa42f7',
        alias: AW_VALIDATOR_ALIAS,
      },
      DEFAULT_MERKLY_VALIDATOR,
      DEFAULT_MITOSIS_VALIDATOR,
      DEFAULT_BLOCKPI_VALIDATOR,
      DEFAULT_ZKV_VALIDATOR,
      DEFAULT_HASHKEY_CLOUD_VALIDATOR,
    ],
  },

  sonicblaze: {
    threshold: 1,
    validators: [
      {
        address: '0xe5b98110d0688691ea280edea9a4faa1e3617ba1',
        alias: AW_VALIDATOR_ALIAS,
      },
    ],
  },

  sonicsvm: {
    threshold: 3,
    validators: [
      {
        address: '0xf21f46905d8d09f76bc8c503f856e5466bc5ffea',
        alias: AW_VALIDATOR_ALIAS,
      },
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
    validators: [
      {
        address: '0x83d4ef35f170ec822a0eaadb22a0c40003d8de23',
        alias: AW_VALIDATOR_ALIAS,
      },
    ],
  },

  soon: {
    threshold: 2,
    validators: [
      {
        address: '0x0E6723b3C1eD3Db0C24347AA2cf16D28BC2a1F76',
        alias: AW_VALIDATOR_ALIAS,
      },
      DEFAULT_MERKLY_VALIDATOR,
      DEFAULT_MITOSIS_VALIDATOR,
    ],
  },

  sophon: {
    threshold: 2,
    validators: [
      {
        address: '0xb84c5d02120ed0b39d0f78bbc0e298d89ebcd10b',
        alias: AW_VALIDATOR_ALIAS,
      },
      DEFAULT_MERKLY_VALIDATOR,
      DEFAULT_MITOSIS_VALIDATOR,
    ],
  },

  story: {
    threshold: 2,
    validators: [
      {
        address: '0x501eda013378c60557d763df98d617b6ba55447a',
        alias: AW_VALIDATOR_ALIAS,
      },
      DEFAULT_MERKLY_VALIDATOR,
      DEFAULT_MITOSIS_VALIDATOR,
    ],
  },

  stride: {
    threshold: 6,
    validators: [
      DEFAULT_EVERSTAKE_VALIDATOR,
      {
        address: '0x88f0E5528131b10e3463C4c68108217Dd33462ac',
        alias: 'Cosmostation',
      },
      { address: '0xa3eaa1216827ad63dd9db43f6168258a89177990', alias: 'DSRV' },
      {
        address: '0x3f869C36110F00D10dC74cca3ac1FB133cf019ad',
        alias: 'Polkachu',
      },
      {
        address: '0x502dC6135d16E74056f609FBAF76846814C197D3',
        alias: 'Strangelove',
      },
      {
        address: '0xc36979780c1aD43275182600a61Ce41f1C390FbE',
        alias: 'Imperator',
      },
      {
        address: '0x87460dcEd16a75AECdBffD4189111d30B099f5b0',
        alias: 'Enigma',
      },
      { address: '0xf54982134e52Eb7253236943FBffE0886C5bde0C', alias: 'L5' },
      {
        address: '0x5937b7cE1029C3Ec4bD8e1AaCc0C0f9422654D7d',
        alias: 'Stakecito',
      },
      DEFAULT_STAKED_VALIDATOR,
    ],
  },

  subtensor: {
    threshold: 4,
    validators: [
      {
        address: '0xd5f8196d7060b85bea491f0b52a671e05f3d10a2',
        alias: AW_VALIDATOR_ALIAS,
      },
      DEFAULT_MERKLY_VALIDATOR,
      DEFAULT_MITOSIS_VALIDATOR,
      DEFAULT_BLOCKPI_VALIDATOR,
      DEFAULT_ZKV_VALIDATOR,
      DEFAULT_TESSELLATED_VALIDATOR,
    ],
  },

  subtensortestnet: {
    threshold: 1,
    validators: [
      {
        address: '0xbe2cd57e9fd46b12107cfec7a2db61aa23edbe33',
        alias: AW_VALIDATOR_ALIAS,
      },
    ],
  },

  superpositionmainnet: {
    threshold: 2,
    validators: [
      {
        address: '0x3f489acdd341c6b4dd86293fa2cc5ecc8ccf4f84',
        alias: AW_VALIDATOR_ALIAS,
      },
      DEFAULT_MERKLY_VALIDATOR,
      DEFAULT_MITOSIS_VALIDATOR,
    ],
  },

  superpositiontestnet: {
    threshold: 1,
    validators: [
      {
        address: '0x1d3168504b23b73cdf9c27f13bb0a595d7f1a96a',
        alias: AW_VALIDATOR_ALIAS,
      },
    ],
  },

  superseed: {
    threshold: 4,
    validators: [
      {
        address: '0xdc2b87cb555411bb138d3a4e5f7832c87fae2b88',
        alias: AW_VALIDATOR_ALIAS,
      },
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
      DEFAULT_BWARE_LABS_VALIDATOR,
      DEFAULT_TESSELLATED_VALIDATOR,
    ],
  },

  svmbnb: {
    threshold: 1,
    validators: [
      {
        address: '0xabcd4dac2d06ae30c011d25b0c2c193873116a14',
        alias: AW_VALIDATOR_ALIAS,
      },
    ],
  },

  swell: {
    threshold: 4,
    validators: [
      {
        address: '0x4f51e4f4c7fb45d82f91568480a1a2cfb69216ed',
        alias: AW_VALIDATOR_ALIAS,
      },
      {
        address: '0x9eadf9217be22d9878e0e464727a2176d5c69ff8',
        alias: 'Luganodes',
      },
      {
        address: '0xa5a23fa2a67782bbf1a540cb5ca6a47a0f3f66fb',
        alias: 'Imperator',
      },
      {
        address: '0x3f707633ccab09d2978e29107c0bbef8a993e7a0',
        alias: 'Enigma',
      },
      DEFAULT_BWARE_LABS_VALIDATOR,
      DEFAULT_TESSELLATED_VALIDATOR,
    ],
  },

  taiko: {
    threshold: 3,
    validators: [
      {
        address: '0xa930073c8f2d0b2f7423ea32293e0d1362e65d79',
        alias: AW_VALIDATOR_ALIAS,
      },
      DEFAULT_MERKLY_VALIDATOR,
      DEFAULT_MITOSIS_VALIDATOR,
      {
        address: '0x2F007c82672F2Bb97227D4e3F80Ac481bfB40A2a',
        alias: 'Luganodes',
      },
    ],
  },

  tangle: {
    threshold: 2,
    validators: [
      {
        address: '0x1ee52cbbfacd7dcb0ba4e91efaa6fbc61602b15b',
        alias: AW_VALIDATOR_ALIAS,
      },
      DEFAULT_MERKLY_VALIDATOR,
      {
        address: '0xe271ef9a6e312540f099a378865432fa73f26689',
        alias: 'Tangle',
      },
    ],
  },

  telos: {
    threshold: 2,
    validators: [
      {
        address: '0xcb08410b14d3adf0d0646f0c61cd07e0daba8e54',
        alias: AW_VALIDATOR_ALIAS,
      },
      DEFAULT_MERKLY_VALIDATOR,
      DEFAULT_MITOSIS_VALIDATOR,
    ],
  },

  torus: {
    threshold: 2,
    validators: [
      {
        address: '0x96982a325c28a842bc8cf61b63000737bb9f1f7d',
        alias: AW_VALIDATOR_ALIAS,
      },
      DEFAULT_MERKLY_VALIDATOR,
      DEFAULT_MITOSIS_VALIDATOR,
    ],
  },

  treasure: {
    threshold: 3,
    validators: [
      {
        address: '0x6ad994819185553e8baa01533f0cd2c7cadfe6cc',
        alias: AW_VALIDATOR_ALIAS,
      },
      {
        address: '0x278460fa51ff448eb53ffa62951b4b8e3e8f74e3',
        alias: 'P2P',
      },
      {
        address: '0xe92ff70bb463e2aa93426fd2ba51afc39567d426',
        alias: 'Treasure',
      },
      DEFAULT_MITOSIS_VALIDATOR,
      DEFAULT_HASHKEY_CLOUD_VALIDATOR,
    ],
  },

  trumpchain: {
    threshold: 2,
    validators: [
      {
        address: '0x3ada634c8dfa57a67f5f22ca757b35cde6cfab5e',
        alias: AW_VALIDATOR_ALIAS,
      },
      DEFAULT_MERKLY_VALIDATOR,
      {
        address: '0xcF8151b8aEFfF4e22F6B48fe2Ffe2d60F00C890C',
        alias: 'Caldera',
      },
    ],
  },

  unichain: {
    threshold: 4,
    validators: [
      {
        address: '0x9773a382342ebf604a2e5de0a1f462fb499e28b1',
        alias: AW_VALIDATOR_ALIAS,
      },
      {
        address: '0xa2549be30fb852c210c2fe8e7639039dca779936',
        alias: 'Imperator',
      },

      {
        address: '0xbcbed4d11e946844162cd92c6d09d1cf146b4006',
        alias: 'Enigma',
      },
      {
        address: '0xa9d517776fe8beba7d67c21cac1e805bd609c08e',
        alias: 'Luganodes',
      },
      DEFAULT_BWARE_LABS_VALIDATOR,
      DEFAULT_TESSELLATED_VALIDATOR,
    ],
  },

  unichaintestnet: {
    threshold: 1,
    validators: [
      {
        address: '0x5e99961cf71918308c3b17ef21b5f515a4f86fe5',
        alias: AW_VALIDATOR_ALIAS,
      },
    ],
  },

  unitzero: {
    threshold: 2,
    validators: [
      {
        address: '0x18818e3ad2012728465d394f2e3c0ea2357ae9c5',
        alias: AW_VALIDATOR_ALIAS,
      },
      DEFAULT_MERKLY_VALIDATOR,
      DEFAULT_MITOSIS_VALIDATOR,
    ],
  },

  vana: {
    threshold: 3,
    validators: [
      {
        address: '0xfdf3b0dfd4b822d10cacb15c8ae945ea269e7534',
        alias: AW_VALIDATOR_ALIAS,
      },
      DEFAULT_MERKLY_VALIDATOR,
      DEFAULT_MITOSIS_VALIDATOR,
      {
        address: '0xba2f4f89cae6863d8b49e4ca0208ed48ad9ac354',
        alias: 'P2P',
      },
    ],
  },

  viction: {
    threshold: 2,
    validators: [
      DEFAULT_BLOCKPI_VALIDATOR,
      { address: '0xa3f93fe365bf99f431d8fde740b140615e24f99b', alias: 'RockX' },
      {
        address: '0x1f87c368f8e05a85ef9126d984a980a20930cb9c',
        alias: AW_VALIDATOR_ALIAS,
      },
    ],
  },

  weavevmtestnet: {
    threshold: 1,
    validators: [
      {
        address: '0x6d2ee6688de903bb31f3ae2ea31da87b697f7f40',
        alias: AW_VALIDATOR_ALIAS,
      },
    ],
  },

  worldchain: {
    threshold: 4,
    validators: [
      {
        address: '0x31048785845325b22817448b68d08f8a8fe36854',
        alias: AW_VALIDATOR_ALIAS,
      },
      {
        address: '0x11e2a683e83617f186614071e422b857256a9aae',
        alias: 'Imperator',
      },
      DEFAULT_MERKLY_VALIDATOR,
      DEFAULT_ZKV_VALIDATOR,
      DEFAULT_HASHKEY_CLOUD_VALIDATOR,
      DEFAULT_BLOCKPI_VALIDATOR,
    ],
  },

  xai: {
    threshold: 2,
    validators: [
      {
        address: '0xe993f01fea86eb64cda45ae5af1d5be40ac0c7e9',
        alias: AW_VALIDATOR_ALIAS,
      },
      DEFAULT_MERKLY_VALIDATOR,
      DEFAULT_MITOSIS_VALIDATOR,
    ],
  },

  xlayer: {
    threshold: 2,
    validators: [
      {
        address: '0xa2ae7c594703e988f23d97220717c513db638ea3',
        alias: AW_VALIDATOR_ALIAS,
      },
      {
        address: '0xfed056cC0967F5BC9C6350F6C42eE97d3983394d',
        alias: 'Imperator',
      },
      DEFAULT_MERKLY_VALIDATOR,
    ],
  },

  xpla: {
    threshold: 2,
    validators: [
      {
        address: '0xc11cba01d67f2b9f0288c4c8e8b23c0eca03f26e',
        alias: AW_VALIDATOR_ALIAS,
      },
      DEFAULT_MERKLY_VALIDATOR,
      DEFAULT_MITOSIS_VALIDATOR,
    ],
  },

  zeronetwork: {
    threshold: 2,
    validators: [
      {
        address: '0x1bd9e3f8a90ea1a13b0f2838a1858046368aad87',
        alias: AW_VALIDATOR_ALIAS,
      },
      DEFAULT_MERKLY_VALIDATOR,
      DEFAULT_MITOSIS_VALIDATOR,
    ],
  },

  zetachain: {
    threshold: 3,
    validators: [
      {
        address: '0xa3bca0b80317dbf9c7dce16a16ac89f4ff2b23ef',
        alias: AW_VALIDATOR_ALIAS,
      },
      DEFAULT_MERKLY_VALIDATOR,
      {
        address: '0x101cE77261245140A0871f9407d6233C8230Ec47',
        alias: 'Blockhunters',
      },
      DEFAULT_MITOSIS_VALIDATOR,
    ],
  },

  zircuit: {
    threshold: 3,
    validators: [
      {
        address: '0x169ec400cc758fef3df6a0d6c51fbc6cdd1015bb',
        alias: AW_VALIDATOR_ALIAS,
      },
      {
        address: '0x7aC6584c068eb2A72d4Db82A7B7cd5AB34044061',
        alias: 'Luganodes',
      },
      {
        address: '0x0180444c9342BD672867Df1432eb3dA354413a6E',
        alias: 'Hashkey Cloud',
      },
      { address: '0x1da9176C2CE5cC7115340496fa7D1800a98911CE', alias: 'Renzo' },
    ],
  },

  zklink: {
    threshold: 2,
    validators: [
      {
        address: '0x217a8cb4789fc45abf56cb6e2ca96f251a5ac181',
        alias: AW_VALIDATOR_ALIAS,
      },
      DEFAULT_MERKLY_VALIDATOR,
      DEFAULT_MITOSIS_VALIDATOR,
    ],
  },

  zksync: {
    threshold: 3,
    validators: [
      {
        address: '0xadd1d39ce7a687e32255ac457cf99a6d8c5b5d1a',
        alias: AW_VALIDATOR_ALIAS,
      },
      DEFAULT_MERKLY_VALIDATOR,
      DEFAULT_MITOSIS_VALIDATOR,
      {
        address: '0x75237d42ce8ea27349a0254ada265db94157e0c1',
        alias: 'Imperator',
      },
    ],
  },

  zoramainnet: {
    threshold: 3,
    validators: [
      {
        address: '0x35130945b625bb69b28aee902a3b9a76fa67125f',
        alias: AW_VALIDATOR_ALIAS,
      },
      {
        address: '0x7089b6352d37d23fb05a7fee4229c78e038fba09',
        alias: 'Imperator',
      },
      DEFAULT_MERKLY_VALIDATOR,
      DEFAULT_MITOSIS_VALIDATOR,
    ],
  },
};
