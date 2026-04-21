import {
  FeeType,
  type ProgressiveFeeConfig,
} from '@hyperlane-xyz/provider-sdk/fee';

import { SvmLeafFeeReader, SvmLeafFeeWriter } from './leaf-fee.js';
import { FeeStrategyKind } from './types.js';

export class SvmProgressiveFeeReader extends SvmLeafFeeReader<ProgressiveFeeConfig> {
  protected readonly feeType = FeeType.progressive;
  protected readonly strategyKind = FeeStrategyKind.Progressive;
}

export class SvmProgressiveFeeWriter extends SvmLeafFeeWriter<ProgressiveFeeConfig> {
  protected readonly feeType = FeeType.progressive;
  protected readonly strategyKind = FeeStrategyKind.Progressive;
}
