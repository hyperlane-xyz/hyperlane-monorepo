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
    celo: {
      interval: 5,
      reorgPeriod: 0,
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0x1f20274b1210046769d48174c2f0e7c25ca7d5c5'],
          [Contexts.ReleaseCandidate]: [
            '0xe7a82e210f512f8e9900d6bc2acbf7981c63e66e',
          ],
        },
        'celo',
      ),
    },
    ethereum: {
      interval: 5,
      reorgPeriod: 20,
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0x4c327ccb881a7542be77500b2833dc84c839e7b7'],
          [Contexts.ReleaseCandidate]: [
            '0xaea1adb1c687b061e5b60b9da84cb69e7b5fab44',
          ],
        },
        'ethereum',
      ),
    },
    avalanche: {
      interval: 5,
      reorgPeriod: 3,
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0xa7aa52623fe3d78c343008c95894be669e218b8d'],
          [Contexts.ReleaseCandidate]: [
            '0x706976391e23dea28152e0207936bd942aba01ce',
          ],
        },
        'avalanche',
      ),
    },
    polygon: {
      interval: 5,
      reorgPeriod: 256,
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0x59a001c3451e7f9f3b4759ea215382c1e9aa5fc1'],
          [Contexts.ReleaseCandidate]: [
            '0xef372f6ff7775989b3ac884506ee31c79638c989',
          ],
        },
        'polygon',
      ),
    },
    bsc: {
      interval: 5,
      reorgPeriod: 15,
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0xcc84b1eb711e5076b2755cf4ad1d2b42c458a45e'],
          [Contexts.ReleaseCandidate]: [
            '0x0823081031a4a6f97c6083775c191d17ca96d0ab',
          ],
        },
        'bsc',
      ),
    },
    arbitrum: {
      interval: 5,
      reorgPeriod: 0,
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0xbcb815f38d481a5eba4d7ac4c9e74d9d0fc2a7e7'],
          [Contexts.ReleaseCandidate]: [
            '0x1a95b35fb809d57faf1117c1cc29a6c5df289df1',
          ],
        },
        'arbitrum',
      ),
    },
    optimism: {
      interval: 5,
      reorgPeriod: 0,
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0x9f2296d5cfc6b5176adc7716c7596898ded13d35'],
          [Contexts.ReleaseCandidate]: [
            '0x60e938bf280bbc21bacfd8bf435459d9003a8f98',
          ],
        },
        'optimism',
      ),
    },
    moonbeam: {
      interval: 5,
      reorgPeriod: 2,
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0x237243d32d10e3bdbbf8dbcccc98ad44c1c172ea'],
          [Contexts.ReleaseCandidate]: [
            '0x0df7140811e309dc69638352545151ebb9d5e0fd',
          ],
        },
        'moonbeam',
      ),
    },
    gnosis: {
      interval: 5,
      reorgPeriod: 14,
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0xd0529ec8df08d0d63c0f023786bfa81e4bb51fd6'],
          [Contexts.ReleaseCandidate]: [
            '0x15f48e78092a4f79febface509cfd76467c6cdbb',
          ],
        },
        'gnosis',
      ),
    },
    solana: {
      interval: 5,
      reorgPeriod: chainMetadata.solana.blocks!.reorgPeriod!,
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: [
            '0x3cd1a081f38874bbb075bf10b62adcb858db864c',
            '0x28aa072634dd41d19471640237852e807bd9901f',
            '0x8a93ba04f4e30064660670cb581d9aa10df78929',
          ],
          [Contexts.ReleaseCandidate]: [
            '0x8cc7dbfb5de339e4133f3af059c927ec383ace38',
          ],
        },
        'solana',
      ),
    },
    nautilus: {
      interval: 5,
      reorgPeriod: chainMetadata.nautilus.blocks!.reorgPeriod!,
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: [
            '0x9c920af9467595a23cb3433adefc3854d498a437',
            '0x12b583ce1623b7de3fc727ccccda24dcab1fe022',
            '0xc8b996a421ff1e203070c709c1af93944c049cc0',
          ],
          [Contexts.ReleaseCandidate]: [
            '0xdaf2e5ddaf2532753dc78bb6fbb0a10204c888c1',
          ],
        },
        'nautilus',
      ),
    },
  };
};
