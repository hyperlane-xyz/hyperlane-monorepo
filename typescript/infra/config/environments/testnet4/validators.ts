import { chainMetadata } from '@hyperlane-xyz/sdk';

import { ValidatorBaseChainConfigMap } from '../../../src/config/agent';
import { Contexts } from '../../contexts';
import { validatorBaseConfigsFn } from '../utils';

import { environment } from './chains';

export const validatorChainConfig = (
  context: Contexts,
): ValidatorBaseChainConfigMap => {
  const validatorsConfig = validatorBaseConfigsFn(environment, context);
  return {
    alfajores: {
      interval: 5,
      reorgPeriod: chainMetadata.alfajores.blocks!.reorgPeriod!,
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: [
            '0x2233a5ce12f814bd64c9cdd73410bb8693124d40',
            '0xba279f965489d90f90490e3c49e860e0b43c2ae6',
            '0x86485dcec5f7bb8478dd251676372d054dea6653',
          ],
          [Contexts.ReleaseCandidate]: [
            '0xace978aaa61d9ee44fe3ab147fd227e0e66b8909',
            '0x6c8bfdfb8c40aba10cc9fb2cf0e3e856e0e5dbb3',
            '0x54c65eb7677e6086cdde3d5ccef89feb2103a11d',
          ],
        },
        'alfajores',
      ),
    },
    basegoerli: {
      interval: 5,
      reorgPeriod: chainMetadata.basegoerli.blocks!.reorgPeriod!,
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: [
            '0xf6eddda696dcd3bf10f7ce8a02db31ef2e775a03',
            '0x5a7d05cebf5db4dde9b2fedcefa76fb58fa05071',
            '0x9260a6c7d54cbcbed28f8668679cd1fa3a203b25',
          ],
          [Contexts.ReleaseCandidate]: [
            '0x81983e03363351b63848867bd76687cc80b9ff37',
            '0x36de434527b8f83851d83f1b1d72ec11a5903533',
            '0x4b65f7527c267e420bf62a0c5a139cb8c3906277',
          ],
        },
        'basegoerli',
      ),
    },
    fuji: {
      interval: 5,
      reorgPeriod: chainMetadata.fuji.blocks!.reorgPeriod!,
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: [
            '0xd8154f73d04cc7f7f0c332793692e6e6f6b2402e',
            '0x895ae30bc83ff1493b9cf7781b0b813d23659857',
            '0x43e915573d9f1383cbf482049e4a012290759e7f',
          ],
          [Contexts.ReleaseCandidate]: [
            '0xfc419f9ba3c56c55e28844ade491d428f5a77d55',
            '0x0a636e76df4124b092cabb4321d6aaef9defb514',
            '0xbf86037899efe97bca4cea865607e10b849b5878',
          ],
        },
        'fuji',
      ),
    },
    // chiado: {
    //   interval: 5,
    //   reorgPeriod: chainMetadata.chiado.blocks!.reorgPeriod!,
    //   validators: validatorsConfig(
    //     {
    //       [Contexts.Hyperlane]: [
    //         '0x12b1d1354441b900e0a36659ae54c3a9d5d22c57',
    //         '0x06c3757a4b7a912828e523bb8a5f980ddc297356',
    //         '0x0874967a145d70b799ebe9ed861ab7c93faef95a',
    //       ],
    //       [Contexts.ReleaseCandidate]: [
    //         '0x7572ffd8af1abc02cc1d234ac750d387fd6768a0',
    //         '0x31b37a32657cf2915d434b409ee86978058fa91c',
    //         '0x32495780512fce64a45aca55ccc02202e9018dc5',
    //       ],
    //     },
    //     'chiado',
    //   ),
    // },
    // lineagoerli: {
    //   interval: 5,
    //   reorgPeriod: chainMetadata.lineagoerli.blocks!.reorgPeriod!,
    //   validators: validatorsConfig(
    //     {
    //       [Contexts.Hyperlane]: [
    //         '0xd767ea1206b8295d7e1267ddd00e56d34f278db6',
    //         '0x4a5d7085ca93c22fbc994dd97857c98fcc745674',
    //         '0x8327779c3c31fa1ffc7f0c9ffae33e4d804bbd8f',
    //       ],
    //       [Contexts.ReleaseCandidate]: [
    //         '0x52e2c6db923124e646011d172dea644e1cafe583',
    //         '0x48d540e94ff1acb886df6bfed2b7a92568639364',
    //         '0xe99e3acc543a535b8eeae98f3d6f39015efe0cd0',
    //       ],
    //     },
    //     'lineagoerli',
    //   ),
    // },
    mumbai: {
      interval: 5,
      reorgPeriod: chainMetadata.mumbai.blocks!.reorgPeriod!,
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: [
            '0xebc301013b6cd2548e347c28d2dc43ec20c068f2',
            '0x315db9868fc8813b221b1694f8760ece39f45447',
            '0x17517c98358c5937c5d9ee47ce1f5b4c2b7fc9f5',
          ],
          [Contexts.ReleaseCandidate]: [
            '0x7fc2981964427f09e317eda559f506bfd37f1ccb',
            '0x954168cf13faeaa248d412e145a17dc697556636',
            '0x98a9f2610e44246ac0c749c20a07a6eb192ce9eb',
          ],
        },
        'mumbai',
      ),
    },
    bsctestnet: {
      interval: 5,
      reorgPeriod: chainMetadata.bsctestnet.blocks!.reorgPeriod!,
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: [
            '0x242d8a855a8c932dec51f7999ae7d1e48b10c95e',
            '0xf620f5e3d25a3ae848fec74bccae5de3edcd8796',
            '0x1f030345963c54ff8229720dd3a711c15c554aeb',
          ],
          [Contexts.ReleaseCandidate]: [
            '0x6353c7402626054c824bd0eca721f82b725e2b4d',
            '0xcb5be62b19c52b78cd3993c71c3fa74d821475ae',
            '0xc50ddb8f03133611853b7f03ffe0a8098e08ae15',
          ],
        },
        'bsctestnet',
      ),
    },
    goerli: {
      interval: 5,
      reorgPeriod: chainMetadata.goerli.blocks!.reorgPeriod!,
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: [
            '0x05a9b5efe9f61f9142453d8e9f61565f333c6768',
            '0x43a96c7dfbd8187c95013d6ee8665650cbdb2673',
            '0x7940a12c050e24e1839c21ecb12f65afd84e8c5b',
          ],
          [Contexts.ReleaseCandidate]: [
            '0x6b32af7592948cbec6893363f77c08252d0ce0d7',
            '0x4711d476a5929840196def397a156c5253b44b96',
            '0xb0add42f2a4b824ba5fab2628f930dc1dcfc40f8',
          ],
        },
        'goerli',
      ),
    },
    scrollsepolia: {
      interval: 5,
      reorgPeriod: chainMetadata.scrollsepolia.blocks!.reorgPeriod!,
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: [
            '0xbe18dbd758afb367180260b524e6d4bcd1cb6d05',
            '0x9a11ed23ae962974018ab45bc133caabff7b3271',
            '0x7867bea3c9761fe64e6d124b171f91fd5dd79644',
          ],
          [Contexts.ReleaseCandidate]: [
            '0x50d939d66f114350f322eb8b2e9f01fbc401d4c9',
            '0x10fa7a657a06a47bcca1bacc436d61619e5d104c',
            '0xa0f1cf3b23bd0f8a5e2ad438657097b8287816b4',
          ],
        },
        'scrollsepolia',
      ),
    },
    sepolia: {
      interval: 5,
      reorgPeriod: chainMetadata.sepolia.blocks!.reorgPeriod!,
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: [
            '0xb22b65f202558adf86a8bb2847b76ae1036686a5',
            '0x469f0940684d147defc44f3647146cb90dd0bc8e',
            '0xd3c75dcf15056012a4d74c483a0c6ea11d8c2b83',
          ],
          [Contexts.ReleaseCandidate]: [
            '0x49f253c0dab33be1573d6c2769b3d9e584d91f82',
            '0x13b51805e9af68e154778d973165f32e10b7446b',
            '0x7f699c3fc3de4928f1c0abfba1eac3fbb5a00d1b',
          ],
        },
        'sepolia',
      ),
    },
    moonbasealpha: {
      interval: 5,
      reorgPeriod: chainMetadata.moonbasealpha.blocks!.reorgPeriod!,
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: [
            '0x521877064bd7ac7500d300f162c8c47c256a2f9c',
            '0xbc1c70f58ae0459d4b8a013245420a893837d568',
            '0x01e42c2c44af81dda1ac16fec76fea2a7a54a44c',
          ],
          [Contexts.ReleaseCandidate]: [
            '0x376260b40b2ba2100890f27de1eb18a2774f54d1',
            '0x776623e8be8d7218940b7c77d02162af4ff97985',
            '0xb4c81facd992a6c7c4a187bcce35a6fc968399a0',
          ],
        },
        'moonbasealpha',
      ),
    },
    optimismgoerli: {
      interval: 5,
      reorgPeriod: chainMetadata.optimismgoerli.blocks!.reorgPeriod!,
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: [
            '0x79e58546e2faca865c6732ad5f6c4951051c4d67',
            '0x7bbfe1bb7146aad7df309c637987d856179ebbc1',
            '0xf3d2fb4d53c2bb6a88cec040e0d87430fcee4e40',
          ],
          [Contexts.ReleaseCandidate]: [
            '0xed4cf9bf144457c927d7a39613c812c53f296283',
            '0xec6b5ddfd20ee64ff0dcbc7472ad757dce151685',
            '0x4acd2983a51f1c33c2ab41669184c7679e0316f1',
          ],
        },
        'optimismgoerli',
      ),
    },
    arbitrumgoerli: {
      interval: 5,
      reorgPeriod: chainMetadata.arbitrumgoerli.blocks!.reorgPeriod!,
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: [
            '0x071c8d135845ae5a2cb73f98d681d519014c0a8b',
            '0x1bcf03360989f15cbeb174c188288f2c6d2760d7',
            '0xc1590eaaeaf380e7859564c5ebcdcc87e8369e0d',
          ],
          [Contexts.ReleaseCandidate]: [
            '0x869f67e89b5c0826a3c2f2ba72e6ae1d8a1952ff',
            '0x9be82c7a063b47b2d04c890daabcb666b670a9a4',
            '0x92c62f4b9cd60a7fe4216d1f12134d34cf827c41',
          ],
        },
        'arbitrumgoerli',
      ),
    },
    polygonzkevmtestnet: {
      interval: 5,
      reorgPeriod: chainMetadata.polygonzkevmtestnet.blocks!.reorgPeriod!,
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: [
            '0x3f06b725bc9648917eb11c414e9f8d76fd959550',
            '0x27bfc57679d9dd4ab2e870f5ed7ec0b339a0b636',
            '0xd476548222f43206d0abaa30e46e28670aa7859c',
          ],
          [Contexts.ReleaseCandidate]: [
            '0x2d0214068e5d8e49c638b5a4c70c75080204be21',
            '0x989bbbfa753431169556f69be1b0a496b252e8a6',
            '0x292d5788587bb5efd5c2c911115527e57f50cd05',
          ],
        },
        'polygonzkevmtestnet',
      ),
    },
    // proteustestnet: {
    //   interval: 5,
    //   reorgPeriod: chainMetadata.proteustestnet.blocks!.reorgPeriod!,
    //   validators: validatorsConfig(
    //     {
    //       [Contexts.Hyperlane]: [
    //         '0x79fc73656abb9eeaa5ee853c4569124f5bdaf9d8',
    //         '0x72840388d5ab57323bc4f6e6d3ddedfd5cc911f0',
    //         '0xd4b2a50c53fc6614bb3cd3198e0fdc03f5da973f',
    //       ],
    //       [Contexts.ReleaseCandidate]: [
    //         '0xc2ccc4eab0e8d441235d661e39341ae16c3bf8cd',
    //       ],
    //     },
    //     'proteustestnet',
    //   ),
    // },
    // solanadevnet: {
    //   interval: 10,
    //   reorgPeriod: chainMetadata.solanadevnet.blocks!.reorgPeriod!,
    //   validators: validatorsConfig(
    //     {
    //       [Contexts.Hyperlane]: [
    //         '0xec0f73dbc5b1962a20f7dcbe07c98414025b0c43',
    //         '0x9c20a149dfa09ea9f77f5a7ca09ed44f9c025133',
    //         '0x967c5ecdf2625ae86580bd203b630abaaf85cd62',
    //       ],
    //       [Contexts.ReleaseCandidate]: [
    //         '0x21b9eff4d1a6d3122596c7fb80315bf094b6e5c2',
    //       ],
    //     },
    //     'solanadevnet',
    //   ),
    // },
  };
};
