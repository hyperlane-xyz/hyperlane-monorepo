import { MultisigConfig } from '../ism/types.js';
import { ChainMap } from '../types.js';

// TODO: consider migrating these to the registry too
export const defaultMultisigConfigs: ChainMap<MultisigConfig> = {
  abstracttestnet: {
    threshold: 1,
    validators: ['0x7655bc4c9802bfcb3132b8822155b60a4fbbce3e'],
  },

  alephzeroevmmainnet: {
    threshold: 2,
    validators: [
      '0x33f20e6e775747d60301c6ea1c50e51f0389740c',
      '0xcf0211fafbb91fd9d06d7e306b30032dc3a1934f', // merkly
      '0x4f977a59fdc2d9e39f6d780a84d5b4add1495a36', // mitosis
    ],
  },

  alephzeroevmtestnet: {
    threshold: 1,
    validators: ['0x556cd94bcb6e5773e8df75e7eb3f91909d266a26'],
  },

  alfajores: {
    threshold: 2,
    validators: [
      '0x2233a5ce12f814bd64c9cdd73410bb8693124d40',
      '0xba279f965489d90f90490e3c49e860e0b43c2ae6',
      '0x86485dcec5f7bb8478dd251676372d054dea6653',
    ],
  },

  ancient8: {
    threshold: 2,
    validators: [
      '0xbb5842ae0e05215b53df4787a29144efb7e67551',
      '0xa5a56e97fb46f0ac3a3d261e404acb998d9a6969', // coin98
      '0x95c7bf235837cb5a609fe6c95870410b9f68bcff', // ancient8
    ],
  },

  apechain: {
    threshold: 2,
    validators: [
      '0x773d7fe6ffb1ba4de814c28044ff9a2d83a48221',
      '0xcf0211fafbb91fd9d06d7e306b30032dc3a1934f', // merkly
      '0x4f977a59fdc2d9e39f6d780a84d5b4add1495a36', // mitosis
    ],
  },

  arbitrum: {
    threshold: 3,
    validators: [
      '0x4d966438fe9e2b1e7124c87bbb90cb4f0f6c59a1',
      '0xec68258a7c882ac2fc46b81ce80380054ffb4ef2', // dsrv
      '0x5450447aee7b544c462c9352bef7cad049b0c2dc', // zeeprime
      '0x38c7a4ca1273ead2e867d096adbcdd0e2acb21d8', // everstake
      '0xb3ac35d3988bca8c2ffd195b1c6bee18536b317b', // staked
    ],
  },

  arbitrumnova: {
    threshold: 2,
    validators: [
      '0xd2a5e9123308d187383c87053811a2c21bd8af1f',
      '0xcf0211fafbb91fd9d06d7e306b30032dc3a1934f', // merkly
      '0x4f977a59fdc2d9e39f6d780a84d5b4add1495a36', // mitosis
    ],
  },

  arbitrumsepolia: {
    threshold: 1,
    validators: ['0x09fabfbca0b8bf042e2a1161ee5010d147b0f603'],
  },

  arcadiatestnet2: {
    threshold: 1,
    validators: ['0xd39cd388ce3f616bc81be6dd3ec9348d7cdf4dff'],
  },

  astar: {
    threshold: 2,
    validators: [
      '0x4d1b2cade01ee3493f44304653d8e352c66ec3e7',
      '0xcf0211fafbb91fd9d06d7e306b30032dc3a1934f', // merkly
      '0x4f977a59fdc2d9e39f6d780a84d5b4add1495a36', // mitosis
    ],
  },

  astarzkevm: {
    threshold: 2,
    validators: [
      '0x89ecdd6caf138934bf3a2fb7b323984d72fd66de',
      '0xcf0211fafbb91fd9d06d7e306b30032dc3a1934f', // merkly
      '0x4f977a59fdc2d9e39f6d780a84d5b4add1495a36', // mitosis
    ],
  },

  avalanche: {
    threshold: 2,
    validators: [
      '0x3fb8263859843bffb02950c492d492cae169f4cf',
      '0x402e0f8c6e4210d408b6ac00d197d4a099fcd25a', // dsrv
      '0x38c7a4ca1273ead2e867d096adbcdd0e2acb21d8', // everstake
    ],
  },

  b3: {
    threshold: 2,
    validators: [
      '0xd77b516730a836fc41934e7d5864e72c165b934e',
      '0xcf0211fafbb91fd9d06d7e306b30032dc3a1934f', // merkly
      '0x4f977a59fdc2d9e39f6d780a84d5b4add1495a36', // mitosis
    ],
  },

  base: {
    threshold: 3,
    validators: [
      '0xb9453d675e0fa3c178a17b4ce1ad5b1a279b3af9',
      '0xb3ac35d3988bca8c2ffd195b1c6bee18536b317b', // staked
      '0x38c7a4ca1273ead2e867d096adbcdd0e2acb21d8', // everstake
      '0xcff391b4e516452d424db66beb9052b041a9ed79', // dsrv
      '0x5450447aee7b544c462c9352bef7cad049b0c2dc', // zeeprime
    ],
  },

  basesepolia: {
    threshold: 1,
    validators: ['0x82e3b437a2944e3ff00258c93e72cd1ba5e0e921'],
  },

  berabartio: {
    threshold: 1,
    validators: ['0x541dd3cb282cf869d72883557badae245b63e1fd'],
  },

  bitlayer: {
    threshold: 2,
    validators: [
      '0x1d9b0f4ea80dbfc71cb7d64d8005eccf7c41e75f',
      '0xcf0211fafbb91fd9d06d7e306b30032dc3a1934f', // merkly
      '0x4f977a59fdc2d9e39f6d780a84d5b4add1495a36', // mitosis
    ],
  },

  blast: {
    threshold: 2,
    validators: [
      '0xf20c0b09f597597c8d2430d3d72dfddaf09177d1',
      '0x4f977a59fdc2d9e39f6d780a84d5b4add1495a36', // mitosis
      '0xae53467a5c2a9d9420c188d10fef5e1d9b9a5b80', // superform
    ],
  },

  bob: {
    threshold: 2,
    validators: [
      '0x20f283be1eb0e81e22f51705dcb79883cfdd34aa',
      '0xcf0211fafbb91fd9d06d7e306b30032dc3a1934f', // merkly
      '0x4f977a59fdc2d9e39f6d780a84d5b4add1495a36', // mitosis
    ],
  },

  bsc: {
    threshold: 3,
    validators: [
      '0x570af9b7b36568c8877eebba6c6727aa9dab7268',
      '0x8292b1a53907ece0f76af8a50724e9492bcdc8a3', // dsrv
      '0x38c7a4ca1273ead2e867d096adbcdd0e2acb21d8', // everstake
      '0x5450447aee7b544c462c9352bef7cad049b0c2dc', // zeeprime
    ],
  },

  bsctestnet: {
    threshold: 2,
    validators: [
      '0x242d8a855a8c932dec51f7999ae7d1e48b10c95e',
      '0xf620f5e3d25a3ae848fec74bccae5de3edcd8796',
      '0x1f030345963c54ff8229720dd3a711c15c554aeb',
    ],
  },

  camptestnet: {
    threshold: 1,
    validators: ['0x238f40f055a7ff697ea6dbff3ae943c9eae7a38e'],
  },

  celo: {
    threshold: 3,
    validators: [
      '0x63478422679303c3e4fc611b771fa4a707ef7f4a',
      '0x622e43baf06ad808ca8399360d9a2d9a1a12688b', // dsrv
      '0x38c7a4ca1273ead2e867d096adbcdd0e2acb21d8', // everstake
      '0xb3ac35d3988bca8c2ffd195b1c6bee18536b317b', // staked
      '0x5450447aee7b544c462c9352bef7cad049b0c2dc', // zeeprime
    ],
  },

  cheesechain: {
    threshold: 2,
    validators: [
      '0x478fb53c6860ae8fc35235ba0d38d49b13128226',
      '0xcf0211fafbb91fd9d06d7e306b30032dc3a1934f', // merkly
      '0x101cE77261245140A0871f9407d6233C8230Ec47', // blockhunters
    ],
  },

  chiado: {
    threshold: 2,
    validators: [
      '0x06c3757a4b7a912828e523bb8a5f980ddc297356',
      '0x0874967a145d70b799ebe9ed861ab7c93faef95a',
      '0xd767ea1206b8295d7e1267ddd00e56d34f278db6',
    ],
  },

  chilizmainnet: {
    threshold: 2,
    validators: [
      '0x7403e5d58b48b0f5f715d9c78fbc581f01a625cb',
      '0xcf0211fafbb91fd9d06d7e306b30032dc3a1934f', // merkly
      '0x4f977a59fdc2d9e39f6d780a84d5b4add1495a36', // mitosis
    ],
  },

  citreatestnet: {
    threshold: 1,
    validators: ['0x60d7380a41eb95c49be18f141efd2fde5e3dba20'],
  },

  connextsepolia: {
    threshold: 1,
    validators: ['0xffbbec8c499585d80ef69eb613db624d27e089ab'],
  },

  coredao: {
    threshold: 2,
    validators: [
      '0xbd6e158a3f5830d99d7d2bce192695bc4a148de2',
      '0xcf0211fafbb91fd9d06d7e306b30032dc3a1934f', // merkly
      '0x4f977a59fdc2d9e39f6d780a84d5b4add1495a36', // mitosis
    ],
  },

  cyber: {
    threshold: 2,
    validators: [
      '0x94d7119ceeb802173b6924e6cc8c4cd731089a27',
      '0xcf0211fafbb91fd9d06d7e306b30032dc3a1934f', // merkly
      '0x4f977a59fdc2d9e39f6d780a84d5b4add1495a36', // mitosis
    ],
  },

  degenchain: {
    threshold: 2,
    validators: [
      '0x433e311f19524cd64fb2123ad0aa1579a4e1fc83',
      '0xcf0211fafbb91fd9d06d7e306b30032dc3a1934f', // merkly
      '0x4f977a59fdc2d9e39f6d780a84d5b4add1495a36', // mitosis
    ],
  },

  dogechain: {
    threshold: 2,
    validators: [
      '0xe43f742c37858746e6d7e458bc591180d0cba440',
      '0xcf0211fafbb91fd9d06d7e306b30032dc3a1934f', // merkly
      '0x4f977a59fdc2d9e39f6d780a84d5b4add1495a36', // mitosis
    ],
  },

  eclipsemainnet: {
    threshold: 3,
    validators: [
      '0xebb52d7eaa3ff7a5a6260bfe5111ce52d57401d0',
      '0x3571223e745dc0fcbdefa164c9b826b90c0d2dac', // luganodes
      '0xea83086a62617a7228ce4206fae2ea8b0ab23513', // imperator
      '0x4d4629f5bfeabe66edc7a78da26ef5273c266f97', // eclipse
    ],
  },

  eclipsetestnet: {
    threshold: 1,
    validators: ['0xf344f34abca9a444545b5295066348a0ae22dda3'],
  },

  ecotestnet: {
    threshold: 1,
    validators: ['0xb3191420d463c2af8bd9b4a395e100ec5c05915a'],
  },

  endurance: {
    threshold: 2,
    validators: [
      '0x28c5b322da06f184ebf68693c5d19df4d4af13e5',
      '0xcf0211fafbb91fd9d06d7e306b30032dc3a1934f', // merkly
      '0x7419021c0de2772b763e554480158a82a291c1f2', // fusionist
    ],
  },

  ethereum: {
    threshold: 4,
    validators: [
      '0x03c842db86a6a3e524d4a6615390c1ea8e2b9541',
      '0x94438a7de38d4548ae54df5c6010c4ebc5239eae', // dsrv
      '0x5450447aee7b544c462c9352bef7cad049b0c2dc', // zeeprime
      '0x38c7a4ca1273ead2e867d096adbcdd0e2acb21d8', // everstake
      '0xb3ac35d3988bca8c2ffd195b1c6bee18536b317b', // staked
      '0xb683b742b378632a5f73a2a5a45801b3489bba44', // avs: luganodes
      '0xbf1023eff3dba21263bf2db2add67a0d6bcda2de', // avs: pier two
    ],
  },

  everclear: {
    threshold: 2,
    validators: [
      '0xeff20ae3d5ab90abb11e882cfce4b92ea6c74837',
      '0xcf0211fafbb91fd9d06d7e306b30032dc3a1934f', // merkly
      '0xD79DFbF56ee2268f061cc613027a44A880f61Ba2', // everclear
    ],
  },

  fantom: {
    threshold: 2,
    validators: [
      '0xa779572028e634e16f26af5dfd4fa685f619457d',
      '0xcf0211fafbb91fd9d06d7e306b30032dc3a1934f', // merkly
      '0x4f977a59fdc2d9e39f6d780a84d5b4add1495a36', // mitosis
    ],
  },

  flame: {
    threshold: 2,
    validators: [
      '0x1fa928ce884fa16357d4b8866e096392d4d81f43',
      '0xa6c998f0db2b56d7a63faf30a9b677c8b9b6faab', // p-ops
      '0x0d4c1394a255568ec0ecd11795b28d1bda183ca4', // tessellated
    ],
  },

  flare: {
    threshold: 2,
    validators: [
      '0xb65e52be342dba3ab2c088ceeb4290c744809134',
      '0xcf0211fafbb91fd9d06d7e306b30032dc3a1934f', // merkly
      '0x4f977a59fdc2d9e39f6d780a84d5b4add1495a36', // mitosis
    ],
  },

  flowmainnet: {
    threshold: 2,
    validators: [
      '0xe132235c958ca1f3f24d772e5970dd58da4c0f6e',
      '0xcf0211fafbb91fd9d06d7e306b30032dc3a1934f', // merkly
      '0x4f977a59fdc2d9e39f6d780a84d5b4add1495a36', // mitosis
    ],
  },

  formtestnet: {
    threshold: 1,
    validators: ['0x72ad7fddf16d17ff902d788441151982fa31a7bc'],
  },

  fraxtal: {
    threshold: 2,
    validators: [
      '0x4bce180dac6da60d0f3a2bdf036ffe9004f944c1',
      '0xcf0211fafbb91fd9d06d7e306b30032dc3a1934f', // merkly
      '0x25b3a88f7cfd3c9f7d7e32b295673a16a6ddbd91', // luganodes
    ],
  },

  fuji: {
    threshold: 2,
    validators: [
      '0xd8154f73d04cc7f7f0c332793692e6e6f6b2402e',
      '0x895ae30bc83ff1493b9cf7781b0b813d23659857',
      '0x43e915573d9f1383cbf482049e4a012290759e7f',
    ],
  },

  fusemainnet: {
    threshold: 2,
    validators: [
      '0x770c8ec9aac8cec4b2ead583b49acfbc5a1cf8a9',
      '0x6760226b34213d262D41D5291Ed57E81a68b4E0b', // fuse
      '0xcf0211fafbb91fd9d06d7e306b30032dc3a1934f', // merkly
    ],
  },

  gnosis: {
    threshold: 3,
    validators: [
      '0xd4df66a859585678f2ea8357161d896be19cc1ca',
      '0x19fb7e04a1be6b39b6966a0b0c60b929a93ed672', // dsrv
      '0x38c7a4ca1273ead2e867d096adbcdd0e2acb21d8', // everstake
      '0x5450447aee7b544c462c9352bef7cad049b0c2dc', // zeeprime
    ],
  },

  gravity: {
    threshold: 2,
    validators: [
      '0x23d549bf757a02a6f6068e9363196ecd958c974e',
      '0xcf0211fafbb91fd9d06d7e306b30032dc3a1934f', // merkly
      '0x4f977a59fdc2d9e39f6d780a84d5b4add1495a36', // mitosis
    ],
  },

  harmony: {
    threshold: 2,
    validators: [
      '0xd677803a67651974b1c264171b5d7ca8838db8d5',
      '0xcf0211fafbb91fd9d06d7e306b30032dc3a1934f', // merkly
      '0x4f977a59fdc2d9e39f6d780a84d5b4add1495a36', // mitosis
    ],
  },

  holesky: {
    threshold: 1,
    validators: ['0x7ab28ad88bb45867137ea823af88e2cb02359c03'], // TODO
  },

  hyperliquidevmtestnet: {
    threshold: 1,
    validators: ['0xea673a92a23ca319b9d85cc16b248645cd5158da'],
  },

  immutablezkevmmainnet: {
    threshold: 2,
    validators: [
      '0xbdda85b19a5efbe09e52a32db1a072f043dd66da',
      '0xcf0211fafbb91fd9d06d7e306b30032dc3a1934f', // merkly
      '0x4f977a59fdc2d9e39f6d780a84d5b4add1495a36', // mitosis
    ],
  },

  inevm: {
    threshold: 2,
    validators: [
      '0xf9e35ee88e4448a3673b4676a4e153e3584a08eb',
      '0x0d4e7e64f3a032db30b75fe7acae4d2c877883bc', // decentrio
      '0x9ab11f38a609940153850df611c9a2175dcffe0f', // imperator
    ],
  },

  injective: {
    threshold: 2,
    validators: [
      '0xbfb8911b72cfb138c7ce517c57d9c691535dc517',
      '0x6B1d09A97b813D53e9D4b7523DA36604C0B52242', // caldera
      '0x9e551b6694bbd295d7d6e6a2540c7d41ce70a3b9', // imperator
    ],
  },

  inksepolia: {
    threshold: 1,
    validators: ['0xe61c846aee275070207fcbf43674eb254f06097a'],
  },

  kaia: {
    threshold: 2,
    validators: [
      '0x9de0b3abb221d19719882fa4d61f769fdc2be9a4',
      '0xcf0211fafbb91fd9d06d7e306b30032dc3a1934f', // merkly
      '0x4f977a59fdc2d9e39f6d780a84d5b4add1495a36', // mitosis
    ],
  },

  kroma: {
    threshold: 2,
    validators: [
      '0x71b83c21342787d758199e4b8634d3a15f02dc6e',
      '0xcf0211fafbb91fd9d06d7e306b30032dc3a1934f', // merkly
      '0x4f977a59fdc2d9e39f6d780a84d5b4add1495a36', // mitosis
    ],
  },

  linea: {
    threshold: 2,
    validators: [
      '0xf2d5409a59e0f5ae7635aff73685624904a77d94',
      '0xcf0211fafbb91fd9d06d7e306b30032dc3a1934f', // merkly
      '0x4f977a59fdc2d9e39f6d780a84d5b4add1495a36', // mitosis
    ],
  },

  lisk: {
    threshold: 4,
    validators: [
      '0xc0b282aa5bac43fee83cf71dc3dd1797c1090ea5',
      '0x0d4c1394a255568ec0ecd11795b28d1bda183ca4', // tessellated (superlane)
      '0x3DA4ee2801Ec6CC5faD73DBb94B10A203ADb3d9e', // enigma (superlane)
      '0x4df6e8878992c300e7bfe98cac6bf7d3408b9cbf', // imperator (superlane)
      '0x14d0B24d3a8F3aAD17DB4b62cBcEC12821c98Cb3', // bware (superlane)
      '0xf0da628f3fb71652d48260bad4691054045832ce', // luganodes (superlane)
    ],
  },

  lukso: {
    threshold: 2,
    validators: [
      '0xa5e953701dcddc5b958b5defb677a829d908df6d',
      '0xcf0211fafbb91fd9d06d7e306b30032dc3a1934f', // merkly
      '0x101cE77261245140A0871f9407d6233C8230Ec47', // blockhunters
    ],
  },

  lumia: {
    threshold: 2,
    validators: [
      '0x9e283254ed2cd2c80f007348c2822fc8e5c2fa5f',
      '0xCF0211faFBb91FD9D06D7E306B30032DC3A1934f', // merkly
      '0x4f977a59fdc2d9e39f6d780a84d5b4add1495a36', // mitosis
    ],
  },

  mantapacific: {
    threshold: 5,
    validators: [
      '0x8e668c97ad76d0e28375275c41ece4972ab8a5bc', //abacusworks
      '0x521a3e6bf8d24809fde1c1fd3494a859a16f132c', //cosmostation
      '0x14025fe092f5f8a401dd9819704d9072196d2125', //p2p
      '0x25b9a0961c51e74fd83295293bc029131bf1e05a', //neutron
      '0xa0eE95e280D46C14921e524B075d0C341e7ad1C8', //cosmos spaces
      '0xcc9a0b6de7fe314bd99223687d784730a75bb957', //dsrv
      '0x42b6de2edbaa62c2ea2309ad85d20b3e37d38acf', //sg-1
    ],
  },

  mantle: {
    threshold: 2,
    validators: [
      '0xf930636c5a1a8bf9302405f72e3af3c96ebe4a52',
      '0xcf0211fafbb91fd9d06d7e306b30032dc3a1934f', // merkly
      '0x4f977a59fdc2d9e39f6d780a84d5b4add1495a36', // mitosis
    ],
  },

  merlin: {
    threshold: 2,
    validators: [
      '0xc1d6600cb9326ed2198cc8c4ba8d6668e8671247',
      '0xcf0211fafbb91fd9d06d7e306b30032dc3a1934f', // merkly
      '0x4f977a59fdc2d9e39f6d780a84d5b4add1495a36', // mitosis
    ],
  },

  metal: {
    threshold: 2,
    validators: [
      '0xd9f7f1a05826197a93df51e86cefb41dfbfb896a',
      '0xcf0211fafbb91fd9d06d7e306b30032dc3a1934f', // merkly
      '0x4f977a59fdc2d9e39f6d780a84d5b4add1495a36', // mitosis
    ],
  },

  metis: {
    threshold: 2,
    validators: [
      '0xc4a3d25107060e800a43842964546db508092260',
      '0xcf0211fafbb91fd9d06d7e306b30032dc3a1934f', // merkly
      '0x4f977a59fdc2d9e39f6d780a84d5b4add1495a36', // mitosis
    ],
  },

  mint: {
    threshold: 2,
    validators: [
      '0xfed01ccdd7a65e8a6ad867b7fb03b9eb47777ac9',
      '0xcf0211fafbb91fd9d06d7e306b30032dc3a1934f', // merkly
      '0x0230505530b80186f8cdccfaf9993eb97aebe98a', // mint
    ],
  },

  mode: {
    threshold: 4,
    validators: [
      '0x7eb2e1920a4166c19d6884c1cec3d2cf356fc9b7',
      '0x0d4c1394a255568ec0ecd11795b28d1bda183ca4', // tessellated (superlane)
      '0x65C140e3a05F33192384AffEF985696Fe3cDDE42', // enigma (superlane)
      '0x20eade18ea2af6dfd54d72b3b5366b40fcb47f4b', // imperator (superlane)
      '0x14d0B24d3a8F3aAD17DB4b62cBcEC12821c98Cb3', // bware (superlane)
      '0x485a4f0009d9afbbf44521016f9b8cdd718e36ea', // luganodes (superlane)
    ],
  },

  molten: {
    threshold: 2,
    validators: [
      '0xad5aa33f0d67f6fa258abbe75458ea4908f1dc9f',
      '0xcf0211fafbb91fd9d06d7e306b30032dc3a1934f', // merkly
      '0x4f977a59fdc2d9e39f6d780a84d5b4add1495a36', // mitosis
    ],
  },

  moonbeam: {
    threshold: 3,
    validators: [
      '0x2225e2f4e9221049456da93b71d2de41f3b6b2a8',
      '0x645428d198d2e76cbd9c1647f5c80740bb750b97', // dsrv
      '0x38c7a4ca1273ead2e867d096adbcdd0e2acb21d8', // everstake
      '0xb3ac35d3988bca8c2ffd195b1c6bee18536b317b', // staked
    ],
  },

  morph: {
    threshold: 2,
    validators: [
      '0x4884535f393151ec419add872100d352f71af380',
      '0xcf0211fafbb91fd9d06d7e306b30032dc3a1934f', // merkly
      '0x4f977a59fdc2d9e39f6d780a84d5b4add1495a36', // mitosis
    ],
  },

  neutron: {
    threshold: 4,
    validators: [
      '0xa9b8c1f4998f781f958c63cfcd1708d02f004ff0',
      '0xb65438a014fb05fbadcfe35bc6e25d372b6ba460', // cosmostation
      '0x42fa752defe92459370a052b6387a87f7de9b80c', // p2p
      '0xc79503a3e3011535a9c60f6d21f76f59823a38bd', // neutron
      '0x47aa126e05933b95c5eb90b26e6b668d84f4b25a', // dsrv
      '0x54b2cca5091b098a1a993dec03c4d1ee9af65999', // cosmos spaces
      '0x42b6de2edbaa62c2ea2309ad85d20b3e37d38acf', // sg-1
    ],
  },

  odysseytestnet: {
    threshold: 1,
    validators: ['0xcc0a6e2d6aa8560b45b384ced7aa049870b66ea3'],
  },

  oortmainnet: {
    threshold: 2,
    validators: [
      '0x9b7ff56cd9aa69006f73f1c5b8c63390c706a5d7',
      '0x4f977a59fdc2d9e39f6d780a84d5b4add1495a36', // mitosis
      '0x032dE4f94676bF9314331e7D83E8Db4aC74c9E21', // oort
    ],
  },

  optimism: {
    threshold: 4,
    validators: [
      '0x20349eadc6c72e94ce38268b96692b1a5c20de4f',
      '0x0d4c1394a255568ec0ecd11795b28d1bda183ca4', // tessellated (superlane)
      '0xd8c1cCbfF28413CE6c6ebe11A3e29B0D8384eDbB', // enigma (superlane)
      '0x1b9e5f36c4bfdb0e3f0df525ef5c888a4459ef99', // imperator (superlane)
      '0x14d0B24d3a8F3aAD17DB4b62cBcEC12821c98Cb3', // bware (superlane)
      '0xf9dfaa5c20ae1d84da4b2696b8dc80c919e48b12', // luganodes (superlane)
    ],
  },

  optimismsepolia: {
    threshold: 1,
    validators: ['0x03efe4d0632ee15685d7e8f46dea0a874304aa29'],
  },

  orderly: {
    threshold: 2,
    validators: [
      '0xec3dc91f9fa2ad35edf5842aa764d5573b778bb6',
      '0xcf0211fafbb91fd9d06d7e306b30032dc3a1934f', // merkly
      '0x4f977a59fdc2d9e39f6d780a84d5b4add1495a36', // mitosis
    ],
  },

  osmosis: {
    threshold: 1,
    validators: ['0xea483af11c19fa41b16c31d1534c2a486a92bcac'],
  },

  plumetestnet: {
    threshold: 1,
    validators: ['0xe765a214849f3ecdf00793b97d00422f2d408ea6'],
  },

  polygon: {
    threshold: 3,
    validators: [
      '0x12ecb319c7f4e8ac5eb5226662aeb8528c5cefac',
      '0x008f24cbb1cc30ad0f19f2516ca75730e37efb5f', // dsrv
      '0x38c7a4ca1273ead2e867d096adbcdd0e2acb21d8', // everstake
      '0x5450447aee7b544c462c9352bef7cad049b0c2dc', // zeeprime
    ],
  },

  polygonamoy: {
    threshold: 1,
    validators: ['0xf0290b06e446b320bd4e9c4a519420354d7ddccd'],
  },

  polygonzkevm: {
    threshold: 2,
    validators: [
      '0x86f2a44592bb98da766e880cfd70d3bbb295e61a',
      '0x865818fe1db986036d5fd0466dcd462562436d1a', // dsrv
      '0x38c7a4ca1273ead2e867d096adbcdd0e2acb21d8', // everstake
    ],
  },

  polynomialfi: {
    threshold: 2,
    validators: [
      '0x23d348c2d365040e56f3fee07e6897122915f513',
      '0xcf0211fafbb91fd9d06d7e306b30032dc3a1934f', // merkly
      '0x4f977a59fdc2d9e39f6d780a84d5b4add1495a36', // mitosis
    ],
  },

  prom: {
    threshold: 2,
    validators: [
      '0xb0c4042b7c9a95345be8913f4cdbf4043b923d98',
      '0xcf0211fafbb91fd9d06d7e306b30032dc3a1934f', // merkly
      '0x4f977a59fdc2d9e39f6d780a84d5b4add1495a36', // mitosis
    ],
  },

  proofofplay: {
    threshold: 2,
    validators: [
      '0xcda40baa71970a06e5f55e306474de5ca4e21c3b',
      '0xcf0211fafbb91fd9d06d7e306b30032dc3a1934f', // merkly
      '0x4f977a59fdc2d9e39f6d780a84d5b4add1495a36', // mitosis
    ],
  },

  rarichain: {
    threshold: 2,
    validators: [
      '0xeac012df7530720dd7d6f9b727e4fe39807d1516',
      '0xcf0211fafbb91fd9d06d7e306b30032dc3a1934f', // merkly
      '0x4f977a59fdc2d9e39f6d780a84d5b4add1495a36', // mitosis
    ],
  },

  real: {
    threshold: 2,
    validators: [
      '0xaebadd4998c70b05ce8715cf0c3cb8862fe0beec',
      '0xcf0211fafbb91fd9d06d7e306b30032dc3a1934f', // merkly
      '0x4f977a59fdc2d9e39f6d780a84d5b4add1495a36', // mitosis
    ],
  },

  redstone: {
    threshold: 3,
    validators: [
      '0x1400b9737007f7978d8b4bbafb4a69c83f0641a7',
      '0xcf0211fafbb91fd9d06d7e306b30032dc3a1934f', // merkly
      '0x4f977a59fdc2d9e39f6d780a84d5b4add1495a36', // mitosis
      '0x101cE77261245140A0871f9407d6233C8230Ec47', // blockhunters
    ],
  },

  rootstockmainnet: {
    threshold: 2,
    validators: [
      '0x8675eb603d62ab64e3efe90df914e555966e04ac',
      '0xcf0211fafbb91fd9d06d7e306b30032dc3a1934f', // merkly
      '0x4f977a59fdc2d9e39f6d780a84d5b4add1495a36', // mitosis
    ],
  },

  sanko: {
    threshold: 2,
    validators: [
      '0x795c37d5babbc44094b084b0c89ed9db9b5fae39',
      '0xcf0211fafbb91fd9d06d7e306b30032dc3a1934f', // merkly
      '0x4f977a59fdc2d9e39f6d780a84d5b4add1495a36', // mitosis
    ],
  },

  scroll: {
    threshold: 3,
    validators: [
      '0xad557170a9f2f21c35e03de07cb30dcbcc3dff63',
      '0xb3ac35d3988bca8c2ffd195b1c6bee18536b317b', // staked
      '0x38c7a4ca1273ead2e867d096adbcdd0e2acb21d8', // everstake
      '0xbac4ac39f1d8b5ef15f26fdb1294a7c9aba3f948', // dsrv
    ],
  },

  scrollsepolia: {
    threshold: 2,
    validators: [
      '0xbe18dbd758afb367180260b524e6d4bcd1cb6d05',
      '0x9a11ed23ae962974018ab45bc133caabff7b3271',
      '0x7867bea3c9761fe64e6d124b171f91fd5dd79644',
    ],
  },

  sei: {
    threshold: 3,
    validators: [
      '0x9920d2dbf6c85ffc228fdc2e810bf895732c6aa5',
      '0xcf0211fafbb91fd9d06d7e306b30032dc3a1934f', // merkly
      '0x101cE77261245140A0871f9407d6233C8230Ec47', // blockhunters
      '0x4f977a59fdc2d9e39f6d780a84d5b4add1495a36', // mitosis
    ],
  },

  sepolia: {
    threshold: 2,
    validators: [
      '0xb22b65f202558adf86a8bb2847b76ae1036686a5',
      '0x469f0940684d147defc44f3647146cb90dd0bc8e',
      '0xd3c75dcf15056012a4d74c483a0c6ea11d8c2b83',
    ],
  },

  shibarium: {
    threshold: 2,
    validators: [
      '0xfa33391ee38597cbeef72ccde8c9e13e01e78521',
      '0xcf0211fafbb91fd9d06d7e306b30032dc3a1934f', // merkly
      '0x4f977a59fdc2d9e39f6d780a84d5b4add1495a36', // mitosis
    ],
  },

  snaxchain: {
    threshold: 2,
    validators: [
      '0x2c25829ae32a772d2a49f6c4b34f8b01fd03ef9e',
      '0xcf0211fafbb91fd9d06d7e306b30032dc3a1934f', // merkly
      '0x4f977a59fdc2d9e39f6d780a84d5b4add1495a36', // mitosis
    ],
  },

  solanadevnet: {
    threshold: 2,
    validators: [
      '0xec0f73dbc5b1962a20f7dcbe07c98414025b0c43',
      '0x9c20a149dfa09ea9f77f5a7ca09ed44f9c025133',
      '0x967c5ecdf2625ae86580bd203b630abaaf85cd62',
    ],
  },

  solanamainnet: {
    threshold: 3,
    validators: [
      '0x28464752829b3ea59a497fca0bdff575c534c3ff',
      '0x2b7514a2f77bd86bbf093fe6bb67d8611f51c659', // luganodes
      '0xd90ea26ff731d967c5ea660851f7d63cb04ab820', // dsrv
      '0x38c7a4ca1273ead2e867d096adbcdd0e2acb21d8', // everstake
      '0xcb6bcbd0de155072a7ff486d9d7286b0f71dcc2d', // eclipse
    ],
  },

  solanatestnet: {
    threshold: 1,
    validators: ['0xd4ce8fa138d4e083fc0e480cca0dbfa4f5f30bd5'],
  },

  soneiumtestnet: {
    threshold: 1,
    validators: ['0x2e2101020ccdbe76aeda1c27823b0150f43d0c63'],
  },

  sonictestnet: {
    threshold: 1,
    validators: ['0x62e6591d00daec3fb658c3d19403828b4e9ddbb3'],
  },

  stride: {
    threshold: 6,
    validators: [
      '0x38c7a4ca1273ead2e867d096adbcdd0e2acb21d8', // everstake
      '0x88f0E5528131b10e3463C4c68108217Dd33462ac', // cosmostation
      '0xa3eaa1216827ad63dd9db43f6168258a89177990', // DSRV
      '0x3f869C36110F00D10dC74cca3ac1FB133cf019ad', // polkachu
      '0x502dC6135d16E74056f609FBAF76846814C197D3', // strangelove
      '0xc36979780c1aD43275182600a61Ce41f1C390FbE', // imperator
      '0x87460dcEd16a75AECdBffD4189111d30B099f5b0', // enigma
      '0xf54982134e52Eb7253236943FBffE0886C5bde0C', // L5
      '0x5937b7cE1029C3Ec4bD8e1AaCc0C0f9422654D7d', // stakecito
      '0xb3ac35d3988bca8c2ffd195b1c6bee18536b317b', // staked
    ],
  },

  suavetoliman: {
    threshold: 1,
    validators: ['0xf58f6e30aabba34e8dd7f79b3168507192e2cc9b'],
  },

  superpositionmainnet: {
    threshold: 2,
    validators: [
      '0x3f489acdd341c6b4dd86293fa2cc5ecc8ccf4f84',
      '0xcf0211fafbb91fd9d06d7e306b30032dc3a1934f', // merkly
      '0x4f977a59fdc2d9e39f6d780a84d5b4add1495a36', // mitosis
    ],
  },

  superpositiontestnet: {
    threshold: 1,
    validators: ['0x1d3168504b23b73cdf9c27f13bb0a595d7f1a96a'],
  },

  taiko: {
    threshold: 3,
    validators: [
      '0xa930073c8f2d0b2f7423ea32293e0d1362e65d79',
      '0xcf0211fafbb91fd9d06d7e306b30032dc3a1934f', // merkly
      '0x4f977a59fdc2d9e39f6d780a84d5b4add1495a36', // mitosis
      '0x2F007c82672F2Bb97227D4e3F80Ac481bfB40A2a', // luganodes
    ],
  },

  tangle: {
    threshold: 2,
    validators: [
      '0x1ee52cbbfacd7dcb0ba4e91efaa6fbc61602b15b',
      '0xcf0211fafbb91fd9d06d7e306b30032dc3a1934f', // merkly
      '0xe271ef9a6e312540f099a378865432fa73f26689', // tangle
    ],
  },

  treasuretopaz: {
    threshold: 1,
    validators: ['0x9750849beda0a7870462d4685f953fe39033a5ae'],
  },

  unichaintestnet: {
    threshold: 1,
    validators: ['0x5e99961cf71918308c3b17ef21b5f515a4f86fe5'],
  },

  viction: {
    threshold: 2,
    validators: [
      '0x4E53dA92cD5Bf0a032b6B4614b986926456756A7', // blockpi
      '0xa3f93fe365bf99f431d8fde740b140615e24f99b', // rockx
      '0x1f87c368f8e05a85ef9126d984a980a20930cb9c',
    ],
  },

  worldchain: {
    threshold: 2,
    validators: [
      '0x31048785845325b22817448b68d08f8a8fe36854',
      '0x11e2a683e83617f186614071e422b857256a9aae', // imperator
      '0xcf0211fafbb91fd9d06d7e306b30032dc3a1934f', // merkly
    ],
  },

  xai: {
    threshold: 2,
    validators: [
      '0xe993f01fea86eb64cda45ae5af1d5be40ac0c7e9',
      '0xcf0211fafbb91fd9d06d7e306b30032dc3a1934f', // merkly
      '0x4f977a59fdc2d9e39f6d780a84d5b4add1495a36', // mitosis
    ],
  },

  xlayer: {
    threshold: 2,
    validators: [
      '0xa2ae7c594703e988f23d97220717c513db638ea3',
      '0xfed056cC0967F5BC9C6350F6C42eE97d3983394d', // imperator
      '0xcf0211fafbb91fd9d06d7e306b30032dc3a1934f', // merkly
    ],
  },

  zeronetwork: {
    threshold: 2,
    validators: [
      '0x1bd9e3f8a90ea1a13b0f2838a1858046368aad87',
      '0xcf0211fafbb91fd9d06d7e306b30032dc3a1934f', // merkly
      '0x4f977a59fdc2d9e39f6d780a84d5b4add1495a36', // mitosis
    ],
  },

  zetachain: {
    threshold: 3,
    validators: [
      '0xa3bca0b80317dbf9c7dce16a16ac89f4ff2b23ef',
      '0xcf0211fafbb91fd9d06d7e306b30032dc3a1934f', // merkly
      '0x101cE77261245140A0871f9407d6233C8230Ec47', // blockhunters
      '0x4f977a59fdc2d9e39f6d780a84d5b4add1495a36', // mitosis
    ],
  },

  zircuit: {
    threshold: 3,
    validators: [
      '0x169ec400cc758fef3df6a0d6c51fbc6cdd1015bb',
      '0x7aC6584c068eb2A72d4Db82A7B7cd5AB34044061', // luganodes
      '0x0180444c9342BD672867Df1432eb3dA354413a6E', // hashkey cloud
      '0x1da9176C2CE5cC7115340496fa7D1800a98911CE', // renzo
    ],
  },

  zksync: {
    threshold: 3,
    validators: [
      '0xadd1d39ce7a687e32255ac457cf99a6d8c5b5d1a',
      '0xcf0211fafbb91fd9d06d7e306b30032dc3a1934f', // merkly
      '0x4f977a59fdc2d9e39f6d780a84d5b4add1495a36', // mitosis
      '0x75237d42ce8ea27349a0254ada265db94157e0c1', // imperator
    ],
  },

  zoramainnet: {
    threshold: 3,
    validators: [
      '0x35130945b625bb69b28aee902a3b9a76fa67125f',
      '0x7089b6352d37d23fb05a7fee4229c78e038fba09', // imperator
      '0xcf0211fafbb91fd9d06d7e306b30032dc3a1934f', // merkly
      '0x4f977a59fdc2d9e39f6d780a84d5b4add1495a36', // mitosis
    ],
  },
};
