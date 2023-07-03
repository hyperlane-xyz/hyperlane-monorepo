import { chainMetadata } from '@hyperlane-xyz/sdk';

import { ValidatorBaseChainConfigMap } from '../../../../src/config/agent';
import { Contexts } from '../../../contexts';
import { validatorsConfig } from '../../utils';
import { environment } from '../chains';

import { keys } from './keys';

export const validatorChainConfig = (
  context: Contexts,
): ValidatorBaseChainConfigMap => {
  return {
    alfajores: {
      interval: 5,
      reorgPeriod: chainMetadata.alfajores.blocks!.reorgPeriod!,
      validators: validatorsConfig(context, environment, 'alfajores', keys),
    },
    fuji: {
      interval: 5,
      reorgPeriod: chainMetadata.fuji.blocks!.reorgPeriod!,
      validators: validatorsConfig(context, environment, 'fuji', keys),
    },
    mumbai: {
      interval: 5,
      reorgPeriod: chainMetadata.mumbai.blocks!.reorgPeriod!,
      validators: validatorsConfig(context, environment, 'mumbai', keys),
    },
    bsctestnet: {
      interval: 5,
      reorgPeriod: chainMetadata.bsctestnet.blocks!.reorgPeriod!,
      validators: validatorsConfig(context, environment, 'bsctestnet', keys),
    },
    goerli: {
      interval: 5,
      reorgPeriod: chainMetadata.goerli.blocks!.reorgPeriod!,
      validators: validatorsConfig(context, environment, 'goerli', keys),
    },
    sepolia: {
      interval: 5,
      reorgPeriod: chainMetadata.sepolia.blocks!.reorgPeriod!,
      validators: validatorsConfig(context, environment, 'sepolia', keys),
    },
    moonbasealpha: {
      interval: 5,
      reorgPeriod: chainMetadata.moonbasealpha.blocks!.reorgPeriod!,
      validators: validatorsConfig(context, environment, 'moonbasealpha', keys),
    },
    optimismgoerli: {
      interval: 5,
      reorgPeriod: chainMetadata.optimismgoerli.blocks!.reorgPeriod!,
      validators: validatorsConfig(
        context,
        environment,
        'optimismgoerli',
        keys,
      ),
    },
    arbitrumgoerli: {
      interval: 5,
      reorgPeriod: chainMetadata.arbitrumgoerli.blocks!.reorgPeriod!,
      validators: validatorsConfig(
        context,
        environment,
        'arbitrumgoerli',
        keys,
      ),
    },
  };
};
