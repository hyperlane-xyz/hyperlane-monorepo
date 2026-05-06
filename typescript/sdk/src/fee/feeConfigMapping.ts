import {
  FeeParamsType,
  type FeeConfig,
  type FeeParams,
  type FeeStrategy,
} from '@hyperlane-xyz/provider-sdk/fee';
import { assert, objMap } from '@hyperlane-xyz/utils';

import { TokenFeeType, type TokenFeeConfigInput } from './types.js';

/**
 * Maps an EVM TokenFeeConfigInput to a provider-sdk FeeConfig.
 * Type discriminant strings already match between the two systems.
 * Beneficiary defaults to owner (EVM input doesn't expose it).
 */
export function tokenFeeInputToFeeConfig(
  input: TokenFeeConfigInput,
): FeeConfig {
  const beneficiary = input.owner;

  switch (input.type) {
    case TokenFeeType.LinearFee:
    case TokenFeeType.RegressiveFee:
    case TokenFeeType.ProgressiveFee:
      return {
        type: input.type,
        owner: input.owner,
        beneficiary,
        params: toFeeParams(input),
      };

    case TokenFeeType.OffchainQuotedLinearFee:
      return {
        type: input.type,
        owner: input.owner,
        beneficiary,
        params: toFeeParams(input),
        quoteSigners: input.quoteSigners ?? [],
      };

    case TokenFeeType.RoutingFee:
      return {
        type: input.type,
        owner: input.owner,
        beneficiary,
        routes: objMap(input.feeContracts, (_, nested) =>
          toFeeStrategy(nested),
        ),
      };

    case TokenFeeType.CrossCollateralRoutingFee:
      return {
        type: input.type,
        owner: input.owner,
        beneficiary,
        routes: objMap(input.feeContracts, (_, destConfig) =>
          objMap(destConfig, (__, nested) => toFeeStrategy(nested)),
        ),
      };

    default: {
      const _exhaustive: never = input;
      throw new Error(
        `Unknown fee type config: ${JSON.stringify(_exhaustive)}`,
      );
    }
  }
}

function toFeeStrategy(input: TokenFeeConfigInput): FeeStrategy {
  assert(
    input.type !== TokenFeeType.RoutingFee &&
      input.type !== TokenFeeType.CrossCollateralRoutingFee,
    `Cannot nest ${input.type} inside a routing fee`,
  );

  switch (input.type) {
    case TokenFeeType.LinearFee:
    case TokenFeeType.RegressiveFee:
    case TokenFeeType.ProgressiveFee:
      return {
        type: input.type,
        params: toFeeParams(input),
      };

    case TokenFeeType.OffchainQuotedLinearFee:
      return {
        type: input.type,
        params: toFeeParams(input),
        quoteSigners: input.quoteSigners ?? [],
      };

    default: {
      const _exhaustive: never = input;
      throw new Error(`Unhandled fee strategy: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

function toFeeParams(input: {
  bps?: number;
  maxFee?: bigint;
  halfAmount?: bigint;
}): FeeParams {
  if (input.bps !== undefined) {
    return { type: FeeParamsType.bps, bps: input.bps };
  }

  assert(
    input.maxFee !== undefined && input.halfAmount !== undefined,
    'Expected bps or maxFee/halfAmount',
  );
  return {
    type: FeeParamsType.raw,
    maxFee: input.maxFee.toString(),
    halfAmount: input.halfAmount.toString(),
  };
}
