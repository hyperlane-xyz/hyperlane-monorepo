import { expect } from 'vitest';
import { ethers } from 'ethers';

import { ZBps } from '../metadata/customZodTypes.js';

import {
  CrossCollateralRoutingFeeConfigSchema,
  CrossCollateralRoutingFeeInputConfigSchema,
  LinearFeeInputConfigSchema,
  RoutingFeeInputConfigSchema,
  TokenFeeType,
} from './types.js';

const SOME_ADDRESS = ethers.Wallet.createRandom().address;

describe('LinearFeeInputConfigSchema', () => {
  it('should accept config with only bps', () => {
    const config = {
      type: TokenFeeType.LinearFee,
      owner: SOME_ADDRESS,
      bps: 100,
    };
    const result = LinearFeeInputConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
  });

  it('should accept config with only maxFee and halfAmount', () => {
    const config = {
      type: TokenFeeType.LinearFee,
      owner: SOME_ADDRESS,
      maxFee: 10_000n,
      halfAmount: 5_000n,
    };
    const result = LinearFeeInputConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
  });

  it('should reject config with neither bps nor maxFee/halfAmount', () => {
    const config = {
      type: TokenFeeType.LinearFee,
      owner: SOME_ADDRESS,
    };
    const result = LinearFeeInputConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain(
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
    expect(result.success).toBe(false);
  });

  it('should reject config with only halfAmount (missing maxFee)', () => {
    const config = {
      type: TokenFeeType.LinearFee,
      owner: SOME_ADDRESS,
      halfAmount: 5_000n,
    };
    const result = LinearFeeInputConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
  });

  it('should reject halfAmount = 0', () => {
    const config = {
      type: TokenFeeType.LinearFee,
      owner: SOME_ADDRESS,
      maxFee: 10_000n,
      halfAmount: 0n,
    };
    const result = LinearFeeInputConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain(
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
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain('bps must be > 0');
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
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.bps).toBe(100);
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
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.bps).toBeDefined();
      expect(result.data.bps).toBeTypeOf('number');
    }
  });
});

describe('CrossCollateralRoutingFee schemas', () => {
  it('rejects empty routing feeContracts for routing fee input config', () => {
    const result = RoutingFeeInputConfigSchema.safeParse({
      type: TokenFeeType.RoutingFee,
      owner: SOME_ADDRESS,
      feeContracts: {},
    });

    expect(result.success).toBe(false);
  });

  it('rejects empty feeContracts for cross collateral input config', () => {
    const result = CrossCollateralRoutingFeeInputConfigSchema.safeParse({
      type: TokenFeeType.CrossCollateralRoutingFee,
      owner: SOME_ADDRESS,
      feeContracts: {},
    });

    expect(result.success).toBe(false);
  });

  it('rejects empty destination entries for deployed config', () => {
    const result = CrossCollateralRoutingFeeConfigSchema.safeParse({
      type: TokenFeeType.CrossCollateralRoutingFee,
      owner: SOME_ADDRESS,
      feeContracts: {
        ethereum: {},
      },
    });

    expect(result.success).toBe(false);
  });

  it('rejects empty destination entries for input config', () => {
    const result = CrossCollateralRoutingFeeInputConfigSchema.safeParse({
      type: TokenFeeType.CrossCollateralRoutingFee,
      owner: SOME_ADDRESS,
      feeContracts: {
        ethereum: {},
      },
    });

    expect(result.success).toBe(false);
  });
});

describe('LinearFeeInputConfigSchema — fractional bps', () => {
  it('should accept fractional bps like 1.5', () => {
    const result = LinearFeeInputConfigSchema.safeParse({
      type: TokenFeeType.LinearFee,
      owner: SOME_ADDRESS,
      bps: 1.5,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.bps).toBe(1.5);
    }
  });

  it('should accept bps values that are IEEE 754 edge cases (e.g. 0.3)', () => {
    const result = LinearFeeInputConfigSchema.safeParse({
      type: TokenFeeType.LinearFee,
      owner: SOME_ADDRESS,
      bps: 0.3,
    });
    expect(result.success).toBe(true);
  });

  it('should reject bps with more than 4 decimal places', () => {
    const result = LinearFeeInputConfigSchema.safeParse({
      type: TokenFeeType.LinearFee,
      owner: SOME_ADDRESS,
      bps: 0.00001,
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain(
      'at most 4 decimal places',
    );
  });
});

describe('ZBps schema validation', () => {
  it('should reject invalid string inputs', () => {
    expect(ZBps.safeParse('abc').success).toBe(false);
    expect(ZBps.safeParse('').success).toBe(false);
    expect(ZBps.safeParse('Infinity').success).toBe(false);
    expect(ZBps.safeParse('NaN').success).toBe(false);
    expect(ZBps.safeParse('-1').success).toBe(false);
  });

  it('should accept valid inputs and transform to number', () => {
    const r1 = ZBps.safeParse('1.5');
    expect(r1.success).toBe(true);
    if (r1.success) expect(r1.data).toBe(1.5);

    const r2 = ZBps.safeParse('5');
    expect(r2.success).toBe(true);
    if (r2.success) expect(r2.data).toBe(5);

    const r3 = ZBps.safeParse(1.5);
    expect(r3.success).toBe(true);
  });

  it('should reject bigint input (intentional breaking change — use plain number instead)', () => {
    // ZBps intentionally dropped bigint support; callers must use number (e.g., 5 not 5n)
    expect(ZBps.safeParse(5n).success).toBe(false);
    expect(ZBps.safeParse(0n).success).toBe(false);
  });

  it('should reject negative numbers', () => {
    expect(ZBps.safeParse(-5).success).toBe(false);
    expect(ZBps.safeParse(-1.5).success).toBe(false);
    expect(ZBps.safeParse(-0.0001).success).toBe(false);
  });
});
