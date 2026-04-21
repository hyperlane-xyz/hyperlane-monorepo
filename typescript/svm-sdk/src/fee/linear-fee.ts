import { FeeType, type LinearFeeConfig } from '@hyperlane-xyz/provider-sdk/fee';

import { SvmLeafFeeReader, SvmLeafFeeWriter } from './leaf-fee.js';
import { FeeStrategyKind } from './types.js';

export class SvmLinearFeeReader extends SvmLeafFeeReader<LinearFeeConfig> {
  protected readonly feeType = FeeType.linear;
  protected readonly strategyKind = FeeStrategyKind.Linear;
}

export class SvmLinearFeeWriter extends SvmLeafFeeWriter<LinearFeeConfig> {
  protected readonly feeType = FeeType.linear;
  protected readonly strategyKind = FeeStrategyKind.Linear;
}
