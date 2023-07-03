import { ValidatorBaseChainConfigMap } from '../../../../src/config/agent';
import { Contexts } from '../../../contexts';
import { validatorsConfig } from '../../utils';
import { environment } from '../chains';

import { keys } from './keys';

export const validatorChainConfig = (
  context: Contexts,
): ValidatorBaseChainConfigMap => {
  return {
    celo: {
      interval: 5,
      reorgPeriod: 0,
      validators: validatorsConfig(context, environment, 'celo', keys),
    },
    ethereum: {
      interval: 5,
      reorgPeriod: 20,
      validators: validatorsConfig(context, environment, 'ethereum', keys),
    },
    avalanche: {
      interval: 5,
      reorgPeriod: 3,
      validators: validatorsConfig(context, environment, 'avalanche', keys),
    },
    polygon: {
      interval: 5,
      reorgPeriod: 256,
      validators: validatorsConfig(context, environment, 'polygon', keys),
    },
    bsc: {
      interval: 5,
      reorgPeriod: 15,
      validators: validatorsConfig(context, environment, 'bsc', keys),
    },
    arbitrum: {
      interval: 5,
      reorgPeriod: 0,
      validators: validatorsConfig(context, environment, 'arbitrum', keys),
    },
    optimism: {
      interval: 5,
      reorgPeriod: 0,
      validators: validatorsConfig(context, environment, 'optimism', keys),
    },
    moonbeam: {
      interval: 5,
      reorgPeriod: 2,
      validators: validatorsConfig(context, environment, 'moonbeam', keys),
    },
    gnosis: {
      interval: 5,
      reorgPeriod: 14,
      validators: validatorsConfig(context, environment, 'gnosis', keys),
    },
  };
};
