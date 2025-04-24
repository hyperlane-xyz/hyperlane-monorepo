import {
  ChainName,
  ChainSubmissionStrategy,
  TxSubmitterType,
} from '@hyperlane-xyz/sdk';

import {
  CheckpointSyncerType,
  ValidatorBaseConfig,
} from '../../src/config/agent/validator.js';
import { Contexts } from '../contexts.js';

export type ValidatorKey = {
  identifier: string;
  address: string;
};

export const s3BucketRegion = 'us-east-1';

export const s3BucketName = (
  context: Contexts,
  environment: string,
  chainName: ChainName,
  index: number,
) => `${context}-${environment}-${chainName}-validator-${index}`;

/**
 * Creates a validator base config for a single chain
 * @param environment The environment name
 * @param context The context
 * @param chain The chain name
 * @param addresses Validator addresses for the chain
 * @returns Array of ValidatorBaseConfig for the chain
 */
const createChainValidatorBaseConfigs = (
  environment: string,
  context: Contexts,
  chain: ChainName,
  addresses: string[] = [],
): ValidatorBaseConfig[] => {
  return addresses.map((address, index) => {
    const bucketName = s3BucketName(context, environment, chain, index);
    return {
      name: bucketName,
      address,
      checkpointSyncer: {
        type: CheckpointSyncerType.S3,
        bucket: bucketName,
        region: s3BucketRegion,
      },
    };
  });
};

/**
 * Creates validator base configs for a given context and environment
 * @param environment The environment name
 * @param context The context
 * @returns Function to generate ValidatorBaseConfig[] for a specific chain
 */
export const validatorBaseConfigsFn =
  (environment: string, context: Contexts) =>
  (
    addresses: Partial<Record<Contexts, string[]>>,
    chain: ChainName,
  ): ValidatorBaseConfig[] =>
    createChainValidatorBaseConfigs(
      environment,
      context,
      chain,
      addresses[context],
    );

/**
 * Create a GnosisSafeBuilder Strategy for each safe address
 * @param safes Safe addresses for strategy
 * @returns GnosisSafeBuilder Strategy for each safe address
 */
export function getGnosisSafeBuilderStrategyConfigGenerator(
  safes: Record<string, string>,
) {
  return (): ChainSubmissionStrategy => {
    return Object.fromEntries(
      Object.entries(safes).map(([chain, safeAddress]) => [
        chain,
        {
          submitter: {
            type: TxSubmitterType.GNOSIS_TX_BUILDER,
            version: '1.0',
            chain,
            safeAddress,
          },
        },
      ]),
    );
  };
}
