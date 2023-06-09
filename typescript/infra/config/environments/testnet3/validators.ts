import { CoreChainName, chainMetadata } from '@hyperlane-xyz/sdk';

import {
  CheckpointSyncerType,
  ValidatorBaseChainConfigMap,
} from '../../../src/config/agent';
import { ValidatorBaseConfig } from '../../../src/config/agent/validator';
import { Role } from '../../../src/roles';
import { Contexts } from '../../contexts';

import { environment } from './chains';
import { keys } from './keys';

const s3BucketRegion = 'us-east-1';

const s3BucketName = (
  context: Contexts,
  chainName: CoreChainName,
  index: number,
) => `${context}-${environment}-${chainName}-validator-${index}`;

const validatorsFn = (
  context: Contexts,
  chain: CoreChainName,
  count: number,
): Array<ValidatorBaseConfig> => {
  const chainKeys = keys[context].filter(
    (v) =>
      v.identifier.includes(Role.Validator) && v.identifier.includes(chain),
  );

  return Array.from({ length: count }, (_, i) => {
    const name = s3BucketName(context, chain, i);
    const key = chainKeys.find((v) => v.identifier.endsWith(`${i}`));
    return {
      name,
      address: key!.address,
      checkpointSyncer: {
        type: CheckpointSyncerType.S3,
        bucket: name,
        region: s3BucketRegion,
      },
    };
  });
};

const validatorsConfigFn = (
  context: Contexts,
): ValidatorBaseChainConfigMap => ({
  alfajores: {
    interval: 5,
    reorgPeriod: chainMetadata.alfajores.blocks!.reorgPeriod!,
    validators: validatorsFn(context, 'alfajores', 3),
  },
  fuji: {
    interval: 5,
    reorgPeriod: chainMetadata.fuji.blocks!.reorgPeriod!,
    validators: validatorsFn(context, 'fuji', 3),
  },
  mumbai: {
    interval: 5,
    reorgPeriod: chainMetadata.mumbai.blocks!.reorgPeriod!,
    validators: validatorsFn(context, 'mumbai', 3),
  },
  bsctestnet: {
    interval: 5,
    reorgPeriod: chainMetadata.bsctestnet.blocks!.reorgPeriod!,
    validators: validatorsFn(context, 'bsctestnet', 3),
  },
  goerli: {
    interval: 5,
    reorgPeriod: chainMetadata.goerli.blocks!.reorgPeriod!,
    validators: validatorsFn(context, 'goerli', 3),
  },
  sepolia: {
    interval: 5,
    reorgPeriod: chainMetadata.sepolia.blocks!.reorgPeriod!,
    validators: validatorsFn(context, 'sepolia', 3),
  },
  moonbasealpha: {
    interval: 5,
    reorgPeriod: chainMetadata.moonbasealpha.blocks!.reorgPeriod!,
    validators: validatorsFn(context, 'moonbasealpha', 3),
  },
  optimismgoerli: {
    interval: 5,
    reorgPeriod: chainMetadata.optimismgoerli.blocks!.reorgPeriod!,
    validators: validatorsFn(context, 'optimismgoerli', 3),
  },
  arbitrumgoerli: {
    interval: 5,
    reorgPeriod: chainMetadata.arbitrumgoerli.blocks!.reorgPeriod!,
    validators: validatorsFn(context, 'arbitrumgoerli', 3),
  },
});

export const validators = validatorsConfigFn(Contexts.Hyperlane);
export const rcValidators = validatorsConfigFn(Contexts.ReleaseCandidate);
