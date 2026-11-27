import { z } from 'zod';

import { assert, eqAddress, isNullish, objMap } from '@hyperlane-xyz/utils';

import { ZChainName } from '../../../../metadata/customZodTypes.js';
import { ChainMap, ChainName } from '../../../../types.js';
import { TxSubmitterType } from '../TxSubmitterTypes.js';
import { EvmIcaTxSubmitterProps } from '../ethersV5/types.js';
import { SubmitterMetadata, SubmitterMetadataSchema } from '../types.js';

export const SubmissionStrategySchema = z.strictObject({
  submitter: SubmitterMetadataSchema,
});

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
    refineSubmitter(config.submitter, chain, ctx);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' && !isNullish(value) && !Array.isArray(value)
  );
}

function getStaticProposerAddress(
  proposer: Record<string, unknown>,
): { kind: string; address: string } | undefined {
  const { type, safeAddress, timelockAddress, userAddress } = proposer;
  if (
    (type === TxSubmitterType.GNOSIS_SAFE ||
      type === TxSubmitterType.GNOSIS_TX_BUILDER) &&
    typeof safeAddress === 'string'
  ) {
    return { kind: 'multisig', address: safeAddress };
  }
  if (
    type === TxSubmitterType.TIMELOCK_CONTROLLER &&
    typeof timelockAddress === 'string'
  ) {
    return { kind: 'timelock', address: timelockAddress };
  }
  if (type === TxSubmitterType.JSON_RPC && typeof userAddress === 'string') {
    return { kind: 'jsonRpc user', address: userAddress };
  }
  return undefined;
}

function refineInterchainAccount(
  submitter: Record<string, unknown>,
  chain: ChainName,
  ctx: z.RefinementCtx,
): void {
  const { owner, refundAddress, internalSubmitter } = submitter;
  if (typeof owner !== 'string' || !isRecord(internalSubmitter)) {
    return;
  }

  const { type, safeAddress, accessManagerAddress } = internalSubmitter;
  if (
    (type === TxSubmitterType.GNOSIS_SAFE ||
      type === TxSubmitterType.GNOSIS_TX_BUILDER) &&
    typeof safeAddress === 'string' &&
    !eqAddress(owner, safeAddress)
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Interchain account owner address and multisig address must match for ${chain}`,
    });
  }

  if (
    type !== TxSubmitterType.ACCESS_MANAGER ||
    typeof accessManagerAddress !== 'string'
  ) {
    return;
  }

  if (!eqAddress(owner, accessManagerAddress)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Interchain account owner address and AccessManager address must match for ${chain}`,
    });
  }

  // The AccessManager cannot receive native tokens, so gas payment refunds
  // to it would revert the scheduled callRemote on execution.
  if (
    typeof refundAddress !== 'string' ||
    eqAddress(refundAddress, accessManagerAddress)
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Interchain account refundAddress must be set to an address other than the AccessManager for ${chain}`,
    });
  }
}

// Reads nested submitters defensively as the CLI extends the strategy schema
// with its own submitter types (e.g. `file`).
function refineSubmitter(
  submitter: unknown,
  chain: ChainName,
  ctx: z.RefinementCtx,
): void {
  if (!isRecord(submitter)) {
    return;
  }

  if (submitter.type === TxSubmitterType.INTERCHAIN_ACCOUNT) {
    refineSubmitter(submitter.internalSubmitter, chain, ctx);
    refineInterchainAccount(submitter, chain, ctx);
    return;
  }

  if (submitter.type === TxSubmitterType.TIMELOCK_CONTROLLER) {
    refineSubmitter(submitter.proposerSubmitter, chain, ctx);
    return;
  }

  if (submitter.type !== TxSubmitterType.ACCESS_MANAGER) {
    return;
  }

  const { caller, proposerSubmitter } = submitter;
  if (typeof caller === 'string' && isRecord(proposerSubmitter)) {
    const proposer = getStaticProposerAddress(proposerSubmitter);
    if (proposer && !eqAddress(caller, proposer.address)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `AccessManager caller ${caller} must match the ${proposer.kind} address ${proposer.address} for ${chain}`,
      });
    }
  }

  refineSubmitter(proposerSubmitter, chain, ctx);
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
  } else if (strategy.type === TxSubmitterType.ACCESS_MANAGER) {
    return preprocessAccessManagerSubmitter(chainName, strategy);
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
  } else if (
    formattedInternalSubmitter.type === TxSubmitterType.ACCESS_MANAGER
  ) {
    strategy.owner =
      strategy.owner ?? formattedInternalSubmitter.accessManagerAddress;
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

const preprocessAccessManagerSubmitter = (
  chainName: ChainName,
  strategy: Extract<
    SubmitterMetadata,
    { type: TxSubmitterType.ACCESS_MANAGER }
  >,
): SubmitterMetadata => {
  const chain = strategy.chain ?? chainName;
  const { proposerSubmitter = { type: TxSubmitterType.JSON_RPC, chain } } =
    strategy;

  return {
    type: strategy.type,
    chain,
    accessManagerAddress: strategy.accessManagerAddress,
    caller: strategy.caller,
    // Recursing with the AccessManager chain defaults the proposer's `chain`,
    // or the `destinationChain` of an interchain account proposer whose `chain`
    // is its origin.
    proposerSubmitter: preprocessSubmissionStrategy(chain, proposerSubmitter),
  };
};

export type ChainSubmissionStrategy = z.infer<
  typeof ChainSubmissionStrategySchema
>;
