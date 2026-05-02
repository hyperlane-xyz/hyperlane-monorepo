import { FeeType, type LinearFeeConfig } from '@hyperlane-xyz/provider-sdk/fee';

import { SvmLeafFeeReader, SvmLeafFeeWriter } from './leaf-fee.js';

export class SvmLinearFeeReader extends SvmLeafFeeReader<LinearFeeConfig> {
  protected readonly feeType = FeeType.linear;
}

export class SvmLinearFeeWriter extends SvmLeafFeeWriter<LinearFeeConfig> {
  protected readonly feeType = FeeType.linear;
}
