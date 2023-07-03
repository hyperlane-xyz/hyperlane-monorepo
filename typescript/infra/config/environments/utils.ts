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

export const validatorsConfig = (
  context: Contexts,
  environment: string,
  chain: CoreChainName,
  keys: ValidatorKey[],
): Array<ValidatorBaseConfig> => {
  const chainKeys = keys.filter((v) => v.identifier.includes(chain));
  return new Array(chainKeys.length).map((_, i) => {
    const bucketName = s3BucketName(context, environment, chain, i);
    const key = chainKeys.find((v) => v.identifier.endsWith(`${i}`));
    return {
      name: bucketName,
      address: key!.address,
      checkpointSyncer: {
        type: CheckpointSyncerType.S3,
        bucket: bucketName,
        region: s3BucketRegion,
      },
    } as ValidatorBaseConfig;
  });
};
