import { ModuleType, MultisigIsmConfig } from '../ism/types';
import { ChainMap } from '../types';

export const defaultMultisigIsmConfigs: ChainMap<MultisigIsmConfig> = {
  // ----------------- Mainnets -----------------
  celo: {
    type: ModuleType.MERKLE_ROOT_MULTISIG,
    threshold: 4,
    validators: [
      '0x1f20274b1210046769d48174c2f0e7c25ca7d5c5', // abacus
      '0x3bc014bafa43f93d534aed34f750997cdffcf007', // dsrv
      '0xd79d506d741fa735938f7b7847a926e34a6fe6b0', // everstake
      '0xe4a258bc61e65914c2a477b2a8a433ab4ebdf44b', // zee prime
      '0x6aea63b0be4679c1385c26a92a3ff8aa6a8379f2', // staked
      '0xc0085e1a49bcc69e534272adb82c74c0e007e1ca', // zkv
    ],
  },
  ethereum: {
    type: ModuleType.MERKLE_ROOT_MULTISIG,
    threshold: 4,
    validators: [
      '0x4c327ccb881a7542be77500b2833dc84c839e7b7', // abacus
      '0x84cb373148ef9112b277e68acf676fefa9a9a9a0', // dsrv
      '0x0d860c2b28bec3af4fd3a5997283e460ff6f2789', // everstake
      '0xd4c1211f0eefb97a846c4e6d6589832e52fc03db', // zee prime
      '0x600c90404d5c9df885404d2cc5350c9b314ea3a2', // staked
      '0x892DC66F5B2f8C438E03f6323394e34A9C24F2D6', // zkv
    ],
  },
  avalanche: {
    type: ModuleType.MERKLE_ROOT_MULTISIG,
    threshold: 4,
    validators: [
      '0xa7aa52623fe3d78c343008c95894be669e218b8d', // abacus
      '0xb6004433fb04f643e2d48ae765c0e7f890f0bc0c', // dsrv
      '0xa07e213e0985b21a6128e6c22ab5fb73948b0cc2', // everstake
      '0x73853ed9a5f6f2e4c521970a94d43469e3cdaea6', // zee prime
      '0xbd2e136cda02ba627ca882e49b184cbe976081c8', // staked
      '0x1418126f944a44dad9edbab32294a8c890e7a9e3', // zkv
    ],
  },
  polygon: {
    type: ModuleType.MERKLE_ROOT_MULTISIG,
    threshold: 4,
    validators: [
      '0x59a001c3451e7f9f3b4759ea215382c1e9aa5fc1', // abacus
      '0x009fb042d28944017177920c1d40da02bfebf474', // dsrv
      '0xba4b13e23705a5919c1901150d9697e8ffb3ea71', // everstake
      '0x2faa4071b718972f9b4beec1d8cbaa4eb6cca6c6', // zee prime
      '0x5ae9b0f833dfe09ef455562a1f603f1634504dd6', // staked
      '0x6a163d312f7352a95c9b81dca15078d5bf77a442', // zkv
    ],
  },
  bsc: {
    type: ModuleType.MERKLE_ROOT_MULTISIG,
    threshold: 4,
    validators: [
      '0xcc84b1eb711e5076b2755cf4ad1d2b42c458a45e', // abacus
      '0xefe34eae2bca1846b895d2d0762ec21796aa196a', // dsrv
      '0x662674e80e189b0861d6835c287693f50ee0c2ff', // everstake
      '0x8a0f59075af466841808c529624807656309c9da', // zee prime
      '0xdd2ff046ccd748a456b4757a73d47f165469669f', // staked
      '0x034c4924c30ec4aa1b7f3ad58548988f0971e1bf', // zkv
    ],
  },
  arbitrum: {
    type: ModuleType.MERKLE_ROOT_MULTISIG,
    threshold: 4,
    validators: [
      '0xbcb815f38d481a5eba4d7ac4c9e74d9d0fc2a7e7', // abacus
      '0xd839424e2e5ace0a81152298dc2b1e3bb3c7fb20', // dsrv
      '0xb8085c954b75b7088bcce69e61d12fcef797cd8d', // everstake
      '0x9856dcb10fd6e5407fa74b5ab1d3b96cc193e9b7', // zee prime
      '0x505dff4e0827aa5065f5e001db888e0569d46490', // staked
      '0x25c6779d4610f940bf2488732e10bcffb9d36f81', // ZKV
    ],
  },
  optimism: {
    type: ModuleType.MERKLE_ROOT_MULTISIG,
    threshold: 4,
    validators: [
      '0x9f2296d5cfc6b5176adc7716c7596898ded13d35', // abacus
      '0x9c10bbe8efa03a8f49dfdb5c549258e3a8dca097', // dsrv
      '0x62144d4a52a0a0335ea5bb84392ef9912461d9dd', // everstake
      '0xaff4718d5d637466ad07441ee3b7c4af8e328dbd', // zee prime
      '0xc64d1efeab8ae222bc889fe669f75d21b23005d9', // staked
      '0xfa174eb2b4921bb652bc1ada3e8b00e7e280bf3c', // ZKV
    ],
  },
  moonbeam: {
    type: ModuleType.MERKLE_ROOT_MULTISIG,
    threshold: 3,
    validators: [
      '0x237243d32d10e3bdbbf8dbcccc98ad44c1c172ea', // abacus
      '0x9509c8cf0a06955f27342262af501b74874e98fb', // dsrv
      '0xb7113c999e4d587b162dd1a28c73f3f51c6bdcdc', // everstake
      '0x26725501597d47352a23cd26f122709f69ad53bc', // staked
    ],
  },
  gnosis: {
    type: ModuleType.MERKLE_ROOT_MULTISIG,
    threshold: 3,
    validators: [
      '0xd0529ec8df08d0d63c0f023786bfa81e4bb51fd6', // abacus
      '0x8a72ff8571c53c62c7ca02e8c97a443cd5674383', // dsrv
      '0x4075c2f6bd6d9562067cfe551d49c2bcafa7d692', // everstake
      '0xa18580444eaeb1c5957e7b66a6bf84b6519f904d', // staked
    ],
  },
  // ----------------- Testnets -----------------
  alfajores: {
    type: ModuleType.MERKLE_ROOT_MULTISIG,
    threshold: 2,
    validators: [
      '0xe6072396568e73ce6803b12b7e04164e839f1e54',
      '0x9f177f51289b22515f41f95872e1511391b8e105',
      '0x15f77400845eb1c971ad08de050861d5508cad6c',
    ],
  },
  fuji: {
    type: ModuleType.MERKLE_ROOT_MULTISIG,
    threshold: 2,
    validators: [
      '0x9fa19ead5ec76e437948b35e227511b106293c40',
      '0x227e7d6507762ece0c94678f8c103eff9d682476',
      '0x2379e43740e4aa4fde48cf4f00a3106df1d8420d',
    ],
  },
  mumbai: {
    type: ModuleType.MERKLE_ROOT_MULTISIG,
    threshold: 2,
    validators: [
      '0x0a664ea799447da6b15645cf8b9e82072a68343f',
      '0x6ae6f12929a960aba24ba74ea310e3d37d0ac045',
      '0x51f70c047cd73bc7873273707501568857a619c4',
    ],
  },
  bsctestnet: {
    type: ModuleType.MERKLE_ROOT_MULTISIG,
    threshold: 2,
    validators: [
      '0x23338c8714976dd4a57eaeff17cbd26d7e275c08',
      '0x85a618d7450ebc37e0d682371f08dac94eec7a76',
      '0x95b76562e4ba1791a27ba4236801271c9115b141',
    ],
  },
  goerli: {
    type: ModuleType.MERKLE_ROOT_MULTISIG,
    threshold: 2,
    validators: [
      '0xf43fbd072fd38e1121d4b3b0b8a35116bbb01ea9',
      '0xa33020552a21f35e75bd385c6ab95c3dfa82d930',
      '0x0bba4043ff242f8bf3f39bafa8930a84d644d947',
    ],
  },
  sepolia: {
    type: ModuleType.MERKLE_ROOT_MULTISIG,
    threshold: 2,
    validators: [
      '0xbc748ee311f5f2d1975d61cdf531755ce8ce3066',
      '0xc4233b2bfe5aec08964a94b403052abb3eafcf07',
      '0x6b36286c19f5c10bdc139ea9ee7f82287303f61d',
    ],
  },
  moonbasealpha: {
    type: ModuleType.MERKLE_ROOT_MULTISIG,
    threshold: 2,
    validators: [
      '0x890c2aeac157c3f067f3e42b8afc797939c59a32',
      '0x1b06d6fe69b972ed7420c83599d5a5c0fc185904',
      '0xe70b85206a968a99a597581f0fa09c99e7681093',
    ],
  },
  optimismgoerli: {
    type: ModuleType.MERKLE_ROOT_MULTISIG,
    threshold: 2,
    validators: [
      '0xbb8d77eefbecc55db6e5a19b0fc3dc290776f189',
      '0x69792508b4ddaa3ca52241ccfcd1e0b119a1ee65',
      '0x11ddb46c6b653e0cdd7ad5bee32ae316e18f8453',
    ],
  },
  arbitrumgoerli: {
    type: ModuleType.MERKLE_ROOT_MULTISIG,
    threshold: 2,
    validators: [
      '0xce798fa21e323f6b24d9838a10ffecdefdfc4f30',
      '0xa792d39dca4426927e0f00c1618d61c9cb41779d',
      '0xdf181fcc11dfac5d01467e4547101a856dd5aa04',
    ],
  },
};
