import { z } from 'zod';

import { assert, eqAddress, objMap } from '@hyperlane-xyz/utils';

import { ZChainName } from '../../../../metadata/customZodTypes.js';
import { ChainMap, ChainName } from '../../../../types.js';
import { TxSubmitterType } from '../TxSubmitterTypes.js';
import { EvmIcaTxSubmitterProps } from '../ethersV5/types.js';
import { SubmitterMetadataSchema } from '../types.js';

export const SubmissionStrategySchema = z
  .object({
    submitter: SubmitterMetadataSchema,
  })
  .strict();

export type SubmissionStrategy = z.infer<typeof SubmissionStrategySchema>;

export const ChainSubmissionStrategySchema = z.preprocess(
  // Add the chain property to the internal submitter config before validation
  // to avoid having to set the field manually when writing the config
  (value: unknown): ChainMap<SubmissionStrategy> => {
    const castedValued = value as ChainMap<SubmissionStrategy>;

    const parsedValue = objMap(
      castedValued,
      (chainName, strategy): SubmissionStrategy => {
        if (strategy.submitter.type === TxSubmitterType.INTERCHAIN_ACCOUNT) {
          return formatIcaSubmitter(chainName, strategy);
        } else if (
          strategy.submitter.type === TxSubmitterType.TIMELOCK_CONTROLLER
        ) {
          return formatTimelockSubmitter(chainName, strategy);
        }

        return strategy;
      },
    );

    return parsedValue;
  },
  z.record(ZChainName, SubmissionStrategySchema).superRefine((value, ctx) => {
    Object.entries(value).forEach(([chain, config]) => {
      if (config.submitter.type !== TxSubmitterType.INTERCHAIN_ACCOUNT) {
        return;
      }

      const { owner, internalSubmitter } = config.submitter;
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
  }),
);

const formatIcaSubmitter = (
  chainName: ChainName,
  strategy: SubmissionStrategy,
): SubmissionStrategy => {
  assert(strategy.submitter.type === TxSubmitterType.INTERCHAIN_ACCOUNT, '');

  // Setting the default internal submitter config for interchain accounts here
  // instead of using zod's default() modifier because we require the chain property to be set
  const {
    internalSubmitter = {
      type: TxSubmitterType.JSON_RPC,
      chain: strategy.submitter.chain,
    },
    destinationChain,
  } = strategy.submitter;
  const formattedInternalSubmitter: EvmIcaTxSubmitterProps['internalSubmitter'] =
    {
      ...internalSubmitter,
      chain: strategy.submitter.chain,
    };

  // When the internal submitter of the interchain account is a Multisig, the owner address and the multisig address need to match
  if (
    formattedInternalSubmitter.type === TxSubmitterType.GNOSIS_SAFE ||
    formattedInternalSubmitter.type === TxSubmitterType.GNOSIS_TX_BUILDER
  ) {
    strategy.submitter.owner =
      strategy.submitter.owner ?? formattedInternalSubmitter.safeAddress;
  }

  return {
    ...strategy,
    submitter: {
      ...strategy.submitter,
      // Setting the destinationChain here so that it can be omitted in the input config
      // as its value should be the same as the key value in the mapping
      destinationChain: destinationChain ?? chainName,
      internalSubmitter: formattedInternalSubmitter,
    },
  };
};

const formatTimelockSubmitter = (
  chainName: ChainName,
  strategy: SubmissionStrategy,
): SubmissionStrategy => {
  assert(strategy.submitter.type === TxSubmitterType.TIMELOCK_CONTROLLER, '');

  const {
    proposerSubmitter = { type: TxSubmitterType.JSON_RPC, chain: chainName },
  } = strategy.submitter;

  return {
    ...strategy,
    submitter: {
      ...strategy.submitter,
      proposerSubmitter: {
        ...proposerSubmitter,
        chain: chainName,
      },
    },
  };
};

export type ChainSubmissionStrategy = z.infer<
  typeof ChainSubmissionStrategySchema
>;
