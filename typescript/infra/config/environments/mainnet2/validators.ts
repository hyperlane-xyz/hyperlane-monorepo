import { ValidatorBaseChainConfigMap } from '../../../src/config/agent';
import { Contexts } from '../../contexts';
import { validatorsConfig } from '../utils';

import { environment } from './chains';

export const validatorChainConfig = (
  context: Contexts,
  count: number = 1,
): ValidatorBaseChainConfigMap => {
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
        context,
        environment,
        'celo',
        count,
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
        context,
        environment,
        'ethereum',
        count,
      ),
    },
    avalanche: {
      interval: 5,
      reorgPeriod: 3,
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0x4c327ccb881a7542be77500b2833dc84c839e7b7'],
          [Contexts.ReleaseCandidate]: [
            '0x706976391e23dea28152e0207936bd942aba01ce',
          ],
        },
        context,
        environment,
        'avalanche',
        count,
      ),
    },
    polygon: {
      interval: 5,
      reorgPeriod: 256,
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0x4c327ccb881a7542be77500b2833dc84c839e7b7'],
          [Contexts.ReleaseCandidate]: [
            '0xef372f6ff7775989b3ac884506ee31c79638c989',
          ],
        },
        context,
        environment,
        'polygon',
        count,
      ),
    },
    bsc: {
      interval: 5,
      reorgPeriod: 15,
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0x4c327ccb881a7542be77500b2833dc84c839e7b7'],
          [Contexts.ReleaseCandidate]: [
            '0x0823081031a4a6f97c6083775c191d17ca96d0ab',
          ],
        },
        context,
        environment,
        'bsc',
        count,
      ),
    },
    arbitrum: {
      interval: 5,
      reorgPeriod: 0,
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0x4c327ccb881a7542be77500b2833dc84c839e7b7'],
          [Contexts.ReleaseCandidate]: [
            '0x1a95b35fb809d57faf1117c1cc29a6c5df289df1',
          ],
        },
        context,
        environment,
        'arbitrum',
        count,
      ),
    },
    optimism: {
      interval: 5,
      reorgPeriod: 0,
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0x4c327ccb881a7542be77500b2833dc84c839e7b7'],
          [Contexts.ReleaseCandidate]: [
            '0x60e938bf280bbc21bacfd8bf435459d9003a8f98',
          ],
        },
        context,
        environment,
        'optimism',
        count,
      ),
    },
    moonbeam: {
      interval: 5,
      reorgPeriod: 2,
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0x4c327ccb881a7542be77500b2833dc84c839e7b7'],
          [Contexts.ReleaseCandidate]: [
            '0x0df7140811e309dc69638352545151ebb9d5e0fd',
          ],
        },
        context,
        environment,
        'moonbeam',
        count,
      ),
    },
    gnosis: {
      interval: 5,
      reorgPeriod: 14,
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0x4c327ccb881a7542be77500b2833dc84c839e7b7'],
          [Contexts.ReleaseCandidate]: [
            '0x15f48e78092a4f79febface509cfd76467c6cdbb',
          ],
        },
        context,
        environment,
        'gnosis',
        count,
      ),
    },
  };
};
