import { expect } from 'chai';
import { ethers } from 'ethers';

import { LinearFeeInputConfigSchema, TokenFeeType } from './types.js';

const SOME_ADDRESS = ethers.Wallet.createRandom().address;

describe('LinearFeeInputConfigSchema', () => {
  it('should accept config with only bps', () => {
    const config = {
      type: TokenFeeType.LinearFee,
      owner: SOME_ADDRESS,
      bps: 100n,
    };
    const result = LinearFeeInputConfigSchema.safeParse(config);
    expect(result.success).to.be.true;
  });

  it('should accept config with only maxFee and halfAmount', () => {
    const config = {
      type: TokenFeeType.LinearFee,
      owner: SOME_ADDRESS,
      maxFee: 10_000n,
      halfAmount: 5_000n,
    };
    const result = LinearFeeInputConfigSchema.safeParse(config);
    expect(result.success).to.be.true;
  });

  it('should reject config with neither bps nor maxFee/halfAmount', () => {
    const config = {
      type: TokenFeeType.LinearFee,
      owner: SOME_ADDRESS,
    };
    const result = LinearFeeInputConfigSchema.safeParse(config);
    expect(result.success).to.be.false;
    expect(result.error?.issues[0]?.message).to.include(
      'Provide bps or both maxFee and halfAmount',
    );
  });

  it('should reject config with only maxFee (missing halfAmount)', () => {
    const config = {
      type: TokenFeeType.LinearFee,
      owner: SOME_ADDRESS,
      maxFee: 10_000n,
    };
    const result = LinearFeeInputConfigSchema.safeParse(config);
    expect(result.success).to.be.false;
  });

  it('should reject config with only halfAmount (missing maxFee)', () => {
    const config = {
      type: TokenFeeType.LinearFee,
      owner: SOME_ADDRESS,
      halfAmount: 5_000n,
    };
    const result = LinearFeeInputConfigSchema.safeParse(config);
    expect(result.success).to.be.false;
  });

  it('should reject halfAmount = 0', () => {
    const config = {
      type: TokenFeeType.LinearFee,
      owner: SOME_ADDRESS,
      maxFee: 10_000n,
      halfAmount: 0n,
    };
    const result = LinearFeeInputConfigSchema.safeParse(config);
    expect(result.success).to.be.false;
    expect(result.error?.issues[0]?.message).to.include(
      'halfAmount must be > 0',
    );
  });

  it('should reject bps = 0', () => {
    const config = {
      type: TokenFeeType.LinearFee,
      owner: SOME_ADDRESS,
      bps: 0n,
    };
    const result = LinearFeeInputConfigSchema.safeParse(config);
    expect(result.success).to.be.false;
    expect(result.error?.issues[0]?.message).to.include('bps must be > 0');
  });

  it('should accept config with both bps and maxFee/halfAmount and use explicit bps', () => {
    const config = {
      type: TokenFeeType.LinearFee,
      owner: SOME_ADDRESS,
      bps: 100n,
      maxFee: 10_000n,
      halfAmount: 5_000n,
    };
    const result = LinearFeeInputConfigSchema.safeParse(config);
    expect(result.success).to.be.true;
    if (result.success) {
      expect(result.data.bps).to.equal(100n);
    }
  });

  it('should compute bps from maxFee/halfAmount when only those are provided', () => {
    const maxFee = 10_000n;
    const halfAmount = 5_000n;
    const config = {
      type: TokenFeeType.LinearFee,
      owner: SOME_ADDRESS,
      maxFee,
      halfAmount,
    };
    const result = LinearFeeInputConfigSchema.safeParse(config);
    expect(result.success).to.be.true;
    if (result.success) {
      expect(result.data.bps).to.exist;
      expect(result.data.bps).to.be.a('bigint');
    }
  });
});
