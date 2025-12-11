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

  adichain: {
    threshold: 2,
    validators: [
      {
        address: '0x4b11a6310bc06300b529b0397683ca3376407eca',
        alias: AW_VALIDATOR_ALIAS,
      },
      DEFAULT_MITOSIS_VALIDATOR,
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
    threshold: 3,
    validators: [
      {
        address: '0x3fb8263859843bffb02950c492d492cae169f4cf',
        alias: AW_VALIDATOR_ALIAS,
      },
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
    threshold: 3,
    validators: [
      {
        address: '0xb9453d675e0fa3c178a17b4ce1ad5b1a279b3af9',
        alias: AW_VALIDATOR_ALIAS,
      },
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
      {
        address: '0xaa00a849fc770d742724cbd2862f91d51db7fb62',
        alias: 'Substance Labs',
      },
      {
        address: '0x68e869315e51f6bd0ba4aac844cf216fd3dec762',
        alias: 'Luganodes',
      },
      {
        address: '0x0677b2daf18b71a2c4220fb17dc81cd3aa7d355b',
        alias: 'Enigma',
      },
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
    threshold: 3,
    validators: [
      {
        address: '0x20f283be1eb0e81e22f51705dcb79883cfdd34aa',
        alias: AW_VALIDATOR_ALIAS,
      },
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

  botanix: {
    threshold: 2,
    validators: [
      {
        address: '0xc944176bc4d4e5c7b0598884478a27a2b1904664',
        alias: AW_VALIDATOR_ALIAS,
      },
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

  carrchain: {
    threshold: 2,
    validators: [
      {
        address: '0x7ed0a7582af75dc38ad82e7125b51e3eaa6ec33b',
        alias: AW_VALIDATOR_ALIAS,
      },
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

  celestia: {
    threshold: 4,
    validators: [
      {
        address: '0x6dbc192c06907784fb0af0c0c2d8809ea50ba675',
        alias: AW_VALIDATOR_ALIAS,
      },
      DEFAULT_ZKV_VALIDATOR,
      {
        address: '0x885a8c1ef7f7eea8955c8f116fc1fbe1113c4a78',
        alias: 'P2P.ORG',
      },
      {
        address: '0xa6c998f0db2b56d7a63faf30a9b677c8b9b6faab',
        alias: 'O-OPS',
      },
      {
        address: '0x21e93a81920b73c0e98aed8e6b058dae409e4909',
        alias: 'Binary Builders',
      },
      {
        address: '0x7b8606d61bc990165d1e5977037ddcf7f2de74d6',
        alias: 'Cosmostation',
      },
    ],
  },

  celestiatestnet: {
    threshold: 1,
    validators: [
      {
        address: '0x3e0227b7f129576c53ff5d98d17c9b8433445094',
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
      DEFAULT_TESSELLATED_VALIDATOR,
      DEFAULT_ZEE_PRIME_VALIDATOR,
    ],
  },

  celosepolia: {
    threshold: 1,
    validators: [
      {
        address: '0x4a5cfcfd7f793f4ceba170c3decbe43bd8253ef6',
        alias: AW_VALIDATOR_ALIAS,
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

  citreatestnet: {
    threshold: 1,
    validators: [
      {
        address: '0x60d7380a41eb95c49be18f141efd2fde5e3dba20',
        alias: AW_VALIDATOR_ALIAS,
      },
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
        address: '0x4d4629f5bfeabe66edc7a78da26ef5273c266f97',
        alias: 'Eclipse',
      },
      DEFAULT_ZEE_PRIME_VALIDATOR,
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

  electroneum: {
    threshold: 2,
    validators: [
      {
        address: '0x32917f0a38c60ff5b1c4968cb40bc88b14ef0d83',
        alias: AW_VALIDATOR_ALIAS,
      },
      DEFAULT_MITOSIS_VALIDATOR,
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
    threshold: 2,
    validators: [
      {
        address: '0xabc8dd7594783c90a3c0fb760943f78c37ea6d75',
        alias: AW_VALIDATOR_ALIAS,
      },
      DEFAULT_MERKLY_VALIDATOR,
      DEFAULT_MITOSIS_VALIDATOR,
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

  forma: {
    threshold: 5,
    validators: [
      {
        address: '0x5B19F64F04f495D3958804Ec416c165F00f74898',
        alias: 'Cosmostation',
      },
      {
        address: '0x3f869C36110F00D10dC74cca3ac1FB133cf019ad',
        alias: 'Polkachu',
      },
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
      {
        address: '0x184Fc4899a8271783C962e4841BeE74F8526bC2c',
        alias: 'Stakecito',
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
      {
        address: '0x25b3a88f7cfd3c9f7d7e32b295673a16a6ddbd91',
        alias: 'Luganodes',
      },
      DEFAULT_ZEE_PRIME_VALIDATOR,
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

  galactica: {
    threshold: 2,
    validators: [
      {
        address: '0xfc48af3372d621f476c53d79d42a9e96ce11fd7d',
        alias: AW_VALIDATOR_ALIAS,
      },
      DEFAULT_MITOSIS_VALIDATOR,
    ],
  },

  giwasepolia: {
    threshold: 1,
    validators: [
      {
        address: '0xc170bef56759e35740ac2d3d0fece33bd9acb90b',
        alias: AW_VALIDATOR_ALIAS,
      },
    ],
  },

  gnosis: {
    threshold: 2,
    validators: [
      {
        address: '0xd4df66a859585678f2ea8357161d896be19cc1ca',
        alias: AW_VALIDATOR_ALIAS,
      },
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
    threshold: 2,
    validators: [
      {
        address: '0x55007cab8788cdba22844e7a2499cf43347f487a',
        alias: AW_VALIDATOR_ALIAS,
      },
      DEFAULT_MERKLY_VALIDATOR,
      DEFAULT_MITOSIS_VALIDATOR,
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
        address: '0x04d949c615c9976f89595ddcb9008c92f8ba7278',
        alias: 'Luganodes',
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

  incentiv: {
    threshold: 2,
    validators: [
      {
        address: '0x72669f47b6f119289f1a42641b02a9656cc8fecd',
        alias: AW_VALIDATOR_ALIAS,
      },
      DEFAULT_MITOSIS_VALIDATOR,
    ],
  },

  incentivtestnet: {
    threshold: 1,
    validators: [
      {
        address: '0x3133eeb96fd96f9f99291088613edf7401149e6f',
        alias: AW_VALIDATOR_ALIAS,
      },
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
      DEFAULT_TESSELLATED_VALIDATOR,
      DEFAULT_ZEE_PRIME_VALIDATOR,
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

  katana: {
    threshold: 2,
    validators: [
      {
        address: '0xf23003ebdc6c53765d52b1fe7a65046eabb0e73b',
        alias: AW_VALIDATOR_ALIAS,
      },
      DEFAULT_MITOSIS_VALIDATOR,
    ],
  },

  kyve: {
    threshold: 2,
    validators: [
      {
        address: '0x8576ddc0cd96325f85528e53f333357afb8bf044',
        alias: AW_VALIDATOR_ALIAS,
      },
      DEFAULT_MERKLY_VALIDATOR,
      DEFAULT_MITOSIS_VALIDATOR,
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

  lazai: {
    threshold: 2,
    validators: [
      {
        address: '0x3b00fe3518e739bb978b04d28e1492d8d865d96e',
        alias: AW_VALIDATOR_ALIAS,
      },
      DEFAULT_MITOSIS_VALIDATOR,
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

  litchain: {
    threshold: 2,
    validators: [
      {
        address: '0xde5509be55483aa525e9b5cce6fe64d3e68d068d',
        alias: AW_VALIDATOR_ALIAS,
      },
      DEFAULT_MITOSIS_VALIDATOR,
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
    threshold: 4,
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
    validators: [
      {
        address: '0x89b8064e29f125e896f6081ebb77090c46bca9cd',
        alias: AW_VALIDATOR_ALIAS,
      },
      DEFAULT_MITOSIS_VALIDATOR,
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

  megaeth: {
    threshold: 2,
    validators: [
      {
        address: '0x051ddac8ecf4bae2532b8b7caa626b5567dab528',
        alias: AW_VALIDATOR_ALIAS,
      },
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
      DEFAULT_TESSELLATED_VALIDATOR,
      DEFAULT_ZEE_PRIME_VALIDATOR,
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

  miraclechain: {
    threshold: 2,
    validators: [
      {
        address: '0x8fc655174e99194399822ce2d3a0f71d9fc2de7b',
        alias: AW_VALIDATOR_ALIAS,
      },
      DEFAULT_MITOSIS_VALIDATOR,
      {
        address: '0x7e592830cc7b26b428eea0297889e195f8438016',
        alias: 'Miracle Chain',
      },
    ],
  },

  milkyway: {
    threshold: 3,
    validators: [
      {
        address: '0x9985e0c6df8e25b655b46a317af422f5e7756875',
        alias: AW_VALIDATOR_ALIAS,
      },
      {
        address: '0x55010624d5e239281d0850dc7915b78187e8bc0e',
        alias: 'Nodes.Guru',
      },
      {
        address: '0x9ecf299947b030f9898faf328e5edbf77b13e974',
        alias: 'B-Harvest',
      },
      {
        address: '0x56fa9ac314ad49836ffb35918043d6b2dec304fb',
        alias: 'DSRV',
      },
      {
        address: '0xb69c0d1aacd305edeca88b482b9dd9657f3a8b5c',
        alias: 'CryptoCrew',
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

  mitosis: {
    threshold: 3,
    validators: [
      {
        address: '0x3b3eb808d90a4e19bb601790a6b6297812d6a61f',
        alias: AW_VALIDATOR_ALIAS,
      },
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
      {
        address: '0x485a4f0009d9afbbf44521016f9b8cdd718e36ea',
        alias: 'Luganodes',
      },
      DEFAULT_ZEE_PRIME_VALIDATOR,
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

  monad: {
    threshold: 2,
    validators: [
      {
        address: '0xb4654795b2f1b17513ffde7d85c776e4cade366c',
        alias: AW_VALIDATOR_ALIAS,
      },
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
    threshold: 2,
    validators: [
      {
        address: '0x2225e2f4e9221049456da93b71d2de41f3b6b2a8',
        alias: AW_VALIDATOR_ALIAS,
      },
      DEFAULT_MITOSIS_VALIDATOR,
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

  noble: {
    threshold: 2,
    validators: [
      {
        address: '0x28495e5c72a7dafd1658e5d99dfeffaada175c46',
        alias: AW_VALIDATOR_ALIAS,
      },
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

  ontology: {
    threshold: 3,
    validators: [
      {
        address: '0x2578b0a330c492e1a1682684e27e6a93649befd5',
        alias: AW_VALIDATOR_ALIAS,
      },
      DEFAULT_MERKLY_VALIDATOR,
      DEFAULT_MITOSIS_VALIDATOR,
      {
        address: '0x69bbf7d6d8ebf9d60da9607722e8f9c1b0ce7520',
        alias: 'Ontology',
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
      {
        address: '0xf9dfaa5c20ae1d84da4b2696b8dc80c919e48b12',
        alias: 'Luganodes',
      },
      DEFAULT_ZEE_PRIME_VALIDATOR,
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

  paradex: {
    threshold: 2,
    validators: [
      {
        address: '0x0ede747b84071ac24b60c08f8d59ad55d23f8a5c',
        alias: AW_VALIDATOR_ALIAS,
      },
      DEFAULT_MITOSIS_VALIDATOR,
      // TODO: enroll once announced onchain
      // {
      //   address: '0xc36fe08e2c06ca51f6c3523e54e33505b7aaba37',
      //   alias: 'Luganodes',
      // },
    ],
  },

  paradexsepolia: {
    threshold: 1,
    validators: [
      {
        address: '0x7d49abcceafa5cd82f6615a9779f29c76bfc88e8',
        alias: AW_VALIDATOR_ALIAS,
      },
    ],
  },

  peaq: {
    threshold: 2,
    validators: [
      {
        address: '0x7f7fe70b676f65097e2a1e2683d0fc96ea8fea49',
        alias: AW_VALIDATOR_ALIAS,
      },
      DEFAULT_MERKLY_VALIDATOR,
      DEFAULT_MITOSIS_VALIDATOR,
    ],
  },

  plasma: {
    threshold: 2,
    validators: [
      {
        address: '0x4ba900a8549fe503bca674114dc98a254637fc2c',
        alias: AW_VALIDATOR_ALIAS,
      },
      DEFAULT_MITOSIS_VALIDATOR,
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

  polygon: {
    threshold: 2,
    validators: [
      {
        address: '0x12ecb319c7f4e8ac5eb5226662aeb8528c5cefac',
        alias: AW_VALIDATOR_ALIAS,
      },
      { address: '0x008f24cbb1cc30ad0f19f2516ca75730e37efb5f', alias: 'DSRV' },
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

  pulsechain: {
    threshold: 2,
    validators: [
      {
        address: '0xa73fc7ebb2149d9c6992ae002cb1849696be895b',
        alias: AW_VALIDATOR_ALIAS,
      },
      DEFAULT_MITOSIS_VALIDATOR,
    ],
  },

  radix: {
    threshold: 2,
    validators: [
      {
        address: '0xa715a7cd97f68caeedb7be64f9e1da10f8ffafb4',
        alias: AW_VALIDATOR_ALIAS,
      },
      DEFAULT_MITOSIS_VALIDATOR,
      {
        address: '0xc61209c6b133791c729d0cbe49d6da96c30a515f',
        alias: 'Luganodes',
      },
    ],
  },

  radixtestnet: {
    threshold: 1,
    validators: [
      {
        address: '0xeddaf7958627cfd35400c95db19a656a4a8a92c6',
        alias: AW_VALIDATOR_ALIAS,
      },
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

  redstone: {
    threshold: 2,
    validators: [
      {
        address: '0x1400b9737007f7978d8b4bbafb4a69c83f0641a7',
        alias: AW_VALIDATOR_ALIAS,
      },
      DEFAULT_MERKLY_VALIDATOR,
      DEFAULT_MITOSIS_VALIDATOR,
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
      DEFAULT_ZEE_PRIME_VALIDATOR,
      {
        address: '0x808a3945d5f9c2f9ccf7a76bde4c4b54c9c7dba4',
        alias: 'Luganodes',
      },
      {
        address: '0xe8a821e77bd1ee4658c29e8c3f43c0200b0f06a1',
        alias: 'Enigma',
      },
    ],
  },

  scroll: {
    threshold: 2,
    validators: [
      {
        address: '0xad557170a9f2f21c35e03de07cb30dcbcc3dff63',
        alias: AW_VALIDATOR_ALIAS,
      },
      DEFAULT_STAKED_VALIDATOR,
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
    threshold: 2,
    validators: [
      {
        address: '0x9920d2dbf6c85ffc228fdc2e810bf895732c6aa5',
        alias: AW_VALIDATOR_ALIAS,
      },
      DEFAULT_MERKLY_VALIDATOR,
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
      {
        address: '0xcb6bcbd0de155072a7ff486d9d7286b0f71dcc2d',
        alias: 'Eclipse',
      },
      DEFAULT_MITOSIS_VALIDATOR,
      DEFAULT_ZEE_PRIME_VALIDATOR,
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

  solaxy: {
    threshold: 2,
    validators: [
      {
        address: '0x4fa10dd6d854cd05f57bacf6f46d1a72eb1396e5',
        alias: AW_VALIDATOR_ALIAS,
      },
      DEFAULT_MITOSIS_VALIDATOR,
    ],
  },

  somnia: {
    threshold: 2,
    validators: [
      {
        address: '0xf484907083d32fdc0848bfb998dfdde835e6f9cb',
        alias: AW_VALIDATOR_ALIAS,
      },
      DEFAULT_MITOSIS_VALIDATOR,
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
      DEFAULT_TESSELLATED_VALIDATOR,
      DEFAULT_ZEE_PRIME_VALIDATOR,
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

  stable: {
    threshold: 2,
    validators: [
      {
        address: '0x21820baebcd972c769e490415cfee43a894f3c18',
        alias: AW_VALIDATOR_ALIAS,
      },
      DEFAULT_MITOSIS_VALIDATOR,
    ],
  },

  starknet: {
    threshold: 2,
    validators: [
      {
        address: '0x61204c987d1121175a74e04d5045ab708aa1489f',
        alias: AW_VALIDATOR_ALIAS,
      },
      DEFAULT_ZEE_PRIME_VALIDATOR,
      DEFAULT_STAKED_VALIDATOR,
    ],
  },

  starknetsepolia: {
    threshold: 1,
    validators: [
      {
        address: '0xd07272cc3665d6e383a319691dcce5731ecf54a5',
        alias: AW_VALIDATOR_ALIAS,
      },
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
    threshold: 7,
    validators: [
      {
        address: '0x38c7a4ca1273ead2e867d096adbcdd0e2acb21d8',
        alias: 'Everstake',
      },
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
    threshold: 3,
    validators: [
      {
        address: '0xd5f8196d7060b85bea491f0b52a671e05f3d10a2',
        alias: AW_VALIDATOR_ALIAS,
      },
      DEFAULT_MERKLY_VALIDATOR,
      DEFAULT_MITOSIS_VALIDATOR,
      DEFAULT_ZEE_PRIME_VALIDATOR,
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
      DEFAULT_TESSELLATED_VALIDATOR,
      DEFAULT_ZEE_PRIME_VALIDATOR,
    ],
  },

  svmbnb: {
    threshold: 2,
    validators: [
      {
        address: '0xabcd4dac2d06ae30c011d25b0c2c193873116a14',
        alias: AW_VALIDATOR_ALIAS,
      },
      DEFAULT_MERKLY_VALIDATOR,
      DEFAULT_MITOSIS_VALIDATOR,
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
      DEFAULT_TESSELLATED_VALIDATOR,
      DEFAULT_ZEE_PRIME_VALIDATOR,
    ],
  },

  tac: {
    threshold: 2,
    validators: [
      {
        address: '0x606561d6a45188ba0a486e513e440bfc421dbc36',
        alias: AW_VALIDATOR_ALIAS,
      },
      DEFAULT_MITOSIS_VALIDATOR,
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
      DEFAULT_TESSELLATED_VALIDATOR,
      DEFAULT_ZEE_PRIME_VALIDATOR,
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

  vana: {
    threshold: 2,
    validators: [
      {
        address: '0xfdf3b0dfd4b822d10cacb15c8ae945ea269e7534',
        alias: AW_VALIDATOR_ALIAS,
      },
      DEFAULT_MERKLY_VALIDATOR,
      DEFAULT_MITOSIS_VALIDATOR,
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
      DEFAULT_MERKLY_VALIDATOR,
      DEFAULT_MITOSIS_VALIDATOR,
    ],
  },

  xrplevm: {
    threshold: 2,
    validators: [
      {
        address: '0x14d3e2f28d60d54a1659a205cb71e6e440f06510',
        alias: AW_VALIDATOR_ALIAS,
      },
      DEFAULT_MITOSIS_VALIDATOR,
    ],
  },

  zerogravity: {
    threshold: 4,
    validators: [
      {
        address: '0xc37e7dad064c11d7ecfc75813a4d8d649d797275',
        alias: AW_VALIDATOR_ALIAS,
      },
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
    threshold: 2,
    validators: [
      {
        address: '0xa3bca0b80317dbf9c7dce16a16ac89f4ff2b23ef',
        alias: AW_VALIDATOR_ALIAS,
      },
      DEFAULT_MERKLY_VALIDATOR,
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
      { address: '0x1da9176C2CE5cC7115340496fa7D1800a98911CE', alias: 'Renzo' },
      DEFAULT_MITOSIS_VALIDATOR,
    ],
  },

  zksync: {
    threshold: 2,
    validators: [
      {
        address: '0xadd1d39ce7a687e32255ac457cf99a6d8c5b5d1a',
        alias: AW_VALIDATOR_ALIAS,
      },
      DEFAULT_MERKLY_VALIDATOR,
      DEFAULT_MITOSIS_VALIDATOR,
    ],
  },

  zoramainnet: {
    threshold: 2,
    validators: [
      {
        address: '0x35130945b625bb69b28aee902a3b9a76fa67125f',
        alias: AW_VALIDATOR_ALIAS,
      },
      DEFAULT_MERKLY_VALIDATOR,
      DEFAULT_MITOSIS_VALIDATOR,
    ],
  },
};
