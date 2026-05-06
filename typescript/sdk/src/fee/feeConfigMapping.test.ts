import {
  FeeParamsType,
  FeeStrategyType,
  FeeType,
} from '@hyperlane-xyz/provider-sdk/fee';
import { expect } from 'chai';

import { tokenFeeInputToFeeConfig } from './feeConfigMapping.js';
import { TokenFeeType, type TokenFeeConfigInput } from './types.js';

const OWNER = '0x0000000000000000000000000000000000000001';
const SIGNER_A = '0x000000000000000000000000000000000000000A';
const SIGNER_B = '0x000000000000000000000000000000000000000B';

describe('tokenFeeInputToFeeConfig', () => {
  it('maps LinearFee with bps', () => {
    const input: TokenFeeConfigInput = {
      type: TokenFeeType.LinearFee,
      owner: OWNER,
      bps: 50,
    };

    expect(tokenFeeInputToFeeConfig(input)).to.deep.equal({
      type: FeeType.linear,
      owner: OWNER,
      beneficiary: OWNER,
      params: { type: FeeParamsType.bps, bps: 50 },
    });
  });

  it('maps ProgressiveFee with raw params', () => {
    const input: TokenFeeConfigInput = {
      type: TokenFeeType.ProgressiveFee,
      owner: OWNER,
      maxFee: 1000n,
      halfAmount: 500n,
    };

    expect(tokenFeeInputToFeeConfig(input)).to.deep.equal({
      type: FeeType.progressive,
      owner: OWNER,
      beneficiary: OWNER,
      params: {
        type: FeeParamsType.raw,
        maxFee: '1000',
        halfAmount: '500',
      },
    });
  });

  it('maps RegressiveFee with raw params', () => {
    const input: TokenFeeConfigInput = {
      type: TokenFeeType.RegressiveFee,
      owner: OWNER,
      maxFee: 2000n,
      halfAmount: 750n,
    };

    expect(tokenFeeInputToFeeConfig(input)).to.deep.equal({
      type: FeeType.regressive,
      owner: OWNER,
      beneficiary: OWNER,
      params: {
        type: FeeParamsType.raw,
        maxFee: '2000',
        halfAmount: '750',
      },
    });
  });

  it('maps OffchainQuotedLinearFee with signers', () => {
    const input: TokenFeeConfigInput = {
      type: TokenFeeType.OffchainQuotedLinearFee,
      owner: OWNER,
      bps: 25,
      quoteSigners: [SIGNER_A, SIGNER_B],
    };

    expect(tokenFeeInputToFeeConfig(input)).to.deep.equal({
      type: FeeType.offchainQuotedLinear,
      owner: OWNER,
      beneficiary: OWNER,
      params: { type: FeeParamsType.bps, bps: 25 },
      quoteSigners: [SIGNER_A, SIGNER_B],
    });
  });

  it('defaults OffchainQuotedLinearFee signers to empty array when undefined', () => {
    const input: TokenFeeConfigInput = {
      type: TokenFeeType.OffchainQuotedLinearFee,
      owner: OWNER,
      bps: 25,
    };

    const result = tokenFeeInputToFeeConfig(input);
    expect(result.type).to.equal(FeeType.offchainQuotedLinear);
    if (result.type === FeeType.offchainQuotedLinear) {
      expect(result.quoteSigners).to.deep.equal([]);
    }
  });

  it('maps RoutingFee over per-destination leaf strategies', () => {
    const input: TokenFeeConfigInput = {
      type: TokenFeeType.RoutingFee,
      owner: OWNER,
      feeContracts: {
        anvil1: { type: TokenFeeType.LinearFee, owner: OWNER, bps: 50 },
        anvil2: {
          type: TokenFeeType.OffchainQuotedLinearFee,
          owner: OWNER,
          bps: 75,
          quoteSigners: [SIGNER_A],
        },
      },
    };

    expect(tokenFeeInputToFeeConfig(input)).to.deep.equal({
      type: FeeType.routing,
      owner: OWNER,
      beneficiary: OWNER,
      routes: {
        anvil1: {
          type: FeeStrategyType.linear,
          params: { type: FeeParamsType.bps, bps: 50 },
        },
        anvil2: {
          type: FeeStrategyType.offchainQuotedLinear,
          params: { type: FeeParamsType.bps, bps: 75 },
          quoteSigners: [SIGNER_A],
        },
      },
    });
  });

  it('maps CrossCollateralRoutingFee over nested per-destination strategies', () => {
    const input: TokenFeeConfigInput = {
      type: TokenFeeType.CrossCollateralRoutingFee,
      owner: OWNER,
      feeContracts: {
        anvil1: {
          [SIGNER_A]: {
            type: TokenFeeType.RegressiveFee,
            owner: OWNER,
            maxFee: 100n,
            halfAmount: 50n,
          },
        },
      },
    };

    expect(tokenFeeInputToFeeConfig(input)).to.deep.equal({
      type: FeeType.crossCollateralRouting,
      owner: OWNER,
      beneficiary: OWNER,
      routes: {
        anvil1: {
          [SIGNER_A]: {
            type: FeeStrategyType.regressive,
            params: {
              type: FeeParamsType.raw,
              maxFee: '100',
              halfAmount: '50',
            },
          },
        },
      },
    });
  });

  it('throws when a routing strategy is nested inside another routing strategy', () => {
    const input: TokenFeeConfigInput = {
      type: TokenFeeType.RoutingFee,
      owner: OWNER,
      feeContracts: {
        anvil1: {
          type: TokenFeeType.RoutingFee,
          owner: OWNER,
          feeContracts: {
            anvil2: { type: TokenFeeType.LinearFee, owner: OWNER, bps: 50 },
          },
        },
      },
    };

    expect(() => tokenFeeInputToFeeConfig(input)).to.throw(
      /Cannot nest RoutingFee inside a routing fee/,
    );
  });
});
