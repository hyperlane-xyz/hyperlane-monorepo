import { expect } from 'chai';
import { ethers } from 'ethers';

import { ZBps } from '../metadata/customZodTypes.js';

import { LinearFeeInputConfigSchema, TokenFeeType } from './types.js';

const SOME_ADDRESS = ethers.Wallet.createRandom().address;

describe('LinearFeeInputConfigSchema', () => {
  it('should accept config with only bps', () => {
    const config = {
      type: TokenFeeType.LinearFee,
      owner: SOME_ADDRESS,
      bps: 100,
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
      bps: 0,
    };
    const result = LinearFeeInputConfigSchema.safeParse(config);
    expect(result.success).to.be.false;
    expect(result.error?.issues[0]?.message).to.include('bps must be > 0');
  });

  it('should accept config with both bps and maxFee/halfAmount and use explicit bps', () => {
    const config = {
      type: TokenFeeType.LinearFee,
      owner: SOME_ADDRESS,
      bps: 100,
      maxFee: 10_000n,
      halfAmount: 5_000n,
    };
    const result = LinearFeeInputConfigSchema.safeParse(config);
    expect(result.success).to.be.true;
    if (result.success) {
      expect(result.data.bps).to.equal(100);
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
      expect(result.data.bps).to.be.a('number');
    }
  });
});

describe('LinearFeeInputConfigSchema — fractional bps', () => {
  it('should accept fractional bps like 1.5', () => {
    const result = LinearFeeInputConfigSchema.safeParse({
      type: TokenFeeType.LinearFee,
      owner: SOME_ADDRESS,
      bps: 1.5,
    });
    expect(result.success).to.be.true;
    if (result.success) {
      expect(result.data.bps).to.equal(1.5);
    }
  });

  it('should accept bps values that are IEEE 754 edge cases (e.g. 0.3)', () => {
    const result = LinearFeeInputConfigSchema.safeParse({
      type: TokenFeeType.LinearFee,
      owner: SOME_ADDRESS,
      bps: 0.3,
    });
    expect(result.success).to.be.true;
  });

  it('should reject bps with more than 4 decimal places', () => {
    const result = LinearFeeInputConfigSchema.safeParse({
      type: TokenFeeType.LinearFee,
      owner: SOME_ADDRESS,
      bps: 0.00001,
    });
    expect(result.success).to.be.false;
    expect(result.error?.issues[0]?.message).to.include(
      'at most 4 decimal places',
    );
  });
});

describe('ZBps schema validation', () => {
  it('should reject invalid string inputs', () => {
    expect(ZBps.safeParse('abc').success).to.be.false;
    expect(ZBps.safeParse('').success).to.be.false;
    expect(ZBps.safeParse('Infinity').success).to.be.false;
    expect(ZBps.safeParse('NaN').success).to.be.false;
    expect(ZBps.safeParse('-1').success).to.be.false;
  });

  it('should accept valid inputs and transform to number', () => {
    const r1 = ZBps.safeParse('1.5');
    expect(r1.success).to.be.true;
    if (r1.success) expect(r1.data).to.equal(1.5);

    const r2 = ZBps.safeParse('5');
    expect(r2.success).to.be.true;
    if (r2.success) expect(r2.data).to.equal(5);

    const r3 = ZBps.safeParse(1.5);
    expect(r3.success).to.be.true;
  });

  it('should reject bigint input (intentional breaking change — use plain number instead)', () => {
    // ZBps intentionally dropped bigint support; callers must use number (e.g., 5 not 5n)
    expect(ZBps.safeParse(5n).success).to.be.false;
    expect(ZBps.safeParse(0n).success).to.be.false;
  });

  it('should reject negative numbers', () => {
    expect(ZBps.safeParse(-5).success).to.be.false;
    expect(ZBps.safeParse(-1.5).success).to.be.false;
    expect(ZBps.safeParse(-0.0001).success).to.be.false;
  });
});
