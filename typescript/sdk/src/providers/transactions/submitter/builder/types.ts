import { z } from 'zod';

import { assert, eqAddress, objMap } from '@hyperlane-xyz/utils';

import { ZChainName } from '../../../../metadata/customZodTypes.js';
import { ChainMap, ChainName } from '../../../../types.js';
import { TxSubmitterType } from '../TxSubmitterTypes.js';
import { EvmIcaTxSubmitterProps } from '../ethersV5/types.js';
import { SubmitterMetadata, SubmitterMetadataSchema } from '../types.js';

export const SubmissionStrategySchema = z
  .object({
    submitter: SubmitterMetadataSchema,
  })
  .strict();

export type SubmissionStrategy = z.infer<typeof SubmissionStrategySchema>;

export function preprocessChainSubmissionStrategy<
  T extends { submitter: { type: string } },
>(value: unknown): ChainMap<T> {
  const castedValued = value as ChainMap<SubmissionStrategy>;

  const parsedValue = objMap(
    castedValued,
    (chainName, strategy): SubmissionStrategy => {
      return {
        submitter: preprocessSubmissionStrategy(chainName, strategy.submitter),
      };
    },
  );

  return parsedValue as ChainMap<T>;
}

export function refineChainSubmissionStrategy<
  T extends { submitter: { type: string } },
>(value: Record<string, T>, ctx: z.RefinementCtx) {
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

function preprocessSubmissionStrategy(
  chainName: ChainName,
  strategy: SubmitterMetadata,
): SubmitterMetadata {
  if (strategy.type === TxSubmitterType.INTERCHAIN_ACCOUNT) {
    return preprocessIcaSubmitter(chainName, strategy);
  } else if (strategy.type === TxSubmitterType.TIMELOCK_CONTROLLER) {
    return preprocessTimelockSubmitter(chainName, strategy);
  }

  return {
    ...strategy,
    // If the chain was not set use the current key to set it
    // to avoid having to set it again in the source config
    chain: strategy.chain ?? chainName,
  };
}

const preprocessIcaSubmitter = (
  chainName: ChainName,
  strategy: Extract<
    SubmitterMetadata,
    { type: TxSubmitterType.INTERCHAIN_ACCOUNT }
  >,
): SubmitterMetadata => {
  assert(
    strategy.type === TxSubmitterType.INTERCHAIN_ACCOUNT,
    `[ChainSubmissionStrategy] Expected ${TxSubmitterType.INTERCHAIN_ACCOUNT} strategy but got ${strategy.type}`,
  );

  // Setting the default internal submitter config for interchain accounts here
  // instead of using zod's default() modifier because we require the chain property to be set
  const {
    internalSubmitter = {
      type: TxSubmitterType.JSON_RPC,
      chain: strategy.chain,
    },
    destinationChain,
  } = strategy;
  const formattedInternalSubmitter: EvmIcaTxSubmitterProps['internalSubmitter'] =
    {
      ...internalSubmitter,
      chain: internalSubmitter.chain ?? strategy.chain,
    };

  // When the internal submitter of the interchain account is a Multisig, the owner address and the multisig address need to match
  if (
    formattedInternalSubmitter.type === TxSubmitterType.GNOSIS_SAFE ||
    formattedInternalSubmitter.type === TxSubmitterType.GNOSIS_TX_BUILDER
  ) {
    strategy.owner = strategy.owner ?? formattedInternalSubmitter.safeAddress;
  }

  return {
    ...strategy,
    // Setting the destinationChain here so that it can be omitted in the input config
    // as its value should be the same as the key value in the mapping
    destinationChain: destinationChain ?? chainName,
    internalSubmitter: preprocessSubmissionStrategy(
      // Here the chain changes to the one of the ICA because transactions
      // are sent to the destination chain from another one
      strategy.chain,
      formattedInternalSubmitter,
    ),
  };
};

const preprocessTimelockSubmitter = (
  chainName: ChainName,
  strategy: SubmitterMetadata,
): SubmitterMetadata => {
  assert(
    strategy.type === TxSubmitterType.TIMELOCK_CONTROLLER,
    `[ChainSubmissionStrategy] Expected ${TxSubmitterType.TIMELOCK_CONTROLLER} strategy but got ${strategy.type}`,
  );

  const {
    proposerSubmitter = { type: TxSubmitterType.JSON_RPC, chain: chainName },
  } = strategy;

  const formattedProposerSubmitter = {
    ...proposerSubmitter,
    // Override the chain if it hasn't been set
    chain: proposerSubmitter.chain ?? chainName,
  };

  return {
    ...strategy,
    chain: strategy.chain ?? chainName,
    proposerSubmitter: preprocessSubmissionStrategy(
      chainName,
      formattedProposerSubmitter,
    ),
  };
};

export type ChainSubmissionStrategy = z.infer<
  typeof ChainSubmissionStrategySchema
>;
