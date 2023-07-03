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

// The name of the key generated in helm, without the numeric suffix
// e.g. `rc-testnet3-key-arbitrumgoerli-validator`
const keyName = (
  context: Contexts,
  environment: string,
  chainName: CoreChainName,
) => `${context}-${environment}-key-${chainName}-validator`;

export const validatorsConfig = (
  context: Contexts,
  environment: string,
  chain: CoreChainName,
  keys: Record<string, ValidatorKey[]>,
  count: number = 1,
): Array<ValidatorBaseConfig> => {
  const key = keyName(context, environment, chain);
  const chainKeys = keys[context].filter((v) => v.identifier.includes(key));
  const validatorCount = Math.min(count, chainKeys.length);
  return [...Array(validatorCount).keys()].map((i) => {
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
