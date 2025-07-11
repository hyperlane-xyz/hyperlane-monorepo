import { z } from 'zod';

import { eqAddress, objMap } from '@hyperlane-xyz/utils';

import { ZChainName } from '../../../../metadata/customZodTypes.js';
import { ChainMap } from '../../../../types.js';
import { TxSubmitterType } from '../TxSubmitterTypes.js';
import { EvmIcaTxSubmitterProps, SubmitterMetadataSchema } from '../types.js';

export const SubmissionStrategySchema = z
  .object({
    submitter: SubmitterMetadataSchema,
  })
  .strict();

export type SubmissionStrategy = z.infer<typeof SubmissionStrategySchema>;

export function preprocessChainSubmissionStrategy<T extends { submitter: any }>(
  value: unknown,
): ChainMap<T> {
  // Add the chain property to the internal submitter config before validation
  // to avoid having to set the field manually when writing the config
  const castedValued = value as ChainMap<T>;

  const parsedValue = objMap(castedValued, (chainName, strategy): T => {
    if (strategy.submitter.type !== TxSubmitterType.INTERCHAIN_ACCOUNT) {
      return strategy;
    }

    // The strategy.submitter is cast to the specific ICA type to allow for
    // access to ICA-specific properties.
    const submitter = strategy.submitter as EvmIcaTxSubmitterProps;

    // Setting the default internal submitter config for interchain accounts here
    // instead of using zod's default() modifier because we require the chain property to be set
    const {
      internalSubmitter = {
        type: TxSubmitterType.JSON_RPC,
        chain: submitter.chain,
      },
      destinationChain,
    } = submitter;
    const formattedInternalSubmitter: EvmIcaTxSubmitterProps['internalSubmitter'] =
      {
        ...internalSubmitter,
        chain: submitter.chain,
      };

    let owner = submitter.owner;
    // When the internal submitter of the interchain account is a Multisig, the owner address and the multisig address need to match
    if (
      formattedInternalSubmitter.type === TxSubmitterType.GNOSIS_SAFE ||
      formattedInternalSubmitter.type === TxSubmitterType.GNOSIS_TX_BUILDER
    ) {
      owner = submitter.owner ?? formattedInternalSubmitter.safeAddress;
    }

    return {
      ...strategy,
      submitter: {
        ...submitter,
        owner,
        // Setting the destinationChain here so that it can be omitted in the input config
        // as its value should be the same as the key value in the mapping
        destinationChain: destinationChain ?? chainName,
        internalSubmitter: formattedInternalSubmitter,
      },
    };
  });

  return parsedValue;
}
export function refineChainSubmissionStrategy<T extends { submitter: any }>(
  value: Record<string, T>,
  ctx: z.RefinementCtx,
) {
  Object.entries(value).forEach(([chain, config]) => {
    if (config.submitter.type !== TxSubmitterType.INTERCHAIN_ACCOUNT) {
      return;
    }

    const submitter = config.submitter as EvmIcaTxSubmitterProps;
    const { owner, internalSubmitter } = submitter;
    if (
      (internalSubmitter.type === TxSubmitterType.GNOSIS_SAFE ||
        internalSubmitter.type === TxSubmitterType.GNOSIS_TX_BUILDER) &&
      !eqAddress(owner, internalSubmitter.safeAddress)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Interchain account owner address and multisig address must match for ${chain}`,
      });
    }
  });
}

export const ChainSubmissionStrategySchema = z.preprocess(
  preprocessChainSubmissionStrategy,
  z
    .record(ZChainName, SubmissionStrategySchema)
    .superRefine(refineChainSubmissionStrategy),
);

export type ChainSubmissionStrategy = z.infer<
  typeof ChainSubmissionStrategySchema
>;
