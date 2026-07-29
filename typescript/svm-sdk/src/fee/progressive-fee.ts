import {
  FeeType,
  type ProgressiveFeeConfig,
} from '@hyperlane-xyz/provider-sdk/fee';

import { SvmLeafFeeReader, SvmLeafFeeWriter } from './leaf-fee.js';

export class SvmProgressiveFeeReader extends SvmLeafFeeReader<ProgressiveFeeConfig> {
  protected readonly feeType = FeeType.progressive;
}

export class SvmProgressiveFeeWriter extends SvmLeafFeeWriter<ProgressiveFeeConfig> {
  protected readonly feeType = FeeType.progressive;
}
