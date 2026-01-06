import { ValidatorBaseChainConfigMap } from '../../../src/config/agent/validator.js';
import { Contexts } from '../../contexts.js';
import { getReorgPeriod } from '../../registry.js';
import { validatorBaseConfigsFn } from '../utils.js';

import { environment } from './chains.js';

export const validatorChainConfig = (
  context: Contexts,
): ValidatorBaseChainConfigMap => {
  const validatorsConfig = validatorBaseConfigsFn(environment, context);
  return {
    arbitrumsepolia: {
      interval: 5,
      reorgPeriod: getReorgPeriod('arbitrumsepolia'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0x09fabfbca0b8bf042e2a1161ee5010d147b0f603'],
          [Contexts.ReleaseCandidate]: [],
          [Contexts.Neutron]: [],
        },
        'arbitrumsepolia',
      ),
    },
    basesepolia: {
      interval: 5,
      reorgPeriod: getReorgPeriod('basesepolia'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0x82e3b437a2944e3ff00258c93e72cd1ba5e0e921'],
          [Contexts.ReleaseCandidate]: [],
          [Contexts.Neutron]: [],
        },
        'basesepolia',
      ),
    },
    fuji: {
      interval: 5,
      reorgPeriod: getReorgPeriod('fuji'),
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
          [Contexts.Neutron]: [],
        },
        'fuji',
      ),
    },
    bsctestnet: {
      interval: 5,
      reorgPeriod: getReorgPeriod('bsctestnet'),
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
          [Contexts.Neutron]: [],
        },
        'bsctestnet',
      ),
    },

    scrollsepolia: {
      interval: 5,
      reorgPeriod: getReorgPeriod('scrollsepolia'),
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
          [Contexts.Neutron]: [],
        },
        'scrollsepolia',
      ),
    },
    sepolia: {
      interval: 5,
      reorgPeriod: getReorgPeriod('sepolia'),
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
          [Contexts.Neutron]: [],
        },
        'sepolia',
      ),
    },
    optimismsepolia: {
      interval: 5,
      reorgPeriod: getReorgPeriod('optimismsepolia'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0x03efe4d0632ee15685d7e8f46dea0a874304aa29'],
          [Contexts.ReleaseCandidate]: [],
          [Contexts.Neutron]: [],
        },
        'optimismsepolia',
      ),
    },
    polygonamoy: {
      interval: 5,
      reorgPeriod: getReorgPeriod('polygonamoy'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0xf0290b06e446b320bd4e9c4a519420354d7ddccd'],
          [Contexts.ReleaseCandidate]: [],
          [Contexts.Neutron]: [],
        },
        'polygonamoy',
      ),
    },
    citreatestnet: {
      interval: 5,
      reorgPeriod: getReorgPeriod('citreatestnet'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0x60d7380a41eb95c49be18f141efd2fde5e3dba20'],
          [Contexts.ReleaseCandidate]: [],
          [Contexts.Neutron]: [],
        },
        'citreatestnet',
      ),
    },
    solanatestnet: {
      interval: 5,
      reorgPeriod: getReorgPeriod('solanatestnet'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0xd4ce8fa138d4e083fc0e480cca0dbfa4f5f30bd5'],
          [Contexts.ReleaseCandidate]: [],
          [Contexts.Neutron]: [],
        },
        'solanatestnet',
      ),
    },
    sonicsvmtestnet: {
      interval: 5,
      reorgPeriod: getReorgPeriod('sonicsvmtestnet'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0x83d4ef35f170ec822a0eaadb22a0c40003d8de23'],
          [Contexts.ReleaseCandidate]: [],
          [Contexts.Neutron]: [],
        },
        'sonicsvmtestnet',
      ),
    },
    arcadiatestnet2: {
      interval: 5,
      reorgPeriod: getReorgPeriod('arcadiatestnet2'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0xd39cd388ce3f616bc81be6dd3ec9348d7cdf4dff'],
          [Contexts.ReleaseCandidate]: [],
          [Contexts.Neutron]: [],
        },
        'arcadiatestnet2',
      ),
    },
    hyperliquidevmtestnet: {
      interval: 5,
      reorgPeriod: getReorgPeriod('hyperliquidevmtestnet'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0xea673a92a23ca319b9d85cc16b248645cd5158da'],
          [Contexts.ReleaseCandidate]: [],
          [Contexts.Neutron]: [],
        },
        'hyperliquidevmtestnet',
      ),
    },
    paradexsepolia: {
      interval: 5,
      reorgPeriod: getReorgPeriod('paradexsepolia'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0x7d49abcceafa5cd82f6615a9779f29c76bfc88e8'],
          [Contexts.ReleaseCandidate]: [],
          [Contexts.Neutron]: [],
        },
        'paradexsepolia',
      ),
    },

    starknetsepolia: {
      interval: 5,
      reorgPeriod: getReorgPeriod('starknetsepolia'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0xd07272cc3665d6e383a319691dcce5731ecf54a5'],
          [Contexts.ReleaseCandidate]: [],
          [Contexts.Neutron]: [],
        },
        'starknetsepolia',
      ),
    },

    subtensortestnet: {
      interval: 5,
      reorgPeriod: getReorgPeriod('subtensortestnet'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0xbe2cd57e9fd46b12107cfec7a2db61aa23edbe33'],
        },
        'subtensortestnet',
      ),
    },

    monadtestnet: {
      interval: 5,
      reorgPeriod: getReorgPeriod('monadtestnet'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0x734628f55694d2a5f4de3e755ccb40ecd72b16d9'],
        },
        'monadtestnet',
      ),
    },

    carrchaintestnet: {
      interval: 5,
      reorgPeriod: getReorgPeriod('carrchaintestnet'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0xa96dfc4d8c6cabb510701732ee01e52a75776205'],
        },
        'carrchaintestnet',
      ),
    },
    somniatestnet: {
      interval: 5,
      reorgPeriod: getReorgPeriod('somniatestnet'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0xb3b27a27bfa94002d344e9cf5217a0e3502e018b'],
        },
        'somniatestnet',
      ),
    },

    cotitestnet: {
      interval: 5,
      reorgPeriod: getReorgPeriod('cotitestnet'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0x5c535dff16237a2cae97c97f9556404cd230c9c0'],
        },
        'cotitestnet',
      ),
    },
    modetestnet: {
      interval: 5,
      reorgPeriod: getReorgPeriod('modetestnet'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0x9a9de3e406ab3e4ff12aa03ca9b868b48dc40402'],
        },
        'modetestnet',
      ),
    },

    kyvetestnet: {
      interval: 5,
      reorgPeriod: getReorgPeriod('kyvetestnet'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0x3c470ad2640bc0bcb6a790e8cf85e54d34ca92f5'],
        },
        'kyvetestnet',
      ),
    },

    auroratestnet: {
      interval: 5,
      reorgPeriod: getReorgPeriod('auroratestnet'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0xab1a2c76bf4cced43fde7bc1b5b57b9be3e7f937'],
        },
        'auroratestnet',
      ),
    },

    nobletestnet: {
      interval: 5,
      reorgPeriod: getReorgPeriod('nobletestnet'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0xc30427bd74fdcf179a15b9a6e3c4e1d66104726a'],
        },
        'nobletestnet',
      ),
    },
    megaethtestnet: {
      interval: 5,
      reorgPeriod: getReorgPeriod('megaethtestnet'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0xf5c8a82f966d2ec8563a2012ccf556ee3f4b25ef'],
        },
        'megaethtestnet',
      ),
    },
    basecamptestnet: {
      interval: 5,
      reorgPeriod: getReorgPeriod('basecamptestnet'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0x84441e39ed5251410aa2baa72e7747c46d1e5e9d'],
        },
        'basecamptestnet',
      ),
    },

    neuratestnet: {
      interval: 5,
      reorgPeriod: getReorgPeriod('neuratestnet'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0xc14514a91d0ee90ba3070abb6bfb45a10e6d341d'],
        },
        'neuratestnet',
      ),
    },

    celestiatestnet: {
      interval: 5,
      reorgPeriod: getReorgPeriod('celestiatestnet'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0x3e0227b7f129576c53ff5d98d17c9b8433445094'],
        },
        'celestiatestnet',
      ),
    },

    celosepolia: {
      interval: 5,
      reorgPeriod: getReorgPeriod('celosepolia'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0x4a5cfcfd7f793f4ceba170c3decbe43bd8253ef6'],
        },
        'celosepolia',
      ),
    },

    incentivtestnet: {
      interval: 5,
      reorgPeriod: getReorgPeriod('incentivtestnet'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0x3133eeb96fd96f9f99291088613edf7401149e6f'],
        },
        'incentivtestnet',
      ),
    },

    radixtestnet: {
      interval: 5,
      reorgPeriod: getReorgPeriod('radixtestnet'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0xeddaf7958627cfd35400c95db19a656a4a8a92c6'],
        },
        'radixtestnet',
      ),
    },

    giwasepolia: {
      interval: 5,
      reorgPeriod: getReorgPeriod('giwasepolia'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0xc170bef56759e35740ac2d3d0fece33bd9acb90b'],
        },
        'giwasepolia',
      ),
    },

    aleotestnet: {
      interval: 5,
      reorgPeriod: getReorgPeriod('aleotestnet'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0x7233d80194c69af6b84b0786a7fd2a7294396ca8'],
        },
        'aleotestnet',
      ),
    },
  };
};
