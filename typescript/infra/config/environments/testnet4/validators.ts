import { chainMetadata, getReorgPeriod } from '@hyperlane-xyz/sdk';

import { ValidatorBaseChainConfigMap } from '../../../src/config/agent/validator.js';
import { Contexts } from '../../contexts.js';
import { validatorBaseConfigsFn } from '../utils.js';

import { environment } from './chains.js';

export const validatorChainConfig = (
  context: Contexts,
): ValidatorBaseChainConfigMap => {
  const validatorsConfig = validatorBaseConfigsFn(environment, context);
  return {
    alfajores: {
      interval: 5,
      reorgPeriod: getReorgPeriod(chainMetadata.alfajores),
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
    fuji: {
      interval: 5,
      reorgPeriod: getReorgPeriod(chainMetadata.alfajores),
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
      reorgPeriod: getReorgPeriod(chainMetadata.bsctestnet),
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
      reorgPeriod: getReorgPeriod(chainMetadata.scrollsepolia),
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
      reorgPeriod: getReorgPeriod(chainMetadata.sepolia),
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
    plumetestnet: {
      interval: 5,
      reorgPeriod: getReorgPeriod(chainMetadata.plumetestnet),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: [
            '0xe765a214849f3ecdf00793b97d00422f2d408ea6',
            '0xb59998f71efc65190a85ac5e81b66bd72a192a3b',
            '0xc906470a73e6b5aad65a4ceb4acd73e3eaf80e2c',
          ],
          [Contexts.ReleaseCandidate]: [
            '0xe6e6aeecbf7755cdbc50c2683df9f2d100f6399d',
            '0x27946c13a475233a3b1eb47f0bd0f7cdec3a3983',
            '0x2596413213368475c96ddfb1ae26666d22093a8b',
          ],
          [Contexts.Neutron]: [],
        },
        'plumetestnet',
      ),
    },
    injective: {
      interval: 5,
      reorgPeriod: getReorgPeriod(chainMetadata.injective),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0x10686BEe585491A0DA5bfCd5ABfbB95Ab4d6c86d'],
          [Contexts.ReleaseCandidate]: [],
          [Contexts.Neutron]: [],
        },
        'injective',
      ),
    },
    // proteustestnet: {
    //   interval: 5,
    //   reorgPeriod: getReorgPeriod(chainMetadata.proteustestnet),
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
    solanatestnet: {
      interval: 1,
      reorgPeriod: getReorgPeriod(chainMetadata.solanatestnet),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0xd4ce8fa138d4e083fc0e480cca0dbfa4f5f30bd5'],
          [Contexts.ReleaseCandidate]: [],
          [Contexts.Neutron]: [],
        },
        'solanatestnet',
      ),
    },
    eclipsetestnet: {
      interval: 1,
      reorgPeriod: getReorgPeriod(chainMetadata.eclipsetestnet),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0xf344f34abca9a444545b5295066348a0ae22dda3'],
          [Contexts.ReleaseCandidate]: [],
          [Contexts.Neutron]: [],
        },
        'eclipsetestnet',
      ),
    },
  };
};
