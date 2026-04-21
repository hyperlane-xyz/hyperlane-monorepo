import {
  FeeType,
  type RegressiveFeeConfig,
} from '@hyperlane-xyz/provider-sdk/fee';

import { SvmLeafFeeReader, SvmLeafFeeWriter } from './leaf-fee.js';
import { FeeStrategyKind } from './types.js';

export class SvmRegressiveFeeReader extends SvmLeafFeeReader<RegressiveFeeConfig> {
  protected readonly feeType = FeeType.regressive;
  protected readonly strategyKind = FeeStrategyKind.Regressive;
}

export class SvmRegressiveFeeWriter extends SvmLeafFeeWriter<RegressiveFeeConfig> {
  protected readonly feeType = FeeType.regressive;
  protected readonly strategyKind = FeeStrategyKind.Regressive;
}
