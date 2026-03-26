import { ContractFactory } from 'ethers';

import {
  CrossCollateralRoutingFee__factory,
  LinearFee__factory,
  OffchainQuotedLinearFee__factory,
  ProgressiveFee__factory,
  RegressiveFee__factory,
  RoutingFee__factory,
} from '@hyperlane-xyz/core';

import { TokenFeeType } from './types.js';

export const evmTokenFeeFactories = {
  [TokenFeeType.LinearFee]: new LinearFee__factory(),
  [TokenFeeType.OffchainQuotedLinearFee]:
    new OffchainQuotedLinearFee__factory(),
  [TokenFeeType.ProgressiveFee]: new ProgressiveFee__factory(),
  [TokenFeeType.RegressiveFee]: new RegressiveFee__factory(),
  [TokenFeeType.RoutingFee]: new RoutingFee__factory(),
  [TokenFeeType.CrossCollateralRoutingFee]:
    new CrossCollateralRoutingFee__factory(),
} as const satisfies Record<TokenFeeType, ContractFactory>;

export type EvmTokenFeeFactories = typeof evmTokenFeeFactories;
