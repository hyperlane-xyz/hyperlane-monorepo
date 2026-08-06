import { expect } from 'chai';

import {
  FeeParamsType,
  FeeStrategyType,
} from '@hyperlane-xyz/provider-sdk/fee';

import {
  feeStrategiesEqual,
  resolveRawFeeParams,
} from '../fee/fee-strategy-utils.js';
import { signerToH160 } from '../fee/types.js';

describe('SVM fee utils', () => {
  it('rejects invalid H160 signer hex', () => {
    expect(() =>
      signerToH160('0xzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz'),
    ).to.throw(/Expected 40 hex chars/);
  });

  it('rejects invalid bps values like EVM fee conversion', () => {
    for (const bps of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 0.00001]) {
      expect(() =>
        resolveRawFeeParams({ type: FeeParamsType.bps, bps }),
      ).to.throw(/bps/);
    }
  });

  it('compares raw and bps-equivalent fee strategies', () => {
    const bpsParams = { type: FeeParamsType.bps, bps: 100 };
    const rawParams = resolveRawFeeParams(bpsParams);

    expect(
      feeStrategiesEqual(
        { type: FeeStrategyType.linear, params: bpsParams },
        {
          type: FeeStrategyType.linear,
          params: {
            type: FeeParamsType.raw,
            maxFee: rawParams.maxFee.toString(),
            halfAmount: rawParams.halfAmount.toString(),
          },
        },
      ),
    ).to.equal(true);
  });
});
