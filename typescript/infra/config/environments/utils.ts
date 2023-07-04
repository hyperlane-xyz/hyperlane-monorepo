import { CoreChainName } from '@hyperlane-xyz/sdk';

import {
  CheckpointSyncerType,
  ValidatorBaseConfig,
} from '../../src/config/agent/validator';
import { Contexts } from '../contexts';

export type ValidatorKey = {
  identifier: string;
  address: string;
};

export const s3BucketRegion = 'us-east-1';

export const s3BucketName = (
  context: Contexts,
  environment: string,
  chainName: CoreChainName,
  index: number,
) => `${context}-${environment}-${chainName}-validator-${index}`;

type ContextAddresses = { [context in Contexts]: string[] };

/**
 *
 * @param addresses Validator addresses, provided in order of deployment priority
 * only the first `count` addresses will be used
 * @param context
 * @param environment
 * @param chain
 * @param count Number of validators to use
 * @returns
 */
export const validatorsConfig = (
  addresses: ContextAddresses,
  context: Contexts,
  environment: string,
  chain: CoreChainName,
  count: number,
): Array<ValidatorBaseConfig> => {
  const addressesToUse = addresses[context].slice(0, count);
  return addressesToUse.map((address, index) => {
    const bucketName = s3BucketName(context, environment, chain, index);
    return {
      name: bucketName,
      address,
      checkpointSyncer: {
        type: CheckpointSyncerType.S3,
        bucket: bucketName,
        region: s3BucketRegion,
      },
    } as ValidatorBaseConfig;
  });
};
