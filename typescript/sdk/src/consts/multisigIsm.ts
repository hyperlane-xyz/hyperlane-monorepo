import { MultisigConfig } from '../ism/types';
import { ChainMap } from '../types';

export const defaultMultisigIsmConfigs: ChainMap<MultisigConfig> = {
  // ----------------- Mainnets -----------------
  celo: {
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
    threshold: 3,
    validators: [
      '0x237243d32d10e3bdbbf8dbcccc98ad44c1c172ea', // abacus
      '0x9509c8cf0a06955f27342262af501b74874e98fb', // dsrv
      '0xb7113c999e4d587b162dd1a28c73f3f51c6bdcdc', // everstake
      '0x26725501597d47352a23cd26f122709f69ad53bc', // staked
    ],
  },
  gnosis: {
    threshold: 3,
    validators: [
      '0xd0529ec8df08d0d63c0f023786bfa81e4bb51fd6', // abacus
      '0x8a72ff8571c53c62c7ca02e8c97a443cd5674383', // dsrv
      '0x4075c2f6bd6d9562067cfe551d49c2bcafa7d692', // everstake
      '0xa18580444eaeb1c5957e7b66a6bf84b6519f904d', // staked
    ],
  },
  solana: {
    threshold: 2,
    validators: [
      '0x3cd1a081f38874bbb075bf10b62adcb858db864c', // abacus
      '0x2b0c45f6111ae1c1684d4287792e3bd6ebd1abcc', // ZKV
      '0x7b9ec253a8ba38994457eb9dbe386938d545351a', // everstake
    ],
  },
  // ----------------- Testnets -----------------
  alfajores: {
    threshold: 2,
    validators: [
      '0x2233a5ce12f814bd64c9cdd73410bb8693124d40',
      '0xba279f965489d90f90490e3c49e860e0b43c2ae6',
      '0x86485dcec5f7bb8478dd251676372d054dea6653',
    ],
  },
  basegoerli: {
    threshold: 2,
    validators: [
      '0xf6eddda696dcd3bf10f7ce8a02db31ef2e775a03',
      '0x5a7d05cebf5db4dde9b2fedcefa76fb58fa05071',
      '0x9260a6c7d54cbcbed28f8668679cd1fa3a203b25',
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
  chiado: {
    threshold: 2,
    validators: [
      '0x06c3757a4b7a912828e523bb8a5f980ddc297356',
      '0x0874967a145d70b799ebe9ed861ab7c93faef95a',
      '0xd767ea1206b8295d7e1267ddd00e56d34f278db6',
    ],
  },
  lineagoerli: {
    threshold: 2,
    validators: [
      '0xd767ea1206b8295d7e1267ddd00e56d34f278db6',
      '0x4a5d7085ca93c22fbc994dd97857c98fcc745674',
      '0x8327779c3c31fa1ffc7f0c9ffae33e4d804bbd8f',
    ],
  },
  mumbai: {
    threshold: 2,
    validators: [
      '0xebc301013b6cd2548e347c28d2dc43ec20c068f2',
      '0x315db9868fc8813b221b1694f8760ece39f45447',
      '0x17517c98358c5937c5d9ee47ce1f5b4c2b7fc9f5',
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
  goerli: {
    threshold: 2,
    validators: [
      '0x05a9b5efe9f61f9142453d8e9f61565f333c6768',
      '0x43a96c7dfbd8187c95013d6ee8665650cbdb2673',
      '0x7940a12c050e24e1839c21ecb12f65afd84e8c5b',
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
  sepolia: {
    threshold: 2,
    validators: [
      '0xb22b65f202558adf86a8bb2847b76ae1036686a5',
      '0x469f0940684d147defc44f3647146cb90dd0bc8e',
      '0xd3c75dcf15056012a4d74c483a0c6ea11d8c2b83',
    ],
  },
  moonbasealpha: {
    threshold: 2,
    validators: [
      '0x521877064bd7ac7500d300f162c8c47c256a2f9c',
      '0xbc1c70f58ae0459d4b8a013245420a893837d568',
      '0x01e42c2c44af81dda1ac16fec76fea2a7a54a44c',
    ],
  },
  optimismgoerli: {
    threshold: 2,
    validators: [
      '0x79e58546e2faca865c6732ad5f6c4951051c4d67',
      '0x7bbfe1bb7146aad7df309c637987d856179ebbc1',
      '0xf3d2fb4d53c2bb6a88cec040e0d87430fcee4e40',
    ],
  },
  arbitrumgoerli: {
    threshold: 2,
    validators: [
      '0x071c8d135845ae5a2cb73f98d681d519014c0a8b',
      '0x1bcf03360989f15cbeb174c188288f2c6d2760d7',
      '0xc1590eaaeaf380e7859564c5ebcdcc87e8369e0d',
    ],
  },

  polygonzkevmtestnet: {
    threshold: 2,
    validators: [
      '0x3f06b725bc9648917eb11c414e9f8d76fd959550',
      '0x27bfc57679d9dd4ab2e870f5ed7ec0b339a0b636',
      '0xd476548222f43206d0abaa30e46e28670aa7859c',
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
};
