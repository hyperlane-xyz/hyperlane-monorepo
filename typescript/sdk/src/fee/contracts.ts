import {
  LinearFee__factory,
  ProgressiveFee__factory,
  RegressiveFee__factory,
  RoutingFee__factory,
} from '@hyperlane-xyz/core';

export const evmTokenFeeFactories = {
  LinearFee: new LinearFee__factory(),
  ProgressiveFee: new ProgressiveFee__factory(),
  RegressiveFee: new RegressiveFee__factory(),
  RoutingFee: new RoutingFee__factory(),
} as const;

export type EvmTokenFeeFactories = typeof evmTokenFeeFactories;
