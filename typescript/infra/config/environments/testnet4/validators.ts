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
    alfajores: {
      interval: 5,
      reorgPeriod: getReorgPeriod('alfajores'),
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
          [Contexts.Neutron]: [],
        },
        'alfajores',
      ),
    },
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
    ecotestnet: {
      interval: 5,
      reorgPeriod: getReorgPeriod('ecotestnet'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0xb3191420d463c2af8bd9b4a395e100ec5c05915a'],
          [Contexts.ReleaseCandidate]: [],
          [Contexts.Neutron]: [],
        },
        'ecotestnet',
      ),
    },
    fuji: {
      interval: 5,
      reorgPeriod: getReorgPeriod('alfajores'),
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
    connextsepolia: {
      interval: 5,
      reorgPeriod: getReorgPeriod('connextsepolia'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0xffbbec8c499585d80ef69eb613db624d27e089ab'],
          [Contexts.ReleaseCandidate]: [],
          [Contexts.Neutron]: [],
        },
        'connextsepolia',
      ),
    },
    holesky: {
      interval: 13,
      reorgPeriod: getReorgPeriod('holesky'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0x7ab28ad88bb45867137ea823af88e2cb02359c03'],
          [Contexts.ReleaseCandidate]: [
            '0x7ab28ad88bb45867137ea823af88e2cb02359c03',
          ],
          [Contexts.Neutron]: [],
        },
        'holesky',
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
    superpositiontestnet: {
      interval: 1,
      reorgPeriod: getReorgPeriod('superpositiontestnet'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0x1d3168504b23b73cdf9c27f13bb0a595d7f1a96a'],
          [Contexts.ReleaseCandidate]: [],
          [Contexts.Neutron]: [],
        },
        'superpositiontestnet',
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
    camptestnet: {
      interval: 5,
      reorgPeriod: getReorgPeriod('camptestnet'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0x238f40f055a7ff697ea6dbff3ae943c9eae7a38e'],
          [Contexts.ReleaseCandidate]: [],
          [Contexts.Neutron]: [],
        },
        'camptestnet',
      ),
    },
    formtestnet: {
      interval: 5,
      reorgPeriod: getReorgPeriod('formtestnet'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0x72ad7fddf16d17ff902d788441151982fa31a7bc'],
          [Contexts.ReleaseCandidate]: [],
          [Contexts.Neutron]: [],
        },
        'formtestnet',
      ),
    },
    soneiumtestnet: {
      interval: 5,
      reorgPeriod: getReorgPeriod('soneiumtestnet'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0x2e2101020ccdbe76aeda1c27823b0150f43d0c63'],
          [Contexts.ReleaseCandidate]: [],
          [Contexts.Neutron]: [],
        },
        'soneiumtestnet',
      ),
    },
    suavetoliman: {
      interval: 5,
      reorgPeriod: getReorgPeriod('suavetoliman'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0xf58f6e30aabba34e8dd7f79b3168507192e2cc9b'],
          [Contexts.ReleaseCandidate]: [],
          [Contexts.Neutron]: [],
        },
        'suavetoliman',
      ),
    },

    unichaintestnet: {
      interval: 5,
      reorgPeriod: getReorgPeriod('unichaintestnet'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0x5e99961cf71918308c3b17ef21b5f515a4f86fe5'],
          [Contexts.ReleaseCandidate]: [],
          [Contexts.Neutron]: [],
        },
        'unichaintestnet',
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

    odysseytestnet: {
      interval: 5,
      reorgPeriod: getReorgPeriod('odysseytestnet'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0xcc0a6e2d6aa8560b45b384ced7aa049870b66ea3'],
          [Contexts.ReleaseCandidate]: [],
          [Contexts.Neutron]: [],
        },
        'odysseytestnet',
      ),
    },

    alephzeroevmtestnet: {
      interval: 5,
      reorgPeriod: getReorgPeriod('alephzeroevmtestnet'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0x556cd94bcb6e5773e8df75e7eb3f91909d266a26'],
          [Contexts.ReleaseCandidate]: [],
          [Contexts.Neutron]: [],
        },
        'alephzeroevmtestnet',
      ),
    },
    inksepolia: {
      interval: 5,
      reorgPeriod: getReorgPeriod('inksepolia'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0xe61c846aee275070207fcbf43674eb254f06097a'],
          [Contexts.ReleaseCandidate]: [],
          [Contexts.Neutron]: [],
        },
        'inksepolia',
      ),
    },

    abstracttestnet: {
      interval: 5,
      reorgPeriod: getReorgPeriod('abstracttestnet'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0x7655bc4c9802bfcb3132b8822155b60a4fbbce3e'],
          [Contexts.ReleaseCandidate]: [],
          [Contexts.Neutron]: [],
        },
        'abstracttestnet',
      ),
    },
    treasuretopaz: {
      interval: 5,
      reorgPeriod: getReorgPeriod('treasuretopaz'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0x9750849beda0a7870462d4685f953fe39033a5ae'],
          [Contexts.ReleaseCandidate]: [],
          [Contexts.Neutron]: [],
        },
        'treasuretopaz',
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
    flametestnet: {
      interval: 5,
      reorgPeriod: getReorgPeriod('flametestnet'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0x0272625243bf2377f87538031fed54e21853cc2d'],
          [Contexts.ReleaseCandidate]: [],
          [Contexts.Neutron]: [],
        },
        'flametestnet',
      ),
    },
    sonicblaze: {
      interval: 5,
      reorgPeriod: getReorgPeriod('sonicblaze'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0xe5b98110d0688691ea280edea9a4faa1e3617ba1'],
          [Contexts.ReleaseCandidate]: [],
          [Contexts.Neutron]: [],
        },
        'sonicblaze',
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
    chronicleyellowstone: {
      interval: 5,
      reorgPeriod: getReorgPeriod('chronicleyellowstone'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0xf11cfeb2b6db66ec14c2ef7b685b36390cd648b4'],
        },
        'chronicleyellowstone',
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
    nobletestnet: {
      interval: 5,
      reorgPeriod: getReorgPeriod('nobletestnet'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0x0000000000000000000000000000000000000000'],
        },
        'nobletestnet',
      ),
    },
    weavevmtestnet: {
      interval: 5,
      reorgPeriod: getReorgPeriod('weavevmtestnet'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0x6d2ee6688de903bb31f3ae2ea31da87b697f7f40'],
        },
        'weavevmtestnet',
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
    infinityvmmonza: {
      interval: 5,
      reorgPeriod: getReorgPeriod('infinityvmmonza'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0x635e1ad8646f80ac7bdcd0be9bb69b6f229a31bb'],
        },
        'infinityvmmonza',
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
    plumetestnet2: {
      interval: 5,
      reorgPeriod: getReorgPeriod('plumetestnet2'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0x16637c78e1ea169132efcf4df8ebd03de349e740'],
        },
        'plumetestnet2',
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
    milkywaytestnet: {
      interval: 5,
      reorgPeriod: getReorgPeriod('milkywaytestnet'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0x65c7581e14efdf4d9c5320882170f022835bd742'],
        },
        'milkywaytestnet',
      ),
    },
  };
};
